'use strict';

// ──────────────────────────────────────────────────────
// Module C: State & Diff Engine — SQLite-backed store
// ──────────────────────────────────────────────────────
// Responsibilities:
//  1. Maintain a local SQLite table of processed trade IDs
//  2. Accept an array of trade objects, diff against the DB
//  3. Return only NEW trades (never seen before)
//  4. Insert newly seen IDs immediately to prevent duplicates
// ──────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── Config ─────────────────────────────────────────────
const DB_PATH = path.resolve(process.env.DB_PATH || './data/processed_trades.db');

let db = null;

// ── Helpers ────────────────────────────────────────────
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Open (or create) the SQLite database and ensure the schema exists.
 * Uses WAL mode for better concurrent read performance (though we're
 * single-process, it's good practice).
 */
function initDatabase() {
  if (db) return db; // already initialized

  ensureDir(DB_PATH);

  db = new Database(DB_PATH);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_trades (
      trade_id    TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      raw_payload  TEXT
    );
  `);

  // Optional index (trade_id is already indexed as PK)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processed_at
      ON processed_trades(processed_at);
  `);

  console.log('[db] ✅ Database initialized →', DB_PATH);
  return db;
}

/**
 * Given an array of trade objects, filter down to only those whose
 * trade_id does NOT appear in the processed_trades table.
 *
 * Each trade object is expected to have a `trade_id` property
 * (or a key specified via the optional second argument).
 *
 * Side effect: newly seen trade IDs are INSERTed into the database
 * before this function returns, guaranteeing no duplicates even if
 * the caller crashes before sending notifications.
 *
 * @param {Array<object>} trades        - array of trade objects from the API
 * @param {string}        [idKey]       - property name to use as unique ID (default 'trade_id')
 * @returns {Array<object>}             - trades that have NOT been processed before
 */
function diffNewTrades(trades, idKey = 'trade_id') {
  if (!Array.isArray(trades) || trades.length === 0) return [];

  const database = initDatabase();

  // ── Build a bulk lookup ──────────────────────────────
  // SQLite supports a maximum of 999 host parameters by default;
  // if you expect more than ~900 new trades per poll, chunk the query.
  const ids = trades.map(t => String(t[idKey])).filter(Boolean);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const existingRows = database
    .prepare(
      `SELECT trade_id FROM processed_trades WHERE trade_id IN (${placeholders})`
    )
    .all(...ids);

  const existingSet = new Set(existingRows.map(r => r.trade_id));

  // ── Separate new vs seen ─────────────────────────────
  const newTrades = trades.filter(
    t => !existingSet.has(String(t[idKey]))
  );

  if (newTrades.length === 0) {
    console.log(`[db] 📊 All ${trades.length} trade(s) already processed — nothing new.`);
    return [];
  }

  // ── Bulk insert new IDs ──────────────────────────────
  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO processed_trades (trade_id, raw_payload)
    VALUES (?, ?)
  `);

  const insertMany = database.transaction(items => {
    for (const item of items) {
      insertStmt.run(
        String(item[idKey]),
        JSON.stringify(item)
      );
    }
  });

  insertMany(newTrades);

  console.log(
    `[db] 🆕 ${newTrades.length} new trade(s) detected out of ${trades.length} total.`
  );

  return newTrades;
}

/**
 * Return the total count of processed trade IDs.
 */
function getProcessedCount() {
  const database = initDatabase();
  const row = database.prepare(
    'SELECT COUNT(*) AS cnt FROM processed_trades'
  ).get();
  return row.cnt;
}

/**
 * Prune records older than `maxAgeDays` to keep the database lean.
 * Call this periodically (e.g., once a day via cron).
 */
function pruneOldRecords(maxAgeDays = 30) {
  const database = initDatabase();
  const result = database
    .prepare(
      `DELETE FROM processed_trades
       WHERE processed_at < datetime('now', '-' || ? || ' days')`
    )
    .run(maxAgeDays);
  console.log(`[db] 🧹 Pruned ${result.changes} record(s) older than ${maxAgeDays} days.`);
  return result.changes;
}

/**
 * Gracefully close the database connection.
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[db] 🔒 Database connection closed.');
  }
}

module.exports = { initDatabase, diffNewTrades, getProcessedCount, pruneOldRecords, closeDatabase };
