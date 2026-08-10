export const DEFAULT_CPTEC_WEIGHT = 0.56;

export function cptecProbability(probabilities, weight = DEFAULT_CPTEC_WEIGHT) {
  if (!Array.isArray(probabilities) || probabilities.length !== 2) {
    throw new Error("CPTEC requires exactly two probabilities");
  }
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("CPTEC weight must be between 0 and 1");
  }
  const [first, second] = probabilities;
  if (![first, second].every((probability) => Number.isFinite(probability) && probability >= 0 && probability <= 1)) {
    throw new Error("CPTEC probabilities must be between 0 and 1");
  }
  return logistic(weight * logit(first) + (1 - weight) * logit(second));
}

function logit(value) {
  const clipped = Math.min(0.999, Math.max(0.001, value));
  return Math.log(clipped / (1 - clipped));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}
