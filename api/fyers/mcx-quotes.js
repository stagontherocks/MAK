const { getMcxInstrumentMap } = require('./_mcx_contracts');

const QUOTES_URL = 'https://api-t1.fyers.in/data/quotes';

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

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  const accessToken = cookies.fyers_session;
  const appId = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    res.status(401).json({ error: 'not_logged_in' });
    return;
  }

  try {
    const instrumentMap = await getMcxInstrumentMap();

    const symbols = [];
    for (const symbol in instrumentMap) {
      instrumentMap[symbol].futures.forEach((f) => symbols.push(f.symbol));
    }
    // Only CRUDEOIL + NATURALGAS x 3 nearest months -- well under Fyers'
    // 50-symbol-per-request cap, so unlike quotes.js/screener.js this never
    // needs chunking or batch pacing.
    const uniqueSymbols = Array.from(new Set(symbols));

    const authHeader = `${appId}:${accessToken}`;
    const url = `${QUOTES_URL}?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`;
    const quoteRes = await fetch(url, { headers: { Authorization: authHeader, version: '2.0' } });
    const data = await quoteRes.json();
    if (!quoteRes.ok || data.s !== 'ok') {
      throw new Error(`Fyers quotes fetch failed: ${JSON.stringify(data)}`);
    }

    const prices = new Map();
    for (const entry of data.d) {
      if (entry.s === 'ok' && entry.v && entry.v.lp !== undefined) {
        prices.set(entry.n, { lp: entry.v.lp, chp: entry.v.chp });
      }
    }

    const out = {};
    for (const symbol in instrumentMap) {
      const { futures } = instrumentMap[symbol];
      // No separate spot instrument here (see trading.html's poll handler) --
      // the front (nearest-expiry) future's own % change stands in for LTP's.
      const front = futures[0] && prices.get(futures[0].symbol);
      out[symbol] = {
        futures: futures.map((f) => {
          const p = prices.get(f.symbol);
          return p ? p.lp : null;
        }),
        chp: front && front.chp !== undefined ? front.chp : null,
      };
    }

    res.status(200).json({ status: 'ok', quotes: out });
  } catch (err) {
    res.status(502).json({ error: 'quote_fetch_failed', message: err.message });
  }
};
