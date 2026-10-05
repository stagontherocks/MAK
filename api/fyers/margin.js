// Estimated margin for a strategy from Fyers' own calculator
// (POST /api/v3/multiorder/margin). All legs go in one request so Fyers
// applies SPAN netting -- a hedged spread gets its reduced requirement,
// which summing per-leg margins would miss. Fyers' calculation is
// server-side (SPAN + exposure from NSE risk files), so there is no local
// formula to reproduce. Notes from Fyers' community: bought options only
// cost the premium, and equity symbols aren't supported by this API.
const MARGIN_URL = 'https://api-t1.fyers.in/api/v3/multiorder/margin';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LEGS = 20;

// NSE_FO.csv columns, same verified layout _contracts.js documents:
// 8 expiry (unix s), 9 Fyers symbol, 13 underlying short name, 15 strike
// (-1 for futures), 16 CE / PE / XX (future).
const COL = { EXPIRY: 8, SYMBOL: 9, SHORT_NAME: 13, STRIKE: 15, TYPE: 16 };

let cache = { builtAt: 0, map: null };

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

// Expiry timestamps in the chain and in the master can differ by the time
// of day, so contracts are matched on their IST calendar date instead.
const istDay = (unixSeconds) =>
  new Date(Number(unixSeconds) * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const keyOf = (name, expiry, strike, type) => `${name}|${istDay(expiry)}|${strike}|${type}`;

async function getContractMap() {
  if (cache.map && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.map;
  const res = await fetch('https://public.fyers.in/sym_details/NSE_FO.csv');
  if (!res.ok) throw new Error(`Symbol master fetch failed: ${res.status}`);
  const map = new Map();
  for (const line of (await res.text()).split(/\r?\n/)) {
    if (!line) continue;
    const row = line.split(',');
    const type = row[COL.TYPE];
    if (type !== 'CE' && type !== 'PE' && type !== 'XX') continue;
    const strike = type === 'XX' ? 0 : Number(row[COL.STRIKE]);
    map.set(keyOf(row[COL.SHORT_NAME], row[COL.EXPIRY], strike, type === 'XX' ? 'FUT' : type), row[COL.SYMBOL]);
  }
  cache = { builtAt: Date.now(), map };
  return map;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const token = parseCookies(req).fyers_session;
  const appId = process.env.FYERS_APP_ID;
  if (!token) {
    res.status(401).json({ error: 'not_logged_in' });
    return;
  }

  const body = req.body || {};
  const underlying = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : '';
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (!underlying || legs.length === 0 || legs.length > MAX_LEGS) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  try {
    const contracts = await getContractMap();
    // Same contract + side across several legs is merged into one order.
    const orders = new Map();
    for (const leg of legs) {
      const qty = Math.round(Number(leg.qty));
      const side = leg.side === 'Buy' ? 1 : leg.side === 'Sell' ? -1 : 0;
      const type = leg.type;
      if (!side || !(qty > 0) || (type !== 'CE' && type !== 'PE' && type !== 'FUT')) {
        res.status(400).json({ error: 'bad_leg' });
        return;
      }
      const symbol = contracts.get(keyOf(underlying, leg.expiry, type === 'FUT' ? 0 : Number(leg.strike), type));
      if (!symbol) {
        // MCX and anything not in the NSE F&O master land here.
        res.status(200).json({ status: 'unsupported', message: 'Margin is only available for NSE F&O contracts.' });
        return;
      }
      const k = `${symbol}|${side}`;
      const existing = orders.get(k);
      if (existing) existing.qty += qty;
      else orders.set(k, { symbol, qty, side, type: 2, productType: 'MARGIN', limitPrice: 0, stopLoss: 0 });
    }

    const fyRes = await fetch(MARGIN_URL, {
      method: 'POST',
      headers: { Authorization: `${appId}:${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: Array.from(orders.values()) }),
    });
    const data = await fyRes.json();
    if (fyRes.status === 401 || data.code === -16 || data.code === -15) {
      res.status(401).json({ error: 'not_logged_in' });
      return;
    }
    if (!fyRes.ok || data.s !== 'ok' || !data.data) {
      res.status(502).json({ error: 'margin_failed', message: data.message || 'Fyers margin request failed', raw: data });
      return;
    }
    const d = data.data;
    // margin_new_order = what these legs alone need; margin_total also
    // folds in margin already used by open positions, so it's only the
    // fallback. `raw` is passed through so field names can be checked
    // against a live response.
    const margin = [d.margin_new_order, d.margin_total].map(Number).find((v) => Number.isFinite(v));
    res.status(200).json({ status: 'ok', margin: margin === undefined ? null : margin, available: d.margin_avail ?? null, raw: d });
  } catch (err) {
    res.status(502).json({ error: 'margin_failed', message: err.message });
  }
};
