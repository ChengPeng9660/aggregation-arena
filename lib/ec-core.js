export const DEFAULT_EC_WEIGHT = 0.56;

/**
 * Symmetric evidence combination for a two-forecast binary event.
 *
 * EC(w) = sigmoid(w * (logit(p1) + logit(p2))).
 */
export function evidenceCombinationProbability(probabilities, weight = DEFAULT_EC_WEIGHT) {
  if (!Array.isArray(probabilities) || probabilities.length !== 2) {
    throw new Error("EC requires exactly two probabilities");
  }
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error("EC weight must be positive");
  }
  const [first, second] = probabilities;
  if (![first, second].every((probability) =>
    Number.isFinite(probability) && probability >= 0 && probability <= 1
  )) {
    throw new Error("EC probabilities must be between 0 and 1");
  }
  return logistic(weight * (logit(first) + logit(second)));
}

function logit(value) {
  const clipped = Math.min(0.999, Math.max(0.001, value));
  return Math.log(clipped / (1 - clipped));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}
