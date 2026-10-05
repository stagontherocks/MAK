// Single serverless function for both stores (Vercel's Hobby plan caps a
// deployment at 12 functions, and the repo is at that cap). The handlers
// live in the underscore-prefixed files, which Vercel does not deploy as
// functions of their own. Clients call /api/store?kind=watchlist|strategies.
const watchlist = require('./_watchlist');
const strategies = require('./_strategies');

module.exports = async (req, res) => {
  const kind = req.query && req.query.kind;
  if (kind === 'watchlist') return watchlist(req, res);
  if (kind === 'strategies') return strategies(req, res);
  res.status(400).json({ error: 'kind must be watchlist or strategies' });
};
