'use strict';

// ──────────────────────────────────────────────────────
// Notification Gateway — Telegram + WhatsApp
// ──────────────────────────────────────────────────────
// Sends alerts via Telegram Bot AND WhatsApp webhook
// simultaneously. Configure one or both in .env.
// ──────────────────────────────────────────────────────

const axios = require('axios');

// ── Telegram ───────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TG_API = TG_TOKEN ? 'https://api.telegram.org/bot' + TG_TOKEN : '';

// ── WhatsApp (Whapi.cloud) ──────────────────────────────
const WA_URL = process.env.WHATSAPP_WEBHOOK_URL || '';
const WA_TOKEN = process.env.WHAPI_TOKEN || '';
const WA_NUMS = (process.env.WHATSAPP_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
const WA_GROUP = process.env.WHATSAPP_GROUP_ID || '';  // e.g. 123456789@g.us

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Message Formatters ─────────────────────────────────

function formatRiskAlert(item) {
  const sport = detectSport(item);
  const event = item.eventName || 'Unknown Event';
  const market = item.marketName || 'Unknown Market';
  const bets = item.totalBets ?? '?';
  const clients = item.totalClients ?? '?';
  const position = formatNumber(item.position);
  const liability = formatNumber(item.liability);
  const inPlay = item.isInPlay ? '🔴 LIVE' : '🟢 Upcoming';
  const TZ = process.env.TZ || 'Asia/Karachi';
  const time = item.marketStartTime
    ? new Date(item.marketStartTime).toLocaleString('en-PK', { timeZone: TZ, hour12: true, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'N/A';

  // Telegram uses HTML, WhatsApp uses plain text with *bold*
  return {
    tg: [
      '⚠️ <b>Risk Alert — ' + sport + '</b>',
      '',
      '🏟 <b>' + event + '</b>',
      '📊 ' + market,
      '',
      '👥 Clients: ' + clients + '  |  🎯 Bets: ' + bets,
      '💰 Position: ' + position + '  |  📉 Liability: ' + liability,
      '📅 Market: ' + time + '  |  ' + inPlay,
      '',
      '🔗 <code>' + (item.marketID || 'N/A') + '</code>',
    ].join('\n'),
    wa: [
      '⚠️ *Risk Alert — ' + sport + '*',
      '',
      '🏟 *' + event + '*',
      '📊 ' + market,
      '',
      '👥 Clients: ' + clients + '  |  🎯 Bets: ' + bets,
      '💰 Position: ' + position + '  |  📉 Liability: ' + liability,
      '📅 Market: ' + time + '  |  ' + inPlay,
    ].join('\n'),
  };
}

/**
 * Format an individual bet alert (from MSACurrentMarketBets).
 * Shows: Client, Runner, Side, Stake, Price, Bet ID, Event, Market, Time
 */
function formatBetAlert(item) {
  const TZ = process.env.TZ || 'Asia/Karachi';
  const userName = item.userName || 'Unknown';
  const runner = item.runnerName || 'Unknown';
  const side = (item.side || '').toUpperCase() === 'LAY' ? '📉 LAY' : '📈 BACK';
  const price = item.orderPrice ? Number(item.orderPrice).toFixed(2) : '?';
  const stake = formatNumber(item.orderSize);
  const betID = item.betID || '?';
  const event = item.eventName || 'Unknown Event';
  const market = item.marketName || 'Unknown Market';
  const placedTime = item.placedDate
    ? new Date(item.placedDate).toLocaleString('en-PK', { timeZone: TZ, hour12: true, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'N/A';

  return {
    tg: [
      '🎯 <b>New Bet — ' + event + '</b>',
      '',
      '👤 <b>' + userName + '</b>  |  ' + side,
      '🏃 Runner: <b>' + runner + '</b>',
      '💰 Stake: <b>' + stake + '</b> @ ' + price,
      '🆔 Bet ID: <code>' + betID + '</code>',
      '📊 ' + market + '  |  🕐 ' + placedTime,
    ].join('\n'),
    wa: [
      '🎯 *New Bet — ' + event + '*',
      '',
      '👤 *' + userName + '*  |  ' + side,
      '🏃 Runner: *' + runner + '*',
      '💰 Stake: *' + stake + '* @ ' + price,
      '🆔 Bet ID: ' + betID,
      '📊 ' + market + '  |  🕐 ' + placedTime,
    ].join('\n'),
  };
}

function formatNumber(val) {
  if (val === null || val === undefined) return 'N/A';
  const num = Number(val);
  if (isNaN(num)) return String(val);
  const abs = Math.abs(num);
  if (abs >= 1_00_00_000) return (num / 1_00_00_000).toFixed(2) + ' Cr';
  if (abs >= 1_00_000) return (num / 1_00_000).toFixed(2) + ' L';
  if (abs >= 1_000) return (num / 1_000).toFixed(1) + ' K';
  return num.toFixed(0);
}

// Detect actual sport from event name patterns (API mislabels some)
function detectSport(item) {
  const type = (item.eventType || '').toLowerCase();
  const name = (item.eventName || '').toLowerCase();
  const market = (item.marketName || '').toLowerCase();

  // Cricket-specific patterns (override API's "Soccer" mislabel)
  if (/test match|odi\b|t20\b|innings|wicket|batsman|cricket| ipl | psl | bbl /i.test(name + market)) return '🏏 Cricket';
  // "TeamA v TeamB" pattern → cricket or tennis (not soccer)
  if (/ v /i.test(name) && !/horses?|racing|fifa|nfl|nba|ufc|mma/i.test(name)) return '🏏 Cricket';
  // Explicit sport types
  if (type.includes('horse') || type.includes('racing')) return '🐎 Horse Racing';
  if (type.includes('tennis')) return '🎾 Tennis';
  if (type.includes('soccer') || type.includes('football')) return '⚽ Soccer';
  if (type.includes('cricket')) return '🏏 Cricket';

  return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Sport';
}

// ── Telegram Sender ────────────────────────────────────

async function sendTelegram(chatId, html) {
  if (!TG_API) return false;
  try {
    const resp = await axios.post(TG_API + '/sendMessage', {
      chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    }, { timeout: 10_000 });
    return resp.data?.ok === true;
  } catch (e) {
    console.warn('[tg] ⚠️  ' + chatId + ': ' + (e.response?.data?.description || e.message));
    return false;
  }
}

// ── WhatsApp Sender (Whapi.cloud) ──────────────────────

async function sendWhatsApp(to, text) {
  if (!WA_URL || !WA_TOKEN) return false;
  try {
    const resp = await axios.post(WA_URL, {
      to: to, // keep @g.us for groups, digits for numbers
      body: text,
    }, {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + WA_TOKEN,
      },
    });
    // Whapi returns { sent: true, id: "..." } on success
    if (resp.data?.sent || resp.status === 200 || resp.status === 201) return true;
    console.warn('[wa] ⚠️  +' + phone + ': ' + JSON.stringify(resp.data).substring(0, 200));
    return false;
  } catch (e) {
    console.warn('[wa] ⚠️  ' + to + ': ' + (e.response?.data?.error || e.message));
    return false;
  }
}

// ── Main Notifier ──────────────────────────────────────

async function notifyNewTrades(newItems) {
  if (!Array.isArray(newItems) || newItems.length === 0) return { tg: 0, wa: 0 };

  const tgEnabled = TG_TOKEN && TG_IDS.length > 0;
  const waEnabled = WA_URL && WA_TOKEN && (WA_NUMS.length > 0 || WA_GROUP);
  const waTargets = [...WA_NUMS];
  if (WA_GROUP) waTargets.push(WA_GROUP);

  if (!tgEnabled && !waEnabled) {
    console.warn('[notify] ⚠️  Neither Telegram nor WhatsApp configured.');
    return { tg: 0, wa: 0 };
  }

  let tgSent = 0, tgFail = 0, waSent = 0, waFail = 0;

  for (const item of newItems) {
    const isRisk = item.eventType || item.eventName || item.marketName;
    const isChange = item._alertType === 'change' || item._alertType === 'liability_change';
    const isBet = !!(item.betID && item.runnerName);  // individual bet from MSACurrentMarketBets
    
    let msg;
    if (isBet) {
      msg = formatBetAlert(item);
    } else if (isChange) {
      const parts = [];
      if (item._betDelta > 0) parts.push('+' + item._betDelta + ' bets');
      if (item._clientDelta > 0) parts.push('+' + item._clientDelta + ' clients');
      if (Math.abs(item._liabilityDelta) >= 1000) parts.push(formatNumber(item._liabilityDelta) + ' liab');
      const delta = parts.join(', ') || '🔄 activity';
      msg = formatRiskAlert(item);
      msg.tg = msg.tg.replace('⚠️ <b>Risk Alert', '📈 <b>' + delta);
      msg.wa = msg.wa.replace('⚠️ *Risk Alert', '📈 *' + delta);
    } else {
      msg = isRisk ? formatRiskAlert(item) : { tg: '📢 New item: ' + (item._id || item.id), wa: '📢 New item: ' + (item._id || item.id) };
    }
    const label = item.eventName || item.marketName || item._id || item.id || '?';

    // Telegram
    if (tgEnabled) {
      console.log('[tg] 📤 ' + label + ' → ' + TG_IDS.length + ' chat(s)');
      for (const id of TG_IDS) {
        (await sendTelegram(id, msg.tg)) ? tgSent++ : tgFail++;
        await sleep(50);
      }
    }

    // WhatsApp
    if (waEnabled) {
      console.log('[wa] 📤 ' + label + ' → ' + waTargets.length + ' target(s)');
      for (const target of waTargets) {
        const isGroup = target.includes('@g.us');
        const to = isGroup ? target : target.replace(/[^0-9]/g, '');
        (await sendWhatsApp(to, msg.wa)) ? waSent++ : waFail++;
        await sleep(200);
      }
    }
  }

  const parts = [];
  if (tgEnabled) parts.push('TG: ' + tgSent + '/' + (tgSent + tgFail));
  if (waEnabled) parts.push('WA: ' + waSent + '/' + (waSent + waFail));
  console.log('[notify] 📬 ' + parts.join(' | '));
  return { tg: tgSent, wa: waSent };
}

module.exports = { notifyNewTrades, formatRiskAlert, formatBetAlert };
