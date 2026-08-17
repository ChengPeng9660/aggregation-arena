export const DEFAULT_PIECEWISE_ODDS_THRESHOLD = 5;

export function piecewiseOddsProbability(
  probabilities,
  threshold = DEFAULT_PIECEWISE_ODDS_THRESHOLD,
) {
  if (!Array.isArray(probabilities) || probabilities.length !== 2) {
    throw new Error("Piecewise Odds Pool requires exactly two probabilities");
  }
  if (!Number.isFinite(threshold) || threshold <= 1) {
    throw new Error("Piecewise Odds Pool threshold must be greater than 1");
  }
  const [first, second] = probabilities;
  if (![first, second].every((probability) =>
    Number.isFinite(probability) && probability >= 0 && probability <= 1
  )) {
    throw new Error("Piecewise Odds Pool probabilities must be between 0 and 1");
  }

  const combinedLogOdds = logit(first) + logit(second);
  const boundary = Math.log(threshold);
  const pooledLogOdds = combinedLogOdds <= -boundary
    ? combinedLogOdds + boundary / 2
    : combinedLogOdds >= boundary
      ? combinedLogOdds - boundary / 2
      : combinedLogOdds / 2;
  return logistic(pooledLogOdds);
}

function logit(value) {
  const clipped = Math.min(0.999, Math.max(0.001, value));
  return Math.log(clipped / (1 - clipped));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}
