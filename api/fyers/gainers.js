// api/fyers/gainers.js
// Backs BOTH top-gainers.html and top-losers.html -- it returns every F&O
// stock's full 1D/1M/3M/6M period set, so "gainers" vs "losers" is purely a
// client-side default-sort difference (ascending vs descending), not a
// different data feed. Kept under its original "gainers" filename since
// that's the deployed endpoint path; rename would just be churn.
//
// For every F&O stock (source/fo-stocks.json, no indices/MCX), computes %
// change over 1 day / 1 month / 3 months / 6 months from Fyers daily
// candles, using the universal gain formula ((current - past) / past) *
// 100. Mirrors screener.js's history-fetch, rate-limit, batching and
// caching pattern -- see that file for why the concurrency/spacing
// constants are set the way they are (sustained rate, not burst rate,
// since batches chain back-to-back with no idle gaps).
const { getInstrumentMap } = require('./_contracts');
const FO_STOCKS = require('../../source/fo-stocks.json'); // [symbol, lotSize] pairs

const HISTORY_URL = 'https://api-t1.fyers.in/data/history';
const HISTORY_RANGE_DAYS = 366; // 52 weeks + margin for weekends/holidays (ATL needs a full year)
const FETCH_CONCURRENCY = 5;
const FETCH_SPACING_MS = 2000; // 150 req/min sustained, safely under Fyers' 200/min cap
const CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

// Calendar-day lookback windows for the 1M/3M/6M reference price. 1-day
// change uses the previous candle directly instead (exact previous trading
// day close, not a 24h cutoff).
const LOOKBACK_SECONDS = {
  m1: 30 * 24 * 60 * 60,
  m3: 91 * 24 * 60 * 60,
  m6: 182 * 24 * 60 * 60,
};
const FIFTY_TWO_WEEK_SECONDS = 364 * 24 * 60 * 60;

const batchCache = new Map(); // key: "offset:limit" -> { builtAt, payload }

function parseCookies(req) {
  if (req.cookies) return req.cookies;
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHistory(spotSymbol, authHeader) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - HISTORY_RANGE_DAYS * 24 * 60 * 60;
  const params = new URLSearchParams({
    symbol: spotSymbol, resolution: 'D', date_format: '0',
    range_from: String(from), range_to: String(now), cont_flag: '1',
  });
  const res = await fetch(`${HISTORY_URL}?${params}`, { headers: { Authorization: authHeader, version: '2.0' } });
  const data = await res.json();
  if (!res.ok || data.s !== 'ok' || !Array.isArray(data.candles)) {
    throw new Error(`history fetch failed for ${spotSymbol}: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data.candles;
}

// candles: [[unixTs, open, high, low, close, volume], ...] ascending by
// time. Returns the close of the last candle at or before cutoffTs, falling
// back to the earliest available candle if history doesn't reach that far
// back (e.g. a recent listing).
function closeNearCutoff(candles, cutoffTs) {
  let match = candles[0];
  for (const c of candles) {
    if (c[0] > cutoffTs) break;
    match = c;
  }
  return match[4];
}

function pctChange(current, past) {
  if (past === null || past === undefined || past === 0) return null;
  return ((current - past) / past) * 100;
}

// candles ascending by time. "ATL" here means 52-week low (the deepest
// intraday low over the trailing year, not the stock's true all-time low --
// Fyers' history endpoint plus this file's HISTORY_RANGE_DAYS can't reach
// further back than that anyway). Uses candle LOW (index 3), not close,
// same reasoning as screener.js's 6-month-high calc: the actual intraday
// extreme, not just the lowest closing price.
function fiftyTwoWeekLow(candles) {
  if (!candles || candles.length < 2) return null;
  const latest = candles[candles.length - 1];
  const cutoffTs = latest[0] - FIFTY_TWO_WEEK_SECONDS;
  let low = null;
  for (const c of candles) {
    if (c[0] < cutoffTs) continue;
    if (low === null || c[3] < low) low = c[3];
  }
  return low;
}

// Mirror of fiftyTwoWeekLow, using candle HIGH (index 2) and the max instead
// of the min -- backs top-gainers.html's "ATH" period option.
function fiftyTwoWeekHigh(candles) {
  if (!candles || candles.length < 2) return null;
  const latest = candles[candles.length - 1];
  const cutoffTs = latest[0] - FIFTY_TWO_WEEK_SECONDS;
  let high = null;
  for (const c of candles) {
    if (c[0] < cutoffTs) continue;
    if (high === null || c[2] > high) high = c[2];
  }
  return high;
}

function computeChanges(candles) {
  if (!candles || candles.length < 2) return null;
  const latest = candles[candles.length - 1];
  const latestClose = latest[4];
  const latestTs = latest[0];
  const prevClose = candles[candles.length - 2][4];

  const out = { ltp: latestClose, d1: pctChange(latestClose, prevClose) };
  for (const key in LOOKBACK_SECONDS) {
    const refClose = closeNearCutoff(candles, latestTs - LOOKBACK_SECONDS[key]);
    out[key] = pctChange(latestClose, refClose);
  }
  // % above the 52-week low -- always >=0 by construction ("how far this
  // stock is from its own yearly low", not a signed period return like
  // d1/m1/m3/m6). % from the 52-week high is the mirror image and is
  // always <=0 (0 means currently AT the high).
  const week52Low = fiftyTwoWeekLow(candles);
  const week52High = fiftyTwoWeekHigh(candles);
  out.atl = pctChange(latestClose, week52Low);
  out.ath = pctChange(latestClose, week52High);
  // Also keep the raw price levels themselves (not just the % derived from
  // them) -- top-gainers.html/top-losers.html show these as their own
  // "52W Low"/"52W High" columns.
  out.week52Low = week52Low;
  out.week52High = week52High;
  return out;
}

async function scanBatch(entries, authHeader) {
  // entries: [[symbol, spotSymbol, lot], ...]
  const results = [];

  for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
    const chunk = entries.slice(i, i + FETCH_CONCURRENCY);
    const histories = await Promise.all(
      chunk.map(([, spotSymbol]) => fetchHistory(spotSymbol, authHeader).catch(() => null))
    );
    chunk.forEach(([symbol, , lot], idx) => {
      const changes = computeChanges(histories[idx]);
      if (!changes) return;
      results.push({
        symbol, lot, ltp: changes.ltp, d1: changes.d1, m1: changes.m1, m3: changes.m3, m6: changes.m6,
        atl: changes.atl, ath: changes.ath, week52Low: changes.week52Low, week52High: changes.week52High,
      });
    });
    if (i + FETCH_CONCURRENCY < entries.length) await sleep(FETCH_SPACING_MS);
  }

  return results;
}

async function handler(req, res) {
  const cookies = parseCookies(req);
  const accessToken = cookies.fyers_session;
  const appId = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    res.status(401).json({ error: 'not_logged_in' });
    return;
  }

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  const cacheKey = `${offset}:${limit}`;
  const cached = batchCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    res.status(200).json(cached.payload);
    return;
  }

  try {
    const instrumentMap = await getInstrumentMap();
    const batch = FO_STOCKS.slice(offset, offset + limit);
    const entries = batch
      .filter(([symbol]) => instrumentMap[symbol])
      .map(([symbol, lot]) => [symbol, instrumentMap[symbol].spotSymbol, lot]);

    const authHeader = `${appId}:${accessToken}`;
    const results = await scanBatch(entries, authHeader);

    const nextOffset = offset + limit < FO_STOCKS.length ? offset + limit : null;
    const payload = { status: 'ok', results, nextOffset, total: FO_STOCKS.length };
    batchCache.set(cacheKey, { builtAt: Date.now(), payload });
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: 'gainers_fetch_failed', message: err.message });
  }
}

module.exports = handler;
module.exports.computeChanges = computeChanges;
module.exports.closeNearCutoff = closeNearCutoff;
module.exports.fiftyTwoWeekLow = fiftyTwoWeekLow;
module.exports.fiftyTwoWeekHigh = fiftyTwoWeekHigh;
