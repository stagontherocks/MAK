// Shared helpers for api/store/*: identifies the caller from the Fyers
// session cookie (verified against Fyers' profile endpoint) and talks to
// Supabase's REST API with the server-only secret key. The browser never
// sees a Supabase key.
const PROFILE_URL = 'https://api-t1.fyers.in/api/v3/profile';

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

// Resolves to the verified Fyers client id, or sends an error response and
// resolves to null.
async function requireUser(req, res) {
  const appId = process.env.FYERS_APP_ID;
  const token = parseCookies(req).fyers_session;
  if (!token) {
    res.status(401).json({ error: 'Not connected to broker' });
    return null;
  }
  try {
    const r = await fetch(PROFILE_URL, { headers: { Authorization: `${appId}:${token}` } });
    const data = await r.json();
    const id = data && data.s === 'ok' && data.data && data.data.fy_id;
    if (!id) {
      res.status(401).json({ error: 'Broker session invalid or expired' });
      return null;
    }
    const owner = process.env.OWNER_FYERS_ID;
    if (owner && owner.trim().toUpperCase() !== String(id).toUpperCase()) {
      res.status(403).json({ error: 'Not authorised' });
      return null;
    }
    return String(id).toUpperCase();
  } catch (err) {
    res.status(502).json({ error: 'Could not verify broker session' });
    return null;
  }
}

// Minimal PostgREST client. `path` is e.g. 'watchlists?fyers_id=eq.X'.
async function sb(method, path, body, extraHeaders) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
  const r = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: Object.assign({
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    }, extraHeaders || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

module.exports = { requireUser, sb };
