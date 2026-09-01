// Server-to-server webhook Jainam calls with order/trade updates.
// No UI reads this yet -- just accept and log until order flow exists.
module.exports = async (req, res) => {
  console.log('Jainam postback received:', JSON.stringify(req.body));
  res.status(200).json({ status: 'ok' });
};
