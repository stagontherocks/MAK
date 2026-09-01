const crypto = require('crypto');

// Jainam redirects the user's browser here after login, with authCode + userId
// in the query string. We exchange those (plus our secret) for an accessToken,
// then hand the browser back to trading.html via an httpOnly cookie.
module.exports = async (req, res) => {
  const { authCode, userId } = req.query;

  if (!authCode || !userId) {
    res.status(400).send('Missing authCode or userId from Jainam redirect.');
    return;
  }

  const apiSecret = process.env.JAINAM_API_SECRET;
  if (!apiSecret) {
    res.status(500).send('Server misconfigured: JAINAM_API_SECRET is not set.');
    return;
  }

  const checkSum = crypto
    .createHash('sha256')
    .update(userId + authCode + apiSecret)
    .digest('hex');

  try {
    const jainamRes = await fetch('https://protrade.jainam.in/omt/auth/sso/vendor/getUserDetails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkSum }),
    });
    const data = await jainamRes.json();
    // Jainam wraps the payload: { status, message, result: [{ accessToken, clientId }] }
    // Handle that, a bare array, or a bare object, since the exact shape has moved before.
    const list = Array.isArray(data.result) ? data.result : (Array.isArray(data) ? data : [data]);
    const record = list[0];

    if (!jainamRes.ok || !record || !record.accessToken) {
      res.status(502).send('Jainam login exchange failed: ' + JSON.stringify(data));
      return;
    }

    res.setHeader('Set-Cookie', [
      `jainam_session=${record.accessToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=28800`,
      `jainam_user=${encodeURIComponent(record.clientId || userId)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=28800`,
    ]);

    res.writeHead(302, { Location: '/trading.html' });
    res.end();
  } catch (err) {
    res.status(500).send('Error during Jainam login exchange: ' + err.message);
  }
};
