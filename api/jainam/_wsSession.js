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

// Exactly the path from Jainam's WebSocket Streaming doc's "Create Session"
// section: https://protrade.jainam.in/open-apidocs/v2/WebSocket%20streaming.html
const CREATE_WS_SESS_URL = 'https://protrade.jainam.in/api/client-rest/profile/createWsSess';

function extractSessionId(rawBody) {
  const data = JSON.parse(rawBody);
  const list = Array.isArray(data.result) ? data.result : (Array.isArray(data) ? data : [data]);
  const record = list[0] || {};
  return record.sessionId || record.SessionID || record.session_id || record.sessionID;
}

// The gateway itself requires the standard "Authorization: Bearer <token>"
// form to let a request through at all (confirmed: dropping "Bearer " gets
// a gateway-level 401 with an empty body, same as a flat-out invalid
// token -- despite the doc's Request Headers example showing a bare JWT).
async function requestWsSession(mode, userId, accessToken) {
  const fields = { source: 'API', userId, token: accessToken };
  const headers = { Authorization: `Bearer ${accessToken}` };
  let url = CREATE_WS_SESS_URL;
  let body;

  if (mode === 'get') {
    url = `${CREATE_WS_SESS_URL}?${new URLSearchParams(fields)}`;
  } else if (mode === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(fields).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  }

  const res = await fetch(url, { method: mode === 'get' ? 'GET' : 'POST', headers, body });
  const rawBody = await res.text();
  return { res, rawBody };
}

function isMethodOrRouteRejection(res, rawBody) {
  return res.status === 404 || res.status === 405 || /method/i.test(rawBody);
}

// The docs say "POST, JSON body" but Jainam's actual routing has
// disagreed with its own docs multiple times -- work through the other
// plausible shapes (form-encoded body, then GET with query params)
// instead of costing another round trip with the user to find out.
async function createWsSession(userId, accessToken) {
  let { res, rawBody } = await requestWsSession('json', userId, accessToken);

  if (isMethodOrRouteRejection(res, rawBody)) {
    ({ res, rawBody } = await requestWsSession('form', userId, accessToken));
  }
  if (isMethodOrRouteRejection(res, rawBody)) {
    ({ res, rawBody } = await requestWsSession('get', userId, accessToken));
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
