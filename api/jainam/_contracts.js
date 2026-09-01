// Shared by quotes.js and instruments.js: resolves each of our F&O symbols to
// its spot (NSE) token and its 3 nearest FUTSTK (NFO) tokens, from Jainam's
// daily contract master CSVs. Cached in module scope (warm-lambda lifetime)
// since the contract master itself only changes once a day at 08:00 IST.
const FO_STOCKS = require('../../source/fo-stocks.json');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = { builtAt: 0, map: null };

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = parts[j];
    rows[i - 1] = row;
  }
  return rows;
}

async function fetchCsv(segment) {
  const res = await fetch(`https://protrade.jainam.in/contract/csv/${segment}`);
  if (!res.ok) throw new Error(`Contract master fetch failed for ${segment}: ${res.status}`);
  return parseCsv(await res.text());
}

async function buildInstrumentMap() {
  const [nse, nfo] = await Promise.all([fetchCsv('nse'), fetchCsv('nfo')]);

  const spotBySymbol = {};
  for (const row of nse) {
    if (row['Trading Symbol'] && row['Trading Symbol'].endsWith('-EQ')) {
      spotBySymbol[row['Symbol']] = row['Token'];
    }
  }

  const futuresBySymbol = {};
  for (const row of nfo) {
    if (row['Instrument Type'] === 'FUTSTK') {
      (futuresBySymbol[row['Symbol']] = futuresBySymbol[row['Symbol']] || []).push({
        token: row['Token'],
        expiry: row['Expiry Date'],
      });
    }
  }
  for (const sym in futuresBySymbol) {
    futuresBySymbol[sym].sort((a, b) => a.expiry.localeCompare(b.expiry));
  }

  const map = {};
  for (const [symbol] of FO_STOCKS) {
    const spotToken = spotBySymbol[symbol];
    const futures = (futuresBySymbol[symbol] || []).slice(0, 3);
    if (!spotToken || futures.length === 0) continue;
    map[symbol] = { spotToken, futures };
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
