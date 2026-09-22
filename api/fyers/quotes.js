const { getInstrumentMap } = require('./_contracts');

const QUOTES_URL = 'https://api-t1.fyers.in/data/quotes';
const CHUNK_SIZE = 50;
const BATCH_CONCURRENCY = 8;
const BATCH_SPACING_MS = 1000;

// NSE index symbols, confirmed live against fyers.in/web/symbol/<sym>.
const INDEX_SYMBOLS = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  VIX: 'NSE:INDIAVIX-INDEX',
};

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

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChunk(symbols, authHeader) {
  const url = `${QUOTES_URL}?symbols=${encodeURIComponent(symbols.join(','))}`;
  const res = await fetch(url, { headers: { Authorization: authHeader, version: '2.0' } });
  const data = await res.json();
  if (!res.ok || data.s !== 'ok') {
    throw new Error(`Fyers quotes chunk failed: ${JSON.stringify(data)}`);
  }
  return data.d;
}

// Fetches all symbols in groups of CHUNK_SIZE (Fyers' per-request cap),
// running BATCH_CONCURRENCY chunks at a time with a pause between batches
// so the whole poll stays under Fyers' 10 req/sec cap (see spec: ~17
// chunks for ~839 symbols completes in ~2s this way).
async function fetchAllQuotes(symbols, authHeader) {
  const chunks = chunk(symbols, CHUNK_SIZE);
  const prices = new Map();

  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    const batch = chunks.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.all(batch.map((c) => fetchChunk(c, authHeader)));
    for (const entries of results) {
      for (const entry of entries) {
        if (entry.s === 'ok' && entry.v && entry.v.lp !== undefined) {
          prices.set(entry.n, { lp: entry.v.lp, chp: entry.v.chp });
        }
      }
    }
    if (i + BATCH_CONCURRENCY < chunks.length) await sleep(BATCH_SPACING_MS);
  }

  return prices;
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
    const instrumentMap = await getInstrumentMap();

    const symbols = Object.values(INDEX_SYMBOLS).slice();
    for (const symbol in instrumentMap) {
      const { spotSymbol, futures } = instrumentMap[symbol];
      symbols.push(spotSymbol);
      futures.forEach((f) => symbols.push(f.symbol));
    }

    // NIFTY/BANKNIFTY show up both in INDEX_SYMBOLS (navbar tickers) and in
    // instrumentMap (grid rows) with the same spot symbol -- dedupe so each
    // chunk isn't wasting a slot on a symbol already requested elsewhere.
    const uniqueSymbols = Array.from(new Set(symbols));

    const authHeader = `${appId}:${accessToken}`;
    const prices = await fetchAllQuotes(uniqueSymbols, authHeader);

    const out = {};
    for (const symbol in instrumentMap) {
      const { spotSymbol, futures } = instrumentMap[symbol];
      const spot = prices.get(spotSymbol);
      out[symbol] = {
        ltp: spot ? spot.lp : null,
        chp: spot && spot.chp !== undefined ? spot.chp : null,
        futures: futures.map((f) => {
          const p = prices.get(f.symbol);
          return p ? p.lp : null;
        }),
      };
    }

    const indices = {};
    for (const name in INDEX_SYMBOLS) {
      const symbol = INDEX_SYMBOLS[name];
      const p = prices.get(symbol);
      indices[name] = p ? p.lp : null;
    }

    res.status(200).json({ status: 'ok', quotes: out, indices });
  } catch (err) {
    res.status(502).json({ error: 'quote_fetch_failed', message: err.message });
  }
};

module.exports.chunk = chunk;
