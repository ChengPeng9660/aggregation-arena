export const clampProbability = value => Math.min(0.999, Math.max(0.001, Number(value)));

export function mean(values) {
  if (!values.length) throw new Error("At least one forecast is required");
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

export function median(values) {
  if (!values.length) throw new Error("At least one forecast is required");
  const sorted = values.map(Number).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function trimmedMean(values, trimShare = 0.1) {
  if (values.length < 5) return mean(values);
  const sorted = values.map(Number).sort((a, b) => a - b);
  const trim = Math.max(1, Math.floor(sorted.length * trimShare));
  return mean(sorted.slice(trim, sorted.length - trim));
}

export function logitPool(values, weights = []) {
  if (!values.length) throw new Error("At least one forecast is required");
  const normalizedWeights = weights.length === values.length ? weights : values.map(() => 1);
  const weightTotal = normalizedWeights.reduce((sum, value) => sum + value, 0) || 1;
  const pooledLogit = values.reduce((sum, value, index) => {
    const p = clampProbability(value);
    return sum + normalizedWeights[index] * Math.log(p / (1 - p));
  }, 0) / weightTotal;
  return 1 / (1 + Math.exp(-pooledLogit));
}

export function weightedMean(values, weights) {
  if (!values.length || values.length !== weights.length) throw new Error("Forecast and weight counts must match");
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
}

export function brier(probability, outcome) {
  return (Number(probability) - Number(outcome)) ** 2;
}

export function buildAggregates(forecasts, marketProbability, performanceWeights = {}) {
  const values = forecasts.map(item => clampProbability(item.probability_yes));
  if (!values.length) return [];
  const ids = forecasts.map(item => item.participant_id);
  const weights = ids.map(id => Number(performanceWeights[id] || 1));
  const simpleMean = mean(values);
  const market = Number.isFinite(Number(marketProbability)) ? clampProbability(marketProbability) : null;
  const components = JSON.stringify(ids);
  const rows = [
    { participant_id: "equal-mean", participant_name: "Equal Probability Mean", probability_yes: simpleMean, track: "model", version: "v1", components_json: components },
    { participant_id: "median-forecast", participant_name: "Median Forecast", probability_yes: median(values), track: "model", version: "v1", components_json: components },
    { participant_id: "trimmed-mean", participant_name: "Trimmed Mean", probability_yes: trimmedMean(values), track: "model", version: "v1", components_json: components },
    { participant_id: "adaptive-logit-pool", participant_name: "Adaptive Logit Pool", probability_yes: logitPool(values, weights), track: "model", version: "v1", components_json: components },
    { participant_id: "performance-weighted", participant_name: "Performance Weighted", probability_yes: weightedMean(values, weights), track: "model", version: "v1", components_json: components }
  ];
  if (market !== null) rows.push({
    participant_id: "market-calibrated-stack",
    participant_name: "Market-Calibrated Stack",
    probability_yes: 0.75 * weightedMean(values, weights) + 0.25 * market,
    track: "market",
    version: "v1",
    components_json: JSON.stringify([...ids, "polymarket"])
  });
  return rows.map(row => ({ ...row, probability_yes: clampProbability(row.probability_yes) }));
}
