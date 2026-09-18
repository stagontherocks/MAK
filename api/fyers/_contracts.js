// Shared by quotes.js: resolves each of our F&O symbols to its Fyers spot
// symbol (NSE:<SYM>-EQ) and its 3 nearest FUTSTK symbols, from Fyers'
// downloadable per-segment symbol-master CSVs. Cached in module scope
// (warm-lambda lifetime) since the symbol master only changes once a day.
const FO_STOCKS = require('../../source/fo-stocks.json');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = { builtAt: 0, map: null };

// Column layout verified against a live download of both files (no header
// row is present): index 9 is the ready-to-use Fyers symbol string, index
// 13 is the underlying's short name (matches fo-stocks.json's Symbol),
// index 16 is "XX" for a plain future/equity row and "CE"/"PE" for an
// option, and index 8 is the contract's expiry as a unix timestamp (blank
// for equities). Fyers' own community has flagged their documented header
// list for these files as wrong -- this mapping is verified against real
// downloaded rows, not the docs.
const COL = { SYMBOL: 9, SHORT_NAME: 13, OPTION_TYPE: 16, EXPIRY_TS: 8 };

// Index futures don't have an equity spot row in NSE_CM.csv, so their spot
// symbol is hardcoded to the fixed index symbol (same ones quotes.js already
// uses for the navbar tickers) instead of coming from spotBySymbol below.
const INDEX_SPOT_SYMBOLS = { NIFTY: 'NSE:NIFTY50-INDEX', BANKNIFTY: 'NSE:NIFTYBANK-INDEX' };

function parseCsv(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => line.split(','));
}

async function fetchCsv(segmentFile) {
  const res = await fetch(`https://public.fyers.in/sym_details/${segmentFile}`);
  if (!res.ok) throw new Error(`Symbol master fetch failed for ${segmentFile}: ${res.status}`);
  return parseCsv(await res.text());
}

async function buildInstrumentMap() {
  const [cmRows, foRows] = await Promise.all([
    fetchCsv('NSE_CM.csv'),
    fetchCsv('NSE_FO.csv'),
  ]);

  const spotBySymbol = {};
  for (const row of cmRows) {
    if (row[COL.SYMBOL] && row[COL.SYMBOL].endsWith('-EQ')) {
      spotBySymbol[row[COL.SHORT_NAME]] = row[COL.SYMBOL];
    }
  }

  const futuresBySymbol = {};
  for (const row of foRows) {
    // "XX" + a symbol ending in "FUT" isolates plain futures rows (both
    // index and stock futures) regardless of the unreliable instrument_type
    // column; only symbols present in FO_STOCKS end up in the final map.
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
  for (const [symbol] of FO_STOCKS) {
    const spotSymbol = spotBySymbol[symbol];
    const futures = (futuresBySymbol[symbol] || []).slice(0, 3);
    if (!spotSymbol || futures.length === 0) continue;
    map[symbol] = { spotSymbol, futures };
  }
  for (const symbol in INDEX_SPOT_SYMBOLS) {
    const futures = (futuresBySymbol[symbol] || []).slice(0, 3);
    if (futures.length === 0) continue;
    map[symbol] = { spotSymbol: INDEX_SPOT_SYMBOLS[symbol], futures };
  }
  return map;
}

async function getInstrumentMap() {
  if (cache.map && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.map;
  const map = await buildInstrumentMap();
  cache = { builtAt: Date.now(), map };
  return map;
}

module.exports = { getInstrumentMap };
