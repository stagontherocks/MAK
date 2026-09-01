// Starts the Jainam SSO login flow. trading.html links here instead of
// embedding the appCode directly, so the appCode only ever lives server-side.
module.exports = async (req, res) => {
  const appCode = process.env.JAINAM_APP_CODE;

  if (!appCode) {
    res.status(500).send('Server misconfigured: JAINAM_APP_CODE is not set.');
    return;
  }

  const loginUrl = `https://protrade.jainam.in/?appcode=${encodeURIComponent(appCode)}`;
  res.writeHead(302, { Location: loginUrl });
  res.end();
};
