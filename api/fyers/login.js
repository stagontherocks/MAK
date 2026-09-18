// Starts the Fyers OAuth login flow. trading.html links here instead of
// embedding the App ID directly, keeping the pattern consistent with
// callback.js (which holds the actual secret).
const crypto = require('crypto');

const REDIRECT_URI = 'https://mak-ten-gray.vercel.app/api/fyers/callback';

module.exports = async (req, res) => {
  const appId = process.env.FYERS_APP_ID;

  if (!appId) {
    res.status(500).send('Server misconfigured: FYERS_APP_ID is not set.');
    return;
  }

  // Random per-login state, checked by callback.js against this cookie --
  // without it, a crafted link could bind a victim's session to whatever
  // Fyers account the auth_code in that link belongs to (login CSRF).
  const state = crypto.randomBytes(32).toString('hex');
  res.setHeader('Set-Cookie', [
    `fyers_oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  ]);

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
  });
  const loginUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
  res.writeHead(302, { Location: loginUrl });
  res.end();
};
