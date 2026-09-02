const crypto = require('crypto');

// Derives the WebSocket `susertoken` for wss://ws.jainam.in/NorenWSTP/ from the
// REST accessToken we already hold (jainam_session cookie). Cached per
// accessToken in module scope -- createWsSess mints a fresh session id each
// call, and we don't want a new one per poll while the cookie is still valid.
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const cache = new Map();

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Same base URL Jainam's own official Postman collection uses for every
// other REST call (orders, portfolio, profile): BASE_OPENAPI_LIVE =
// https://protrade.jainam.in/omt/api-order-rest.
const CREATE_WS_SESS_URL = 'https://protrade.jainam.in/omt/api-order-rest/v1/profile/createWsSess';

function extractSessionId(rawBody) {
  const data = JSON.parse(rawBody);
  const list = Array.isArray(data.result) ? data.result : (Array.isArray(data) ? data : [data]);
  const record = list[0] || {};
  return record.sessionId || record.SessionID || record.session_id || record.sessionID;
}

async function requestWsSession(method, userId, accessToken) {
  const params = new URLSearchParams({ source: 'API', userId, token: accessToken });
  const isGet = method === 'GET';
  const res = await fetch(isGet ? `${CREATE_WS_SESS_URL}?${params}` : CREATE_WS_SESS_URL, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(isGet ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(isGet ? {} : { body: JSON.stringify({ source: 'API', userId, token: accessToken }) }),
  });
  const rawBody = await res.text();
  return { res, rawBody };
}

// The docs say POST, but Jainam's actual routing has been inconsistent
// about which method a given endpoint accepts -- fall back to GET on a
// method-rejection response instead of costing another round trip to find out.
async function createWsSession(userId, accessToken) {
  let { res, rawBody } = await requestWsSession('POST', userId, accessToken);

  if (res.status === 404 || res.status === 405 || /method/i.test(rawBody)) {
    ({ res, rawBody } = await requestWsSession('GET', userId, accessToken));
  }

  let sessionId;
  try {
    sessionId = extractSessionId(rawBody);
  } catch (_) {
    throw new Error(`createWsSess returned non-JSON (status ${res.status}): ${rawBody.slice(0, 300)}`);
  }

  if (!res.ok || !sessionId) {
    throw new Error(`createWsSess failed (status ${res.status}): ${rawBody.slice(0, 300)}`);
  }
  return sessionId;
}

async function getSusertoken(userId, accessToken) {
  const cached = cache.get(accessToken);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached.susertoken;

  const sessionId = await createWsSession(userId, accessToken);
  const susertoken = sha256Hex(sha256Hex(sessionId));
  cache.set(accessToken, { susertoken, builtAt: Date.now() });
  return susertoken;
}

module.exports = { getSusertoken };
