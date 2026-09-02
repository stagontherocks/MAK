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

async function createWsSession(userId, accessToken) {
  const params = new URLSearchParams({ source: 'API', userId, token: accessToken });
  const res = await fetch(`https://protrade.jainam.in/api/client-rest/profile/createWsSess?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const rawBody = await res.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    throw new Error(`createWsSess returned non-JSON (status ${res.status}): ${rawBody.slice(0, 300)}`);
  }

  const list = Array.isArray(data.result) ? data.result : (Array.isArray(data) ? data : [data]);
  const record = list[0] || {};
  const sessionId = record.sessionId || record.SessionID || record.session_id || record.sessionID;

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
