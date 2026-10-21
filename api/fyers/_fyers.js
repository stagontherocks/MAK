// fetch wrapper for Fyers *data* API calls (quotes, history, option chain).
// The Standard plan allows 5,000 data calls/day; once Fyers answers with the
// daily-limit error (code -360, "requests/day") every further call is wasted
// traffic until the quota resets. So the first such answer trips a breaker:
// for BLOCK_MS no call goes out at all (callers see the same error message
// and fall back to cached data where they have it), then one call probes
// whether the quota is back. Per-second/minute -360 errors don't trip it.
const BLOCK_MS = 30 * 60 * 1000;
const DAILY_MSG = 'Fyers daily data limit (5,000 requests/day) reached. Data is paused and will resume automatically when Fyers resets the quota.';
let blockedUntil = 0;

// Per-request call counting for the nav-bar usage meter: `counted()` wraps a
// route so every real Fyers call made while serving it (fyersFetch, below) is
// tallied and reported to the browser as X-Fyers-Calls (cache hits = 0), plus
// X-Fyers-Limit: daily when the daily quota is exhausted/blocked.
const { AsyncLocalStorage } = require('async_hooks');
const callContext = new AsyncLocalStorage();

function counted(handler) {
  return (req, res) => {
    const ctx = { calls: 0, limit: false };
    const wrapped = Object.create(res);
    wrapped.status = (c) => { res.status(c); return wrapped; };
    wrapped.json = (body) => {
      if (res.setHeader) {
        res.setHeader('X-Fyers-Calls', String(ctx.calls));
        if (ctx.limit) res.setHeader('X-Fyers-Limit', 'daily');
      }
      return res.json(body);
    };
    return callContext.run(ctx, () => handler(req, wrapped));
  };
}

function isBlocked() {
  return Date.now() < blockedUntil;
}

async function fyersFetch(url, options) {
  const ctx = callContext.getStore();
  if (isBlocked()) {
    if (ctx) ctx.limit = true;
    throw new Error(DAILY_MSG);
  }
  if (ctx) ctx.calls++;
  const res = await fetch(url, options);
  if (!res.ok || res.status === 429) {
    try {
      const body = await res.clone().json();
      if (body && body.code === -360 && /requests\/day/i.test(String(body.message))) {
        blockedUntil = Date.now() + BLOCK_MS;
        if (ctx) ctx.limit = true;
      }
    } catch (err) { /* not JSON -- ignore */ }
  }
  return res;
}

// IST trading hours, Mon-Fri (NSE 09:00-15:35, MCX 09:00-23:30). Holidays
// aren't modelled. Used to stretch cache lifetimes when prices can't move.
function marketOpen(mcx) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return false;
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return mins >= 540 && mins <= (mcx ? 1410 : 935);
}

// Small TTL memo for per-symbol loads (daily candles etc.).
const memoStore = new Map();
async function memo(key, ttlMs, loader) {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await loader();
  if (memoStore.size > 600) memoStore.clear();
  memoStore.set(key, { value, ts: Date.now() });
  return value;
}

// Wraps a (req,res) handler so successful 200 JSON responses are cached per
// key for ttl(req) ms. On a non-200 (quota, upstream error) the last good
// body is served even if past its TTL. Cached bodies are only reachable with
// a session cookie: the key includes the tail of the caller's token.
const responseStore = new Map();
function cachedHandler(handler, { key, ttl, parseCookies }) {
  return async (req, res) => {
    const token = (parseCookies(req).fyers_session || '').slice(-12);
    const k = `${token}|${key(req)}`;
    const hit = token ? responseStore.get(k) : null;
    if (hit && Date.now() - hit.ts < ttl(req)) {
      res.status(200).json(hit.body);
      return;
    }
    let code = 200;
    const wrapped = Object.create(res);
    wrapped.status = (c) => { code = c; res.status(c); return wrapped; };
    wrapped.json = (body) => {
      if (code !== 200 && hit) { res.status(200); return res.json(hit.body); }
      if (code === 200 && token) {
        if (responseStore.size > 80) responseStore.clear();
        responseStore.set(k, { body, ts: Date.now() });
      }
      return res.json(body);
    };
    return handler(req, wrapped);
  };
}

module.exports = { fyersFetch, counted, isBlocked, marketOpen, memo, cachedHandler, DAILY_MSG };
