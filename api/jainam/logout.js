// Clears the Jainam session cookies set by callback.js and sends the
// browser back to trading.html in a logged-out state.
module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', [
    'jainam_session=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
    'jainam_user=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
  ]);
  res.writeHead(302, { Location: '/trading.html' });
  res.end();
};
