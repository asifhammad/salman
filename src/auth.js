'use strict';

// ──────────────────────────────────────────────────────
// Module A: Authenticator — Playwright headless login
// Target:  SSEXCH247 Admin Panel (newadmin.ssexch247.net)
// Auth:    Custom `token` header (32-char hex), captured
//          by intercepting the first API request post-login
// ──────────────────────────────────────────────────────

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const AUTH_STATE_PATH = path.resolve(
  process.env.AUTH_STATE_PATH || './data/auth_state.json'
);

const RECAPTCHA_SITE_KEY =
  process.env.RECAPTCHA_SITE_KEY || '6LfaGQQeAAAAAHGQ_EEv9PWEu8pQE_suL2WUSL7h';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveAuthState(payload) {
  ensureDir(AUTH_STATE_PATH);
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log('[auth] ✅ Auth state saved →', AUTH_STATE_PATH);
}

function loadAuthState() {
  try {
    if (fs.existsSync(AUTH_STATE_PATH)) {
      const raw = fs.readFileSync(AUTH_STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.apiToken || parsed.bearerToken || parsed.cookieString)) {
        const age = Date.now() - (parsed.timestamp || 0);
        console.log('[auth] 📂 Loaded cached auth state (age: ' + Math.round(age / 1000) + 's)');
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[auth] ⚠️  Could not read cached auth state, will re-login.');
  }
  return null;
}

/**
 * Obtain a reCAPTCHA v3 token. Only used in headless mode.
 */
async function getRecaptchaToken(page, action = 'login') {
  try {
    await page.waitForFunction(
      () => typeof window.grecaptcha !== 'undefined' && window.grecaptcha.execute,
      { timeout: 10_000 }
    );
    const token = await page.evaluate(
      ({ siteKey, act }) => {
        return new Promise((resolve, reject) => {
          try {
            window.grecaptcha.ready(() => {
              window.grecaptcha.execute(siteKey, { action: act }).then(resolve).catch(reject);
            });
          } catch (e) { reject(e); }
        });
      },
      { siteKey: RECAPTCHA_SITE_KEY, act: action }
    );
    console.log('[auth] 🔐 reCAPTCHA v3 token obtained (length=' + token.length + ')');
    return token;
  } catch (err) {
    console.warn('[auth] ⚠️  reCAPTCHA token failed: ' + err.message);
    return null;
  }
}

/**
 * Perform headless login and capture the API token.
 *
 * SSEXCH247 auth flow:
 *  1. Login form → Angular calls grecaptcha.execute() + POST to login API
 *  2. Login API returns encrypted token → stored in localStorage as `loginType`
 *  3. Dashboard loads → Angular decrypts `loginType` and sends as `token` header
 *  4. We intercept the first API request to capture the decrypted `token` value
 *
 * @returns {Promise<{ apiToken: string, loginType: string, userData: string, timestamp: number }>}
 */
async function authenticate() {
  const loginUrl    = process.env.PORTAL_LOGIN_URL;
  const username    = process.env.USERNAME;
  const password    = process.env.PASSWORD;
  const manualSolve = process.env.RECAPTCHA_MANUAL_SOLVE === 'true';
  const headless    = manualSolve ? false : (process.env.HEADLESS !== 'false');
  const timeout     = Number(process.env.BROWSER_TIMEOUT_MS) || 30_000;

  if (!loginUrl || !username || !password) {
    throw new Error('[auth] Missing required env vars: PORTAL_LOGIN_URL, USERNAME, PASSWORD');
  }

  console.log('[auth] 🚀 Launching browser (headless: ' + headless + ')…');
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // ── Intercept API requests to capture ALL auth headers ──
  let capturedApiToken = null;
  let capturedUserId = null;
  let capturedLayerNo = null;
  let capturedLevelNo = null;

  page.on('request', (req) => {
    if (capturedApiToken) return; // already got everything
    const url = req.url();
    if (url.includes('/api/') && url.includes('newadmin.ssexch247.net')) {
      const h = req.headers();
      if (h['token'] && h['id'] && h['layerno'] && h['levelno']) {
        capturedApiToken = h['token'];
        capturedUserId = h['id'];
        capturedLayerNo = h['layerno'];
        capturedLevelNo = h['levelno'];
        console.log('[auth] 🎫 All auth headers captured: token=' + h['token'] + ' id=' + h['id'] + ' layer=' + h['layerno'] + ' level=' + h['levelno']);
      }
    }
  });

  let authPayload = null;

  try {
    // ── 1. Navigate to login page ───────────────────────
    console.log('[auth] 🌐 Navigating to ' + loginUrl);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2_000);

    // ── 2. reCAPTCHA (headless mode only) ───────────────
    let recaptchaToken = null;
    if (headless) {
      recaptchaToken = await getRecaptchaToken(page, 'login');
    } else {
      console.log('[auth] 🖥️  Visible browser — Angular handles reCAPTCHA natively');
    }

    // ── 3. Fill credentials (use real typing for Angular) ──
    const usernameSelector =
      process.env.LOGIN_USERNAME_SELECTOR ||
      'input[type="text"][placeholder="Enter your username"]';
    const passwordSelector =
      process.env.LOGIN_PASSWORD_SELECTOR || 'input#password-input';
    const submitSelector =
      process.env.LOGIN_SUBMIT_SELECTOR || 'button:has-text("Log in")';

    const usernameInput = page.locator(usernameSelector).first();
    const passwordInput = page.locator(passwordSelector).first();

    await usernameInput.waitFor({ state: 'visible', timeout });
    await usernameInput.click();
    await usernameInput.clear();
    // Use pressSequentially for real keystrokes that Angular can detect
    await usernameInput.pressSequentially(username, { delay: 30 });

    await passwordInput.waitFor({ state: 'visible', timeout });
    await passwordInput.click();
    await passwordInput.clear();
    await passwordInput.pressSequentially(password, { delay: 30 });

    // Inject reCAPTCHA token in headless mode
    if (recaptchaToken) {
      await page.evaluate((token) => {
        const input = document.querySelector('[name="g-recaptcha-response"], #g-recaptcha-response, input[id*="recaptcha"]');
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        window.__recaptchaToken = token;
      }, recaptchaToken);
      console.log('[auth] 🔐 reCAPTCHA token injected');
    }

    console.log('[auth] 🔐 Submitting form…');

    // ── 4. Submit & wait for dashboard ──────────────────
    const submitBtn = page.locator(submitSelector).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 5_000 });

    // Click and wait for redirect away from /login
    try {
      await Promise.race([
        page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20_000 }),
        submitBtn.click({ timeout: 5_000 }),
      ]);
    } catch (_) {
      console.log('[auth] ⚠️  Button click did not redirect, trying Enter…');
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15_000 });
    }

    // Wait for Angular + first API calls to fire
    await page.waitForTimeout(5_000);

    const urlAfter = page.url();
    console.log('[auth] 📍 URL after login: ' + urlAfter);

    if (urlAfter.includes('/login')) {
      const errorText = await page.evaluate(() => {
        const els = document.querySelectorAll('.error, .alert, .toast, [role="alert"], .text-danger, .invalid-feedback');
        return Array.from(els).map(e => e.textContent.trim()).filter(Boolean).join(' | ');
      });
      throw new Error(
        '[auth] ❌ Login failed — still on login page.' +
        (errorText ? ' Server says: ' + errorText : ' Check credentials.')
      );
    }

    // ── 5. Build auth payload ───────────────────────────
    if (capturedApiToken) {
      authPayload = {
        apiToken: capturedApiToken,
        userId: capturedUserId,
        layerNo: capturedLayerNo,
        levelNo: capturedLevelNo,
        timestamp: Date.now()
      };
    }

    // Also save encrypted localStorage values as backup
    const localStorageData = await page.evaluate(() => {
      const data = {};
      const keys = ['loginType', 'UserLoggedIn', 'AllowedForStatement'];
      for (const key of keys) {
        const val = localStorage.getItem(key);
        if (val) data[key] = val;
      }
      return data;
    });

    if (authPayload) {
      authPayload.localStorageData = localStorageData;
    }

    // Capture cookies
    const cookies = await context.cookies();
    if (cookies.length > 0) {
      const cookieString = cookies.map(c => c.name + '=' + c.value).join('; ');
      if (authPayload) {
        authPayload.cookieString = cookieString;
      } else {
        authPayload = { cookieString, timestamp: Date.now() };
      }
    }

    if (!authPayload) {
      throw new Error('[auth] ❌ Login succeeded but no API token was captured. Try again.');
    }

  } catch (err) {
    try {
      const debugDir = path.resolve('./data/debug');
      ensureDir(path.join(debugDir, 'screenshot.png'));
      await page.screenshot({ path: path.join(debugDir, 'screenshot.png'), fullPage: true });
      console.log('[auth] 📸 Debug screenshot saved → ' + debugDir + '/screenshot.png');
    } catch (_) { /* ignore */ }
    throw new Error('[auth] ❌ Authentication failed: ' + err.message);
  } finally {
    await browser.close();
  }

  saveAuthState(authPayload);
  return authPayload;
}

async function getAuthHeaders(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadAuthState();
    if (cached) return cached;
  }
  console.log('[auth] 🔄 Performing fresh login…');
  return authenticate();
}

module.exports = { authenticate, getAuthHeaders, loadAuthState, saveAuthState };
