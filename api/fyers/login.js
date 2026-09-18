// Starts the Fyers OAuth login flow. trading.html links here instead of
// embedding the App ID directly, keeping the pattern consistent with
// callback.js (which holds the actual secret).
const REDIRECT_URI = 'https://mak-ten-gray.vercel.app/api/fyers/callback';

module.exports = async (req, res) => {
  const appId = process.env.FYERS_APP_ID;

  if (!appId) {
    res.status(500).send('Server misconfigured: FYERS_APP_ID is not set.');
    return;
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state: 'trading_login',
  });
  const loginUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
  res.writeHead(302, { Location: loginUrl });
  res.end();
};
