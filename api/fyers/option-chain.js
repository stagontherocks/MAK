const { getInstrumentMap } = require('./_contracts');
const { computeDelta } = require('./_blackscholes');

const OPTION_CHAIN_URL = 'https://api-t1.fyers.in/data/options-chain-v3';
const STRIKE_COUNT = 20;

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

// optionsChain rows come back as one row per CE/PE contract, plus one
// "underlying" row (option_type "" , strike_price -1) carrying the spot's
// own ltp and the front future's price (fp/fpch/fpchp) -- verified against
// Fyers' own Go SDK source (github.com/sainipankaj15/All-In-One-Broker),
// since Fyers' own docs site is unreachable for scraping and their
// community has flagged their published docs as unreliable before (see
// _contracts.js). No IV/greeks field exists anywhere in this response.
function splitRows(optionsChain) {
  let underlying = null;
  const byStrike = {};
  for (const row of optionsChain) {
    if (row.option_type !== 'CE' && row.option_type !== 'PE') {
      underlying = row;
      continue;
    }
    const strike = row.strike_price;
    byStrike[strike] = byStrike[strike] || { strike, call: null, put: null };
    const leg = {
      ltp: row.ltp,
      ltpch: row.ltpch,
      oi: row.oi || 0,
      oich: row.oich || 0,
      volume: row.volume || 0,
      bid: row.bid,
      ask: row.ask,
    };
    if (row.option_type === 'CE') byStrike[strike].call = leg;
    else byStrike[strike].put = leg;
  }
  return { underlying, rows: Object.values(byStrike).sort((a, b) => a.strike - b.strike) };
}

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  const accessToken = cookies.fyers_session;
  const appId = process.env.FYERS_APP_ID;

  if (!accessToken || !appId) {
    res.status(401).json({ error: 'not_logged_in' });
    return;
  }

  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : '';
  const expiryParam = typeof req.query.expiry === 'string' ? req.query.expiry : '';
  if (!symbol) {
    res.status(400).json({ error: 'missing_symbol' });
    return;
  }

  try {
    const instrumentMap = await getInstrumentMap();
    const instrument = instrumentMap[symbol];
    if (!instrument) {
      res.status(404).json({ error: 'unknown_symbol' });
      return;
    }

    let url = `${OPTION_CHAIN_URL}?symbol=${encodeURIComponent(instrument.spotSymbol)}&strikecount=${STRIKE_COUNT}`;
    if (expiryParam) url += `&timestamp=${encodeURIComponent(expiryParam)}`;

    const authHeader = `${appId}:${accessToken}`;
    const fyersRes = await fetch(url, { headers: { Authorization: authHeader } });
    const body = await fyersRes.json();
    if (!fyersRes.ok || body.s !== 'ok') {
      throw new Error(`Fyers option chain failed: ${JSON.stringify(body)}`);
    }

    const data = body.data;
    const { underlying, rows } = splitRows(data.optionsChain || []);
    const spot = underlying ? underlying.ltp : null;
    const spotChp = underlying ? underlying.ltpchp : null;
    const future = underlying ? underlying.fp : null;
    const futureChp = underlying ? underlying.fpchp : null;
    const vix = data.indiavixData ? data.indiavixData.ltp : null;

    const expiries = (data.expiryData || []).map((e) => ({ date: e.date, expiry: e.expiry }));
    const selectedExpiry = expiryParam || (expiries[0] && expiries[0].expiry) || null;

    if (spot !== null && selectedExpiry) {
      const expiryTs = Number(selectedExpiry);
      for (const row of rows) {
        if (row.call) row.call.delta = computeDelta(true, spot, row.strike, expiryTs, undefined, row.call.ltp);
        if (row.put) row.put.delta = computeDelta(false, spot, row.strike, expiryTs, undefined, row.put.ltp);
      }
    }

    let atmStrike = null;
    if (spot !== null && rows.length > 0) {
      atmStrike = rows.reduce((best, row) =>
        Math.abs(row.strike - spot) < Math.abs(best - spot) ? row.strike : best, rows[0].strike);
    }

    res.status(200).json({
      status: 'ok',
      symbol,
      spot,
      spotChp,
      future,
      futureChp,
      vix,
      callOi: data.callOi || 0,
      putOi: data.putOi || 0,
      atmStrike,
      expiries,
      selectedExpiry,
      rows,
    });
  } catch (err) {
    res.status(502).json({ error: 'option_chain_fetch_failed', message: err.message });
  }
};
