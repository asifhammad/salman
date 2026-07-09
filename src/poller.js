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

  // ── Detect liability changes on existing markets ──────
  const liabilityAlerts = [];
  if (POLL_ENDPOINT === 'MSACurrentWorkingMarketList') {
    for (const item of items) {
      const mktId = item.marketID;
      const currentLiab = Math.abs(Number(item.liability || 0));
      const prevLiab = previousLiabilityMap.get(mktId) || 0;

      if (prevLiab > 0 && currentLiab > prevLiab + LIABILITY_CHANGE_THRESHOLD) {
        const delta = currentLiab - prevLiab;
        liabilityAlerts.push({
          ...item,
          _alertType: 'liability_change',
          _prevLiability: prevLiab,
          _liabilityDelta: delta,
        });
      }
      previousLiabilityMap.set(mktId, currentLiab);
    }
  }

  if (items.length === 0 && liabilityAlerts.length === 0) {
    return { success: true, newItemsFound: 0 };
  }

  // ── Determine the ID field ───────────────────────────
  const idKey = detectIdKey(items[0] || liabilityAlerts[0]);

  // ── Diff new markets against database ────────────────
  const newMarkets = items.length > 0 ? diffNewTrades(items, idKey) : [];

  // ── Combine: new markets + liability changes ──────────
  const allAlerts = [...newMarkets];
  // Add liability changes for markets we already know about
  for (const alert of liabilityAlerts) {
    // Only if not already in newMarkets (avoid duplicate)
    const alreadyNew = newMarkets.some(m => m.marketID === alert.marketID);
    if (!alreadyNew) {
      allAlerts.push(alert);
    }
  }

  if (allAlerts.length > 0) {
    await notifyNewTrades(allAlerts);
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

module.exports = { executePollCycle, bootstrapAuth, POLL_INTERVAL_SECONDS };
