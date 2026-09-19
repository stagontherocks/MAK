const crypto = require('crypto');

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

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const RETURN_PATH_RE = /^\/[a-zA-Z0-9_-]+\.html$/;

// Fyers redirects the user's browser here after login, with auth_code and
// state in the query string. state must match the fyers_oauth_state cookie
// login.js set -- this guards against login CSRF (a crafted link carrying
// someone else's auth_code binding this session to their Fyers account).
// We then exchange auth_code (plus our secret) for an access token, and
// hand the browser back to whichever page Connect Broker was clicked from
// (login.js recorded it) via an httpOnly cookie.
module.exports = async (req, res) => {
  const authCode = req.query.auth_code;

  if (!authCode) {
    res.status(400).send('Missing auth_code from Fyers redirect.');
    return;
  }

  const cookies = parseCookies(req);
  if (!safeEqual(req.query.state, cookies.fyers_oauth_state)) {
    res.status(400).send('Invalid or missing OAuth state.');
    return;
  }

  const appId = process.env.FYERS_APP_ID;
  const secretKey = process.env.FYERS_SECRET_KEY;
  if (!appId || !secretKey) {
    res.status(500).send('Server misconfigured: FYERS_APP_ID or FYERS_SECRET_KEY is not set.');
    return;
  }

  const appIdHash = crypto
    .createHash('sha256')
    .update(`${appId}:${secretKey}`)
    .digest('hex');

  try {
    const fyersRes = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: authCode, appIdHash }),
    });
    const data = await fyersRes.json();

    if (!fyersRes.ok || data.s !== 'ok' || !data.access_token) {
      res.status(502).send('Fyers login exchange failed: ' + JSON.stringify(data));
      return;
    }

    let returnPath = '/trading.html';
    const storedReturn = cookies.fyers_oauth_return ? decodeURIComponent(cookies.fyers_oauth_return) : '';
    if (RETURN_PATH_RE.test(storedReturn)) returnPath = storedReturn;

    res.setHeader('Set-Cookie', [
      `fyers_session=${data.access_token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=28800`,
      'fyers_oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
      'fyers_oauth_return=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
    ]);

    res.writeHead(302, { Location: returnPath });
    res.end();
  } catch (err) {
    res.status(500).send('Error during Fyers login exchange: ' + err.message);
  }
};
