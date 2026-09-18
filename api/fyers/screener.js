// api/fyers/screener.js
// High-IV screener: filters the 210 F&O stocks to ones down >=30% over the
// past 6 months, ranked by realized-volatility percentile -- a proxy for
// IV Rank, since true options IV Rank needs a year of accumulated daily IV
// history this project has no way to build (no DB, no cron). See
// docs/superpowers/specs/2026-09-18-hiv-stocks-screener-design.md.
const ROLLING_WINDOW = 20; // trading days per realized-vol window
const MIN_CANDLES = ROLLING_WINDOW + 20; // need >=20 rolling-vol points to rank against
const ANNUALIZATION_FACTOR = Math.sqrt(252);
const SIX_MONTH_SECONDS = 182 * 24 * 60 * 60;

// candles: [[unixTs, open, high, low, close, volume], ...] ascending by time.
function sixMonthChangePct(candles) {
  if (!candles || candles.length < 2) return null;
  const latest = candles[candles.length - 1];
  const targetTs = latest[0] - SIX_MONTH_SECONDS;

  let closest = candles[0];
  let closestDiff = Math.abs(candles[0][0] - targetTs);
  for (const c of candles) {
    const diff = Math.abs(c[0] - targetTs);
    if (diff < closestDiff) { closest = c; closestDiff = diff; }
  }

  const baseClose = closest[4];
  const latestClose = latest[4];
  if (!baseClose) return null;
  return ((latestClose - baseClose) / baseClose) * 100;
}

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function volRank(candles) {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const closes = candles.map((c) => c[4]);
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const rollingVols = [];
  for (let i = ROLLING_WINDOW - 1; i < logReturns.length; i++) {
    const window = logReturns.slice(i - ROLLING_WINDOW + 1, i + 1);
    rollingVols.push(stdev(window) * ANNUALIZATION_FACTOR);
  }
  if (rollingVols.length < 20) return null;

  const todayVol = rollingVols[rollingVols.length - 1];
  const countBelowOrEqual = rollingVols.filter((v) => v <= todayVol).length;
  return (countBelowOrEqual / rollingVols.length) * 100;
}

const { getInstrumentMap } = require('./_contracts');

const HISTORY_URL = 'https://api-t1.fyers.in/data/history';
const OPTION_CHAIN_URL = 'https://api-t1.fyers.in/data/options-chain-v3';
const HISTORY_RANGE_DAYS = 366;
const FETCH_CONCURRENCY = 8;
const FETCH_SPACING_MS = 1000;
const DOWN_THRESHOLD_PCT = -30;
const CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

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

// Response shape for IV is unconfirmed against a real Fyers account (see
// spec) -- probe the plausible shapes and return null rather than throwing
// if none match, so a wrong guess here never breaks the screener itself.
async function fetchOptionIv(spotSymbol, authHeader) {
  try {
    const params = new URLSearchParams({ symbol: spotSymbol, strikecount: '1' });
    const res = await fetch(`${OPTION_CHAIN_URL}?${params}`, { headers: { Authorization: authHeader, version: '2.0' } });
    const data = await res.json();
    if (!res.ok || data.s !== 'ok') return null;
    const chain = (data.data && Array.isArray(data.data.optionsChain)) ? data.data.optionsChain
      : (Array.isArray(data.d) ? data.d : null);
    if (!chain) return null;
    const withIv = chain.find((row) => typeof row.iv === 'number');
    return withIv ? withIv.iv : null;
  } catch (err) {
    return null;
  }
}

async function screenBatch(entries, authHeader) {
  // entries: [[symbol, spotSymbol], ...]
  const results = [];
  // TEMPORARY DIAGNOSTICS -- added to root-cause the "0 matches across all
  // 212 stocks" report. Strip this block (and the `diagnostics` field on
  // the response/return) once a live run confirms the real cause and fix.
  const diagnostics = { historyOk: 0, historyFailed: 0, sampleErrors: [], sampleChanges: [] };

  for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
    const chunk = entries.slice(i, i + FETCH_CONCURRENCY);
    const histories = await Promise.all(
      chunk.map(([, spotSymbol]) =>
        fetchHistory(spotSymbol, authHeader)
          .then((candles) => ({ candles, error: null }))
          .catch((err) => ({ candles: null, error: err.message }))
      )
    );
    chunk.forEach(([symbol], idx) => {
      const { candles, error } = histories[idx];
      if (error) {
        diagnostics.historyFailed++;
        if (diagnostics.sampleErrors.length < 3) diagnostics.sampleErrors.push(error);
        return;
      }
      diagnostics.historyOk++;
      const pct = sixMonthChangePct(candles);
      const rank = volRank(candles);
      if (diagnostics.sampleChanges.length < 5) {
        diagnostics.sampleChanges.push({ symbol, pct, rank, candleCount: candles.length });
      }
      if (pct === null || rank === null) return;
      if (pct <= DOWN_THRESHOLD_PCT) {
        results.push({ symbol, sixMonthChangePct: pct, volRank: rank, optionIv: null });
      }
    });
    if (i + FETCH_CONCURRENCY < entries.length) await sleep(FETCH_SPACING_MS);
  }

  const entryBySymbol = new Map(entries);
  for (let i = 0; i < results.length; i += FETCH_CONCURRENCY) {
    const chunk = results.slice(i, i + FETCH_CONCURRENCY);
    const ivs = await Promise.all(
      chunk.map((r) => fetchOptionIv(entryBySymbol.get(r.symbol), authHeader))
    );
    chunk.forEach((r, idx) => { r.optionIv = ivs[idx]; });
    if (i + FETCH_CONCURRENCY < results.length) await sleep(FETCH_SPACING_MS);
  }

  return { results, diagnostics };
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
    const allSymbols = Object.keys(instrumentMap);
    const batchSymbols = allSymbols.slice(offset, offset + limit);
    const entries = batchSymbols.map((symbol) => [symbol, instrumentMap[symbol].spotSymbol]);

    const authHeader = `${appId}:${accessToken}`;
    const { results, diagnostics } = await screenBatch(entries, authHeader);

    const nextOffset = offset + limit < allSymbols.length ? offset + limit : null;
    const payload = { status: 'ok', results, nextOffset, total: allSymbols.length, diagnostics };
    batchCache.set(cacheKey, { builtAt: Date.now(), payload });
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: 'screener_fetch_failed', message: err.message });
  }
}

module.exports = handler;
module.exports.sixMonthChangePct = sixMonthChangePct;
module.exports.volRank = volRank;
