'use strict';

// ──────────────────────────────────────────────────────
// Module: WhatsApp — Baileys direct WhatsApp Web client
// ──────────────────────────────────────────────────────
// Connects to WhatsApp Web, handles QR auth, persists
// session for auto-reconnect, and exposes a send() method.
// ──────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');

// ── Config ─────────────────────────────────────────────
const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR || './data/whatsapp_auth');

// ── State ──────────────────────────────────────────────
let sock = null;
let isConnected = false;
let connectionPromise = null;
let onReadyCallback = null;

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

/**
 * Initialize Baileys WhatsApp connection.
 * On first run, prints a QR code to the terminal.
 * On subsequent runs, reconnects using saved credentials.
 *
 * @returns {Promise<import('@whiskeysockets/baileys').WASocket>}
 */
async function connect() {
  if (isConnected && sock) return sock;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const logger = pino({ level: 'info' });  // 'info' so QR code prints

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ['SSEXCH247 Bot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,     // ping every 30s to stay alive
      connectTimeoutMs: 30_000,
    });

    // ── Manual QR fallback (in case printQRInTerminal doesn't work) ──
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Print QR in terminal
        try {
          const qrcode = require('qrcode-terminal');
          console.log('\n' + '='.repeat(50));
          console.log('📱 SCAN THIS QR CODE WITH WHATSAPP');
          console.log('   WhatsApp → Linked Devices → Link a Device');
          console.log('='.repeat(50));
          qrcode.generate(qr, { small: true });
          console.log('='.repeat(50) + '\n');
        } catch (_) {
          console.log('[wa] 📱 QR code received — scan it with WhatsApp');
        }

        // Also save QR as PNG image (not cut off!)
        try {
          const QRCode = require('qrcode');
          const qrPath = path.resolve('./data/qr.png');
          QRCode.toFile(qrPath, qr, {
            type: 'png',
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          }, (err) => {
            if (!err) console.log('[wa] 🖼️  QR saved as image → ' + qrPath);
          });
        } catch (_) { /* ignore */ }
      }

      if (connection === 'open') {
        isConnected = true;
        console.log('[wa] ✅ WhatsApp connected!');
        if (onReadyCallback) onReadyCallback(sock);
      }

      if (connection === 'close') {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          console.log('[wa] 🚫 Logged out — clearing session. Restart to scan new QR.');
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          connectionPromise = null;
          sock = null;
        } else if (code === 440) {
          // Conflict — another session (phone/web) took over. Don't fight it.
          console.log('[wa] 📱 Another WhatsApp session is active (your phone?).');
          console.log('[wa]    The bot will stay idle until that session disconnects.');
          console.log('[wa]    Only ONE WhatsApp Web session can be active at a time.');
          connectionPromise = null;
          // Don't reconnect — wait and try once later
          setTimeout(() => { connectionPromise = null; connect().catch(() => {}); }, 30_000);
        } else {
          console.log('[wa] 🔄 Connection lost (code: ' + (code || 'unknown') + ') — auto-reconnecting…');
        }
      }
    });

    // ── Save credentials on update ──────────────────────
    sock.ev.on('creds.update', saveCreds);

    // Wait for connection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[wa] ❌ WhatsApp connection timed out — did you scan the QR?'));
      }, 120_000); // 2 min to scan QR

      const check = setInterval(() => {
        if (isConnected) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    console.log('[wa] 🟢 WhatsApp ready to send messages');
    return sock;
  })();

  return connectionPromise;
}

/**
 * Send a text message to a WhatsApp number.
 *
 * @param {string} jid  - WhatsApp JID (e.g. '919876543210@s.whatsapp.net')
 * @param {string} text - Message body
 * @returns {Promise<boolean>}
 */
async function sendMessage(jid, text) {
  if (!isConnected || !sock) {
    console.warn('[wa] ⚠️  Not connected — attempting reconnect…');
    await connect();
  }

  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('[wa] ❌ Send failed to ' + jid + ': ' + err.message);
    return false;
  }
}

/**
 * Parse a phone number string into a WhatsApp JID.
 * Input: "919876543210" → Output: "919876543210@s.whatsapp.net"
 */
function toJid(phoneNumber) {
  const cleaned = phoneNumber.replace(/[^0-9]/g, '');
  return cleaned + '@s.whatsapp.net';
}

/**
 * Check if the WhatsApp connection is alive.
 */
function getStatus() {
  return {
    connected: isConnected,
    user: sock?.user?.id ? sock.user.id.replace('@s.whatsapp.net', '') : null,
    name: sock?.user?.name || null,
  };
}

module.exports = { connect, sendMessage, toJid, getStatus, isConnected: () => isConnected };
