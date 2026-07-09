'use strict';

// ──────────────────────────────────────────────────────
// Module B: API Poller — Axios-based data fetcher
// Target:  SSEXCH247 Admin API (newadmin.ssexch247.net/api)
// ──────────────────────────────────────────────────────
// Responsibilities:
//  1. Use JWT Bearer token (or cookies) to POST to the
//     dashboard API endpoint on a cron schedule
//  2. On 401/403 → signal session expiry, trigger Module A
//     re-authentication, then retry the request once
//  3. Feed the raw JSON response into Module C for diffing
//  4. Pass new items to Module D for notification
// ──────────────────────────────────────────────────────

const axios = require('axios');
const { getAuthHeaders } = require('./auth');
const { diffNewTrades, getProcessedCount, pruneOldRecords } = require('./db');
const { notifyNewTrades } = require('./notifier');

// ── Config ─────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'https://newadmin.ssexch247.net/api';
const POLL_ENDPOINT = process.env.POLL_ENDPOINT || 'MSACurrentWorkingMarketList';
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS) || 30;
const REQUEST_TIMEOUT_MS = 15_000;

// Risk Analysis thresholds
const MIN_LIABILITY_THRESHOLD = Number(process.env.MIN_LIABILITY_THRESHOLD) || 0;
const LIABILITY_CHANGE_THRESHOLD = Number(process.env.LIABILITY_CHANGE_THRESHOLD) || 50000; // alert if liability changes by 50K+

// Bet-level polling (individual bets within each market)
const BET_POLL_ENABLED = process.env.BET_POLL_ENABLED !== 'false'; // default: on
const BET_POLL_ENDPOINT = 'MSACurrentMarketBets';
const BET_POLL_MAX_COUNT = Number(process.env.BET_POLL_MAX_COUNT) || 100000;
const BET_POLL_MAX_MARKETS = Number(process.env.BET_POLL_MAX_MARKETS) || 20; // max markets to deep-poll per cycle

// ── State ──────────────────────────────────────────────
let authState = null;
let pollCount = 0;
let pruneCounter = 0;
let previousLiabilityMap = new Map(); // marketID → last known liability

// ── Helpers ────────────────────────────────────────────

/**
 * Build Axios request config from current auth state.
 * SSEXCH247 requires: token, id, layerno, levelno headers.
 */
function buildRequestConfig() {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Referer': process.env.PORTAL_BASE_URL || 'https://newadmin.ssexch247.net/',
  };

  // SSEXCH247 auth headers (all required)
  if (authState.apiToken)  headers['token']   = authState.apiToken;
  if (authState.userId)    headers['id']       = authState.userId;
  if (authState.layerNo)   headers['layerno']  = authState.layerNo;
  if (authState.levelNo)   headers['levelno']  = authState.levelNo;

  // Fallback: JWT Bearer
  if (!authState.apiToken && authState.bearerToken) {
    headers['Authorization'] = 'Bearer ' + authState.bearerToken;
  }
  // Fallback: cookies
  if (authState.cookieString) {
    headers['Cookie'] = authState.cookieString;
  }

  return { timeout: REQUEST_TIMEOUT_MS, headers };
}

/**
 * Extract an array of items from the API response, regardless
 * of the exact response envelope used by SSEXCH247.
 */
function extractItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // Common SSEXCH247 response shapes
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.result)) return data.result;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.trades)) return data.trades;
  if (Array.isArray(data.bets)) return data.bets;
  // Some endpoints return { success: true, data: [...] }
  if (data.success && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * The SSEXCH247 API uses POST for most endpoints with a body
 * containing pagination/filter params. This builds that body.
 */
function buildRequestBody() {
  return {
    // Some endpoints need these defaults
    page: 1,
    limit: 100,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    // Add any additional filters here if needed
  };
}

/**
 * Perform a single poll cycle:
 *   POST to API → check status → diff → notify
 */
async function executePollCycle() {
  if (!API_BASE) {
    console.error('[poller] ❌ API_BASE is not set.');
    return { success: false, newItemsFound: 0 };
  }

  // Ensure we have auth
  if (!authState) {
    console.log('[poller] 🔑 No auth state — fetching…');
    authState = await getAuthHeaders();
  }

  const url = API_BASE.replace(/\/+$/, '') + '/' + POLL_ENDPOINT;
  let response;

  try {
    pollCount++;
    console.log('[poller] 📡 Poll #' + pollCount + ' → POST ' + url);
    response = await axios.post(url, buildRequestBody(), buildRequestConfig());
  } catch (err) {
    const status = err.response?.status;

    // ── Session expired → re-authenticate & retry once ──
    if (status === 401 || status === 403) {
      console.warn('[poller] ⚠️  HTTP ' + status + ' — session expired. Re-authenticating…');
      authState = await getAuthHeaders(true); // force fresh login

      try {
        console.log('[poller] 🔁 Retrying request with fresh auth…');
        response = await axios.post(url, buildRequestBody(), buildRequestConfig());
      } catch (retryErr) {
        console.error('[poller] ❌ Retry also failed: ' + retryErr.message);
        return { success: false, newItemsFound: 0 };
      }
    } else {
      console.error('[poller] ❌ Request failed: ' + err.message);
      if (err.response?.data) {
        console.error('[poller] 📋 Response body:', JSON.stringify(err.response.data).substring(0, 500));
      }
      return { success: false, newItemsFound: 0 };
    }
  }

  // ── Parse & validate response ────────────────────────
  const data = response.data;
  const items = extractItems(data);

  console.log('[poller] 📦 Received ' + items.length + ' item(s) from ' + POLL_ENDPOINT);

  // ── Risk Analysis: filter by liability threshold ──────
  if (POLL_ENDPOINT === 'MSACurrentWorkingMarketList' && MIN_LIABILITY_THRESHOLD > 0) {
    const before = items.length;
    items = items.filter(item => {
      const liability = Math.abs(Number(item.liability || 0));
      return liability >= MIN_LIABILITY_THRESHOLD;
    });
    if (before !== items.length) {
      console.log('[poller] 🔎 Liability filter: ' + items.length + ' of ' + before +
        ' markets exceed threshold (' + MIN_LIABILITY_THRESHOLD + ')');
    }
  }

  // ── Detect changes on existing markets ──────────────────
  const changeAlerts = [];
  if (POLL_ENDPOINT === 'MSACurrentWorkingMarketList') {
    for (const item of items) {
      const mktId = item.marketID;
      const currentLiab = Math.abs(Number(item.liability || 0));
      const currentBets = Number(item.totalBets || 0);
      const currentClients = Number(item.totalClients || 0);
      const prev = previousLiabilityMap.get(mktId) || { liab: 0, bets: 0, clients: 0 };

      const liabDelta = currentLiab - prev.liab;
      const betDelta = currentBets - prev.bets;
      const clientDelta = currentClients - prev.clients;

      // Alert if anything changed
      if (prev.liab > 0 && (liabDelta > LIABILITY_CHANGE_THRESHOLD || betDelta > 0 || clientDelta > 0)) {
        changeAlerts.push({
          ...item,
          _alertType: 'change',
          _prevLiability: prev.liab,
          _liabilityDelta: liabDelta,
          _betDelta: betDelta,
          _clientDelta: clientDelta,
        });
      }
      previousLiabilityMap.set(mktId, { liab: currentLiab, bets: currentBets, clients: currentClients });
    }
  }

  if (items.length === 0 && changeAlerts.length === 0) {
    return { success: true, newItemsFound: 0 };
  }

  const idKey = detectIdKey(items[0] || changeAlerts[0]);
  const newMarkets = items.length > 0 ? diffNewTrades(items, idKey) : [];

  const allAlerts = [...newMarkets];
  for (const alert of changeAlerts) {
    const alreadyNew = newMarkets.some(m => m.marketID === alert.marketID);
    if (!alreadyNew) allAlerts.push(alert);
  }

  if (allAlerts.length > 0) {
    await notifyNewTrades(allAlerts);
  }

  // ── Bet-level polling: fetch individual bets for each market ──
  if (BET_POLL_ENABLED) {
    const newBets = await pollIndividualBets(items);
    if (newBets.length > 0) {
      console.log('[poller] 🎯 Total new individual bets this cycle: ' + newBets.length);
      await notifyNewTrades(newBets);
    }
  }

  // ── Periodic housekeeping ────────────────────────────
  pruneCounter++;
  if (pruneCounter % 100 === 0) {
    pruneOldRecords(30);
  }

  return { success: true, newItemsFound: allAlerts.length };
}

/**
 * Auto-detect the unique ID field from a sample item.
 * SSEXCH247 uses various ID fields:
 *   - _id, id, requestId, transactionId, betId, marketId, clientId
 */
function detectIdKey(sampleItem) {
  if (!sampleItem || typeof sampleItem !== 'object') return '_id';
  const keys = Object.keys(sampleItem);

  // Risk Analysis (MSACurrentWorkingMarketList): use marketID
  const idCandidates = [
    'marketID', 'marketId', 'marketid',
    '_id', 'id', 'ID', 'requestId', 'transactionId',
    'betId', 'clientId', 'userId', 'tradeId', 'refId',
  ];
  for (const candidate of idCandidates) {
    // Case-insensitive match
    const match = keys.find(k => k.toLowerCase() === candidate.toLowerCase());
    if (match) return match;
  }
  // Fallback: first key containing 'id' (case-insensitive)
  for (const key of keys) {
    if (key.toLowerCase().includes('id')) return key;
  }
  return '_id';
}

/**
 * Initialize auth state (cold start).
 */
async function bootstrapAuth() {
  try {
    authState = await getAuthHeaders();
    console.log('[poller] 🔐 Auth bootstrapped successfully.');
    return true;
  } catch (err) {
    console.error('[poller] ❌ Failed to bootstrap auth:', err.message);
    return false;
  }
}

/**
 * Fetch individual bets for a specific market from MSACurrentMarketBets.
 * Returns the raw bet array from the API response.
 */
async function fetchMarketBets(marketID) {
  const url = API_BASE.replace(/\/+$/, '') + '/' + BET_POLL_ENDPOINT;
  try {
    const resp = await axios.post(url, {
      status: 'M',          // 'M' = Matched bets
      marketID: String(marketID),
      count: BET_POLL_MAX_COUNT,
    }, buildRequestConfig());
    const data = resp.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.result)) return data.result;
    return [];
  } catch (err) {
    // 401/403 → session expired, let main poll handle re-auth
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      console.warn('[poller] ⚠️  Bet poll 401/403 for market ' + marketID + ' — skipping.');
    } else {
      console.warn('[poller] ⚠️  Bet poll failed for market ' + marketID + ': ' + err.message);
    }
    return [];
  }
}

/**
 * Poll individual bets for all active markets and detect new bets.
 * Uses betID as the unique key for deduplication.
 */
async function pollIndividualBets(markets) {
  if (!BET_POLL_ENABLED || markets.length === 0) return [];

  // Limit how many markets we deep-poll per cycle
  const marketsToPoll = markets.slice(0, BET_POLL_MAX_MARKETS);
  const allNewBets = [];

  for (const market of marketsToPoll) {
    const mktId = market.marketID;
    if (!mktId) continue;

    const bets = await fetchMarketBets(mktId);
    if (bets.length === 0) continue;

    console.log('[poller] 🎲 Market ' + mktId + ' (' + (market.marketName || '?') + '): ' + bets.length + ' individual bets');

    // Diff using betID as the unique key
    const newBets = diffNewTrades(bets, 'betID');
    if (newBets.length > 0) {
      console.log('[poller] 🆕 ' + newBets.length + ' NEW individual bet(s) in ' + (market.eventName || mktId));
      allNewBets.push(...newBets);
    }
  }

  return allNewBets;
}

module.exports = { executePollCycle, bootstrapAuth, POLL_INTERVAL_SECONDS };
