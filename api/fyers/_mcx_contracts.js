// Shared by mcx-quotes.js: resolves CRUDEOIL and NATURALGAS to their 3
// nearest MCX futures symbols, from Fyers' downloadable MCX_COM.csv symbol
// master. Same CSV layout and caching approach as _contracts.js (see that
// file's comment) -- verified against a live download of MCX_COM.csv.
// Unlike NSE stocks, these have no equity spot row to resolve: the client
// uses the front-month future itself as a stand-in for LTP.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = { builtAt: 0, map: null };

const COL = { SYMBOL: 9, SHORT_NAME: 13, OPTION_TYPE: 16, EXPIRY_TS: 8 };
const MCX_SYMBOLS = ['CRUDEOIL', 'NATURALGAS'];

function parseCsv(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => line.split(','));
}

async function fetchCsv(segmentFile) {
  const res = await fetch(`https://public.fyers.in/sym_details/${segmentFile}`);
  if (!res.ok) throw new Error(`Symbol master fetch failed for ${segmentFile}: ${res.status}`);
  return parseCsv(await res.text());
}

async function buildMcxInstrumentMap() {
  const rows = await fetchCsv('MCX_COM.csv');

  const futuresBySymbol = {};
  for (const row of rows) {
    if (row[COL.OPTION_TYPE] === 'XX' && row[COL.SYMBOL] && row[COL.SYMBOL].endsWith('FUT')) {
      const key = row[COL.SHORT_NAME];
      (futuresBySymbol[key] = futuresBySymbol[key] || []).push({
        symbol: row[COL.SYMBOL],
        expiry: row[COL.EXPIRY_TS],
      });
    }
  }
  for (const sym in futuresBySymbol) {
    futuresBySymbol[sym].sort((a, b) => Number(a.expiry) - Number(b.expiry));
  }

  const map = {};
  for (const symbol of MCX_SYMBOLS) {
    const futures = (futuresBySymbol[symbol] || []).slice(0, 3);
    if (futures.length === 0) continue;
    map[symbol] = { futures };
  }
  return map;
}

async function getMcxInstrumentMap() {
  if (cache.map && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.map;
  const map = await buildMcxInstrumentMap();
  cache = { builtAt: Date.now(), map };
  return map;
}

module.exports = { getMcxInstrumentMap };
