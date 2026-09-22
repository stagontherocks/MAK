// Standalone Black-Scholes pricer + implied-vol solver, used by
// option-chain.js to derive delta -- Fyers' options-chain-v3 response has no
// IV/greeks field at all (confirmed against their own API, a long-standing
// unfulfilled feature request on their forums), so delta has to be computed
// from the market ltp Fyers does give us.
//
// Risk-free rate is a fixed assumption (India ~6.5% short-term G-Sec/T-bill
// yield) rather than a live rate feed -- delta is not sensitive enough to
// small r moves to justify wiring up a rate source for this.
const RISK_FREE_RATE = 0.065;

// Minimum time-to-expiry floor (in years) so same-day (0d) expiries don't
// divide by ~0. At this floor, deep ITM/OTM strikes correctly settle near
// delta +-1/0 since d1 blows up as T->0 for any strike away from spot.
const MIN_T_YEARS = 1 / (365 * 24 * 60);

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation, ~1e-7 max error -- plenty for
  // a delta display, no need for an erf library dependency.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function d1d2(isCall, S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2 };
}

function bsPrice(isCall, S, K, T, r, sigma) {
  const { d1, d2 } = d1d2(isCall, S, K, T, r, sigma);
  const disc = Math.exp(-r * T);
  return isCall
    ? S * normCdf(d1) - K * disc * normCdf(d2)
    : K * disc * normCdf(-d2) - S * normCdf(-d1);
}

// Bisection over a wide vol range rather than Newton-Raphson: robust near
// the boundaries (deep ITM/OTM prices are nearly flat in vega, which makes
// Newton unstable) and simple enough not to need a derivative.
function impliedVol(isCall, price, S, K, T, r) {
  const intrinsic = isCall ? Math.max(S - K * Math.exp(-r * T), 0) : Math.max(K * Math.exp(-r * T) - S, 0);
  if (price <= intrinsic) return null; // below intrinsic value -- stale/crossed quote, no valid IV
  let lo = 0.001, hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(isCall, S, K, T, r, mid);
    if (p > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function computeDelta(isCall, S, K, expiryUnixSeconds, r, priceOverride) {
  const nowSeconds = Date.now() / 1000;
  const T = Math.max((expiryUnixSeconds - nowSeconds) / (365 * 24 * 3600), MIN_T_YEARS);
  const rate = r === undefined ? RISK_FREE_RATE : r;
  const sigma = impliedVol(isCall, priceOverride, S, K, T, rate);
  // No solvable IV means the quoted price is at/below intrinsic value -- most
  // common for deep ITM/OTM strikes right at expiry, where time value is ~0
  // and bid/ask noise can push the quote a hair under intrinsic. That's
  // exactly the regime where delta is most confidently +-1/0 by moneyness,
  // so fall back to the intrinsic-value limit instead of surfacing null.
  if (sigma === null) {
    if (isCall) return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const { d1 } = d1d2(isCall, S, K, T, rate, sigma);
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}

module.exports = { normCdf, bsPrice, impliedVol, computeDelta, RISK_FREE_RATE, MIN_T_YEARS };
