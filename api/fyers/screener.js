// api/fyers/screener.js
// High-IV screener: filters the 210 F&O stocks to ones down >=30% over the
// past 6 months, ranked by realized-volatility percentile -- a proxy for
// IV Rank, since true options IV Rank needs a year of accumulated daily IV
// history this project has no way to build (no DB, no cron). See
// docs/superpowers/specs/2026-09-18-hiv-stocks-screener-design.md.
const ROLLING_WINDOW = 20; // trading days per realized-vol window
const MIN_CANDLES = ROLLING_WINDOW + 20; // need >=20 rolling-vol points to rank against
const ANNUALIZATION_FACTOR = Math.sqrt(252);
const SIX_MONTH_SECONDS = 182 * 24 * 60 * 60;

// candles: [[unixTs, open, high, low, close, volume], ...] ascending by time.
function sixMonthChangePct(candles) {
  if (!candles || candles.length < 2) return null;
  const latest = candles[candles.length - 1];
  const targetTs = latest[0] - SIX_MONTH_SECONDS;

  let closest = candles[0];
  let closestDiff = Math.abs(candles[0][0] - targetTs);
  for (const c of candles) {
    const diff = Math.abs(c[0] - targetTs);
    if (diff < closestDiff) { closest = c; closestDiff = diff; }
  }

  const baseClose = closest[4];
  const latestClose = latest[4];
  if (!baseClose) return null;
  return ((latestClose - baseClose) / baseClose) * 100;
}

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function volRank(candles) {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const closes = candles.map((c) => c[4]);
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const rollingVols = [];
  for (let i = ROLLING_WINDOW - 1; i < logReturns.length; i++) {
    const window = logReturns.slice(i - ROLLING_WINDOW + 1, i + 1);
    rollingVols.push(stdev(window) * ANNUALIZATION_FACTOR);
  }
  if (rollingVols.length < 20) return null;

  const todayVol = rollingVols[rollingVols.length - 1];
  const countBelowOrEqual = rollingVols.filter((v) => v <= todayVol).length;
  return (countBelowOrEqual / rollingVols.length) * 100;
}

module.exports = {};
module.exports.sixMonthChangePct = sixMonthChangePct;
module.exports.volRank = volRank;
