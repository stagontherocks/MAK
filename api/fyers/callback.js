const crypto = require('crypto');

// Fyers redirects the user's browser here after login, with auth_code in
// the query string. We exchange it (plus our secret) for an access token,
// then hand the browser back to trading.html via an httpOnly cookie.
module.exports = async (req, res) => {
  const authCode = req.query.auth_code;

  if (!authCode) {
    res.status(400).send('Missing auth_code from Fyers redirect.');
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

    res.setHeader('Set-Cookie', [
      `fyers_session=${data.access_token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=28800`,
    ]);

    res.writeHead(302, { Location: '/trading.html' });
    res.end();
  } catch (err) {
    res.status(500).send('Error during Fyers login exchange: ' + err.message);
  }
};
