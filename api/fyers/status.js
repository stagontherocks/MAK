// Cheap, instant "are we logged in" check -- just looks at the cookie, no
// call to Fyers at all. Lets both trading.html and hiv-stocks.html reflect
// the (already-shared, cookie-based) login state immediately on load,
// instead of waiting on their much slower quotes/screener polling to
// discover it indirectly via a non-401 response.
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

module.exports = async (req, res) => {
  const cookies = parseCookies(req);
  res.status(200).json({ loggedIn: Boolean(cookies.fyers_session) });
};
