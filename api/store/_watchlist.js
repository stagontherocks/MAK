// (served via api/store/index.js) GET -> { symbols: [...] }   PUT {symbols:[...]} -> replaces the saved list.
const { requireUser, sb } = require('./_store');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const id = encodeURIComponent(user);
  try {
    if (req.method === 'GET') {
      const rows = await sb('GET', `watchlists?fyers_id=eq.${id}&select=symbols`);
      res.status(200).json({ symbols: rows && rows[0] ? rows[0].symbols : null });
      return;
    }
    if (req.method === 'PUT') {
      const symbols = req.body && req.body.symbols;
      if (!Array.isArray(symbols) || symbols.length > 2000 || !symbols.every((s) => typeof s === 'string' && s.length < 40)) {
        res.status(400).json({ error: 'symbols must be an array of strings' });
        return;
      }
      await sb('POST', 'watchlists?on_conflict=fyers_id',
        { fyers_id: user, symbols, updated_at: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
