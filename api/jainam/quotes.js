const WebSocket = require('ws');
const { getInstrumentMap } = require('./_contracts');
const { getSusertoken } = require('./_wsSession');

const WS_URL = 'wss://ws.jainam.in/NorenWSTP/';
const COLLECT_WINDOW_MS = 4500;
const SUBSCRIBE_CHUNK_SIZE = 200;

// NSE index tokens, from Jainam's INDICES contract master (protrade.jainam.in/contract/csv/indices).
const INDEX_TOKENS = { NIFTY: '26000', BANKNIFTY: '26009', VIX: '26017' };

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

function buildSubscribeKeys(instrumentMap) {
  const subscribeKeys = Object.values(INDEX_TOKENS).map((token) => `NSE|${token}`);
  for (const symbol in instrumentMap) {
    const { spotToken, futures } = instrumentMap[symbol];
    subscribeKeys.push(`NSE|${spotToken}`);
    futures.forEach((f) => subscribeKeys.push(`NFO|${f.token}`));
  }
  return subscribeKeys;
}

function collectQuotes(susertoken, userId, subscribeKeys) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const prices = new Map();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(prices);
    };

    const timer = setTimeout(() => finish(null), COLLECT_WINDOW_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        susertoken,
        t: 'c',
        actid: `${userId}_API`,
        uid: `${userId}_API`,
        source: 'API',
      }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.t === 'ck') { finish(new Error(`WS connect rejected: ${JSON.stringify(msg)}`)); return; }

      if (msg.t === 'cf' && msg.s === 'OK') {
        for (let i = 0; i < subscribeKeys.length; i += SUBSCRIBE_CHUNK_SIZE) {
          const chunk = subscribeKeys.slice(i, i + SUBSCRIBE_CHUNK_SIZE).join('#');
          ws.send(JSON.stringify({ k: chunk, t: 't' }));
        }
        return;
      }

      if ((msg.t === 'tk' || msg.t === 'tf') && msg.tk && msg.lp !== undefined) {
        prices.set(msg.tk, parseFloat(msg.lp));
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(null));
  });
}

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  const accessToken = cookies.jainam_session;
  const userId = cookies.jainam_user;

  if (!accessToken || !userId) {
    res.status(401).json({ error: 'not_logged_in' });
    return;
  }

  try {
    const instrumentMap = await getInstrumentMap();
    const subscribeKeys = buildSubscribeKeys(instrumentMap);
    const susertoken = await getSusertoken(userId, accessToken);
    const prices = await collectQuotes(susertoken, userId, subscribeKeys);

    const out = {};
    for (const symbol in instrumentMap) {
      const { spotToken, futures } = instrumentMap[symbol];
      out[symbol] = {
        ltp: prices.has(spotToken) ? prices.get(spotToken) : null,
        futures: futures.map((f) => (prices.has(f.token) ? prices.get(f.token) : null)),
      };
    }

    const indices = {};
    for (const name in INDEX_TOKENS) {
      const token = INDEX_TOKENS[name];
      indices[name] = prices.has(token) ? prices.get(token) : null;
    }

    res.status(200).json({ status: 'ok', quotes: out, indices });
  } catch (err) {
    res.status(502).json({ error: 'quote_fetch_failed', message: err.message });
  }
};
