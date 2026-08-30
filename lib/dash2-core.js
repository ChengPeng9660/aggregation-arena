import { DEFAULT_CPTEC_WEIGHT, cptecProbability } from "./cptec-core.js";
import { piecewiseOddsProbability } from "./piecewise-odds-core.js";

export const DASH2_EXPERTS = [
  "model-a",
  "model-b",
  "equal-mean",
  "log-odds-pool",
  "cptec-history-best",
  "piecewise-odds-pool",
  "dependence-adaptive-safemix-2",
];

export function createDash2State() {
  return { expertLossSum: DASH2_EXPERTS.map(() => 0), nFeedback: 0 };
}

export function learningRate(n, expertCount) {
  return Math.sqrt(8 * Math.log(expertCount) / Math.max(1, n));
}

export function exponentialWeights(lossSum, n) {
  if (!Array.isArray(lossSum) || lossSum.length === 0 || lossSum.some((value) => !Number.isFinite(value))) {
    throw new Error("DASH-2 requires finite cumulative expert losses");
  }
  const eta = learningRate(n, lossSum.length);
  const scores = lossSum.map((loss) => -eta * loss);
  const maximum = Math.max(...scores);
  const unnormalized = scores.map((score) => Math.exp(score - maximum));
  const total = unnormalized.reduce((sum, value) => sum + value, 0);
  return unnormalized.map((value) => value / total);
}

/**
 * Produce one pair forecast. This function intentionally has no outcome argument:
 * all values are fixed before the current forecast date is scored.
 * @param {{ historyBestSide: "a" | "b", safeAlpha: number } | null} priorParameters
 */
export function forecastDash2Pair(first, second, state, priorParameters = null) {
  if (![first, second].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("DASH-2 probabilities must be between 0 and 1");
  }
  if (!state || state.expertLossSum?.length !== DASH2_EXPERTS.length || !Number.isInteger(state.nFeedback) || state.nFeedback < 0) {
    throw new Error("Invalid DASH-2 state");
  }
  if (priorParameters && (priorParameters.historyBestSide !== "a" && priorParameters.historyBestSide !== "b")) {
    throw new Error("DASH-2 history-best side must be a or b");
  }
  if (priorParameters && (!Number.isFinite(priorParameters.safeAlpha) || priorParameters.safeAlpha < 0 || priorParameters.safeAlpha > 1)) {
    throw new Error("DASH-2 SafeMix alpha must be between 0 and 1");
  }

  const equalMean = (first + second) / 2;
  const logOddsPool = logistic((logit(first) + logit(second)) / 2);
  const historyBestSide = priorParameters?.historyBestSide
    ?? (state.expertLossSum[0] <= state.expertLossSum[1] ? "a" : "b");
  const historyBest = historyBestSide === "a" ? first : second;
  const historyOther = historyBestSide === "a" ? second : first;
  const cptecHistoryBest = cptecProbability([historyBest, historyOther], DEFAULT_CPTEC_WEIGHT);
  const piecewiseOdds = piecewiseOddsProbability([first, second]);
  const modelWeights = exponentialWeights(state.expertLossSum.slice(0, 2), state.nFeedback);
  const twoModelHedge = modelWeights[0] * first + modelWeights[1] * second;
  const safeMix = priorParameters
    ? (1 - priorParameters.safeAlpha) * historyBest + priorParameters.safeAlpha * twoModelHedge
    : equalMean;
  const expertPredictions = [
    first,
    second,
    equalMean,
    logOddsPool,
    cptecHistoryBest,
    piecewiseOdds,
    safeMix,
  ];
  const metaWeights = exponentialWeights(state.expertLossSum, state.nFeedback);
  const dashHedge = expertPredictions.reduce(
    (sum, prediction, index) => sum + prediction * metaWeights[index],
    0,
  );
  return {
    dashHedge,
    safeMix,
    expertPredictions,
    metaWeights,
    modelWeights,
    historyBestSide,
    supported: priorParameters !== null,
  };
}

/** Update only after every prediction for a forecast date has been frozen. */
export function updateDash2State(state, expertPredictionsByEvent, outcomes) {
  if (!Array.isArray(expertPredictionsByEvent) || !Array.isArray(outcomes) || expertPredictionsByEvent.length !== outcomes.length) {
    throw new Error("DASH-2 feedback must align with frozen predictions");
  }
  const nextLoss = [...state.expertLossSum];
  for (let row = 0; row < outcomes.length; row += 1) {
    const outcome = outcomes[row];
    const predictions = expertPredictionsByEvent[row];
    if ((outcome !== 0 && outcome !== 1) || !Array.isArray(predictions) || predictions.length !== DASH2_EXPERTS.length) {
      throw new Error("Invalid DASH-2 feedback row");
    }
    for (let index = 0; index < predictions.length; index += 1) {
      nextLoss[index] += (predictions[index] - outcome) ** 2;
    }
  }
  return { expertLossSum: nextLoss, nFeedback: state.nFeedback + outcomes.length };
}

function logit(value) {
  const clipped = Math.min(0.999, Math.max(0.001, value));
  return Math.log(clipped / (1 - clipped));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}
