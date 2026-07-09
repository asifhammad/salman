'use strict';

// ──────────────────────────────────────────────────────
// SSEXCH247 Risk Analysis Poller & Telegram Alerts
// ──────────────────────────────────────────────────────
//
// Architecture:
//   Module A (auth.js)    → Playwright headless login + reCAPTCHA
//   Module B (poller.js)  → Cron-driven Risk Analysis API polling
//   Module C (db.js)      → SQLite dedup / diff engine
//   Module D (notifier.js)→ Telegram Bot API (HTTP POST)
//
// Flow:
//   1. Load .env
//   2. Bootstrap auth (cached or Playwright login)
//   3. Start health-check HTTP server (optional)
//   4. Run an immediate poll cycle
//   5. Schedule recurring polls via node-cron
//   6. Graceful shutdown
// ──────────────────────────────────────────────────────

require('dotenv').config();

const http = require('http');
const cron = require('node-cron');
const { bootstrapAuth, executePollCycle, POLL_INTERVAL_SECONDS } = require('./poller');
const { initDatabase, getProcessedCount, closeDatabase } = require('./db');

// ── Banner ─────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════╗');
console.log('║  🔍 SSEXCH247 Risk Analysis — Telegram Bot  ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');console.log('[main] 🚀 Starting on ' + (process.env.RAILWAY_SERVICE_NAME || 'localhost') + '…');
// ── Validate critical env vars ─────────────────────────
const TG_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const WA_NUMS = (process.env.WHATSAPP_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!process.env.USERNAME || !process.env.PASSWORD) {
  console.error('❌ USERNAME and PASSWORD are required in .env');
  process.exit(1);
}

const tgOk = !!process.env.TELEGRAM_BOT_TOKEN && TG_IDS.length > 0;
const waOk = !!process.env.WHATSAPP_WEBHOOK_URL && WA_NUMS.length > 0;

if (!tgOk && !waOk) {
  console.warn('⚠️  No notification channel configured.');
  console.warn('   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS');
  console.warn('   WhatsApp: WHATSAPP_WEBHOOK_URL + WHATSAPP_RECIPIENTS');
  console.warn('');
} else {
  if (tgOk) console.log('[main] 📬 Telegram: ' + TG_IDS.length + ' chat(s)');
  if (waOk) console.log('[main] 📱 WhatsApp: ' + WA_NUMS.length + ' number(s)');
  console.log('');
}

// ── Health-check HTTP server (for Railway deployment) ──
const HEALTH_PORT = Number(process.env.HEALTH_CHECK_PORT || process.env.PORT) || 0;
let healthServer = null;
let lastPollTime = null;
let lastPollStatus = 'pending';

if (HEALTH_PORT > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const dbCount = getProcessedCount();
      const status = {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        lastPoll: lastPollTime,
        lastPollStatus,
        dbProcessedCount: dbCount,
        recipients: CHAT_IDS.length,
        endpoint: process.env.POLL_ENDPOINT || 'MSACurrentWorkingMarketList',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  healthServer.listen(HEALTH_PORT, () => {
    console.log('[health] 🏥 Health check server on port ' + HEALTH_PORT);
  });
}

// ── Main startup ───────────────────────────────────────
async function main() {
  // 1. Initialize database
  initDatabase();
  const existingCount = getProcessedCount();
  console.log('[main] 📊 Database: ' + existingCount + ' processed item(s).');

  const pollEndpoint = process.env.POLL_ENDPOINT || 'MSACurrentWorkingMarketList';
  console.log('[main] 🎯 Endpoint: ' + pollEndpoint);
  console.log('[main] 🌐 API: ' + (process.env.API_BASE || 'https://newadmin.ssexch247.net/api'));

  if (TG_IDS.length > 0 || WA_NUMS.length > 0) {
    const parts = [];
    if (TG_IDS.length > 0) parts.push('TG: ' + TG_IDS.length);
    if (WA_NUMS.length > 0) parts.push('WA: ' + WA_NUMS.length);
    console.log('[main] 📬 ' + parts.join(' | '));
  }
  console.log('');

  // 2. Bootstrap authentication
  console.log('[main] 🔐 Bootstrapping auth…');
  const authOk = await bootstrapAuth();
  if (!authOk) {
    console.error('[main] ❌ Cannot start — authentication failed.');
    process.exit(1);
  }

  // 3. Run an immediate poll cycle
  console.log('[main] ⚡ Running initial Risk Analysis poll…');
  try {
    const result = await executePollCycle();
    lastPollTime = new Date().toISOString();
    lastPollStatus = result.success ? 'ok' : 'error';
  } catch (err) {
    lastPollStatus = 'error';
    console.error('[main] ⚠️  Initial poll error:', err.message);
  }

  // 4. Schedule recurring polls
  const cronExpression =
    POLL_INTERVAL_SECONDS < 60
      ? '*/' + POLL_INTERVAL_SECONDS + ' * * * * *'
      : '*/' + Math.floor(POLL_INTERVAL_SECONDS / 60) + ' * * * *';

  console.log('[main] ⏱️  Polling every ' + POLL_INTERVAL_SECONDS +
    's (cron: "' + cronExpression + '")');

  let pollInProgress = false;

  const job = cron.schedule(cronExpression, async () => {
    if (pollInProgress) {
      console.log('[main] ⏭️  Previous poll still in progress — skipping.');
      return;
    }

    pollInProgress = true;
    try {
      const result = await executePollCycle();
      lastPollTime = new Date().toISOString();
      lastPollStatus = result.success ? 'ok' : 'error';
    } catch (err) {
      lastPollStatus = 'error';
      console.error('[main] ❌ Poll cycle error:', err.message);
    } finally {
      pollInProgress = false;
    }
  });

  console.log('[main] ✅ Engine started. Press Ctrl+C to stop.\n');

  // 5. Graceful shutdown
  const shutdown = (signal) => {
    console.log('\n[main] 🛑 ' + signal + ' — shutting down…');
    job.stop();
    if (healthServer) healthServer.close();
    closeDatabase();
    console.log('[main] 👋 Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[main] 🔥 Unhandled rejection:', reason);
  });
}

main().catch(err => {
  console.error('[main] 💥 Fatal startup error:', err);
  process.exit(1);
});
