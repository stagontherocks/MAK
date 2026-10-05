// GET            -> { strategies: [{id,name,data,created_at,updated_at}] }
// POST {name,data[,id]} -> create, or update when id given -> { id }
// DELETE ?id=... -> removes one
const { requireUser, sb } = require('./_store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const uid = encodeURIComponent(user);
  try {
    if (req.method === 'GET') {
      const rows = await sb('GET', `strategies?fyers_id=eq.${uid}&select=id,name,data,created_at,updated_at&order=updated_at.desc`);
      res.status(200).json({ strategies: rows || [] });
      return;
    }
    if (req.method === 'POST') {
      const { id, name, data } = req.body || {};
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || !data || typeof data !== 'object') {
        res.status(400).json({ error: 'name and data are required' });
        return;
      }
      if (id !== undefined && !UUID_RE.test(id)) {
        res.status(400).json({ error: 'bad id' });
        return;
      }
      if (id) {
        const rows = await sb('PATCH', `strategies?id=eq.${id}&fyers_id=eq.${uid}`,
          { name: name.trim(), data, updated_at: new Date().toISOString() },
          { Prefer: 'return=representation' });
        if (!rows || !rows.length) { res.status(404).json({ error: 'Not found' }); return; }
        res.status(200).json({ id });
        return;
      }
      const rows = await sb('POST', 'strategies', { fyers_id: user, name: name.trim(), data }, { Prefer: 'return=representation' });
      res.status(200).json({ id: rows[0].id });
      return;
    }
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!UUID_RE.test(id || '')) { res.status(400).json({ error: 'bad id' }); return; }
      await sb('DELETE', `strategies?id=eq.${id}&fyers_id=eq.${uid}`, undefined, { Prefer: 'return=minimal' });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
