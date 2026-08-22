#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDash2State,
  exponentialWeights,
  forecastDash2Pair,
  updateDash2State,
} from "../lib/dash2-core.js";

const DEFAULT_HISTORY = "public/forecastbench/history.json";
const DEFAULT_PARAMETERS = "public/forecastbench/dash2-history.json";
const DEFAULT_OUTPUT = "output/research/quality-aware-dash-exploration-2026-08-23.json";
const BASE_METHODS = ["no-dependence-4", "two-model-hedge", "full-7", "core-5"];
const RIDGE_LAMBDAS = [0, 1, 5, 10, 15, 20, 30, 50, 100, 500];
const RIDGE_DISCOUNTS = [1, 0.95, 0.8];
const AFFINE_LAMBDAS = [1, 5, 20, 100, 500];
const AFFINE_DISCOUNTS = [1, 0.95, 0.8, 0.5];
const CALIBRATION_LAMBDAS = [1, 5, 20, 100];
const CALIBRATION_DISCOUNTS = [1, 0.95, 0.8, 0.5];
const VARIANT_EXPERTS = {
  "no-dependence-4": ["model-a", "model-b", "two-model-hedge", "cptec"],
  "core-5": ["model-a", "model-b", "two-model-hedge", "safemix-2", "cptec"],
};
const SHRINK_SLOPES = [0.8, 0.9, 0.95, 1, 1.025, 1.05, 1.075, 1.1];
const SOTA_BASELINES = ["no-dependence-4", "two-model-hedge", "full-7", "core-5"];
const SELECTOR_EXPERTS = [
  "no-dependence-4",
  "no-dependence-shrink-1.025",
  "no-dependence-shrink-1.05",
  "ridge-linear-10",
  "ridge-linear-20",
  "qgate-q0.4-r20-s1.05",
  "qgate-q0.4-r30-s1.025",
];
const AFFINE_DIAGNOSTIC_METHODS = new Set([
  "ridge-affine-d0.95-l1",
  "ridge-affine-d0.95-l5",
  "ridge-affine-5",
]);

function parseArgs(argv) {
  const args = { history: DEFAULT_HISTORY, parameters: DEFAULT_PARAMETERS, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--history") args.history = argv[++index];
    else if (flag === "--parameters") args.parameters = argv[++index];
    else if (flag === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function pairKey(first, second) {
  return `${first}\u0000${second}`;
}

function brier(probability, outcome) {
  return (probability - outcome) ** 2;
}

function clampProbability(probability) {
  return Math.min(1, Math.max(0, probability));
}

function shrinkProbability(probability, slope) {
  return clampProbability(0.5 + slope * (probability - 0.5));
}

function ridgeLinearWeight(stats, lambda) {
  return Math.min(1, Math.max(0, (stats.differenceResidual + 0.5 * lambda) / (stats.differenceSquared + lambda)));
}

function ridgeMethodId(discount, lambda) {
  return discount === 1 ? `ridge-linear-${lambda}` : `ridge-linear-d${discount}-l${lambda}`;
}

function solveThreeByThree(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) return [0, 0.5, 0.5];
    for (let entry = column; entry < 4; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry < 4; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[3]);
}

function ridgeAffineCoefficients(stats, lambda) {
  const prior = [0, 0.5, 0.5];
  const matrix = stats.xtx.map((row, index) => row.map((value, column) => value + (index === column ? lambda : 0)));
  const vector = stats.xty.map((value, index) => value + lambda * prior[index]);
  return solveThreeByThree(matrix, vector);
}

function affineMethodId(discount, lambda) {
  return discount === 1 ? `ridge-affine-${lambda}` : `ridge-affine-d${discount}-l${lambda}`;
}

function ridgeCalibrationCoefficients(stats, lambda) {
  const a00 = stats.n + lambda;
  const a01 = stats.sumPrediction;
  const a11 = stats.sumPredictionSquared + lambda;
  const b0 = stats.sumOutcome;
  const b1 = stats.sumPredictionOutcome + lambda;
  const determinant = a00 * a11 - a01 * a01;
  if (Math.abs(determinant) < 1e-12) return [0, 1];
  return [
    (b0 * a11 - b1 * a01) / determinant,
    (a00 * b1 - a01 * b0) / determinant,
  ];
}

function calibrationMethodId(discount, lambda) {
  return discount === 1 ? `calibrated-no-dependence-${lambda}` : `calibrated-no-dependence-d${discount}-l${lambda}`;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function createMetaState(expertCount) {
  return { expertLossSum: Array(expertCount).fill(0), nFeedback: 0 };
}

function metaPrediction(predictions, state) {
  const weights = exponentialWeights(state.expertLossSum, state.nFeedback);
  return predictions.reduce((sum, prediction, index) => sum + prediction * weights[index], 0);
}

function updateMetaState(state, predictionsByEvent, outcomes) {
  const nextLoss = [...state.expertLossSum];
  for (let row = 0; row < outcomes.length; row += 1) {
    for (let index = 0; index < nextLoss.length; index += 1) {
      nextLoss[index] += brier(predictionsByEvent[row][index], outcomes[row]);
    }
  }
  return { expertLossSum: nextLoss, nFeedback: state.nFeedback + outcomes.length };
}

function variantVector(id, baseForecast, first, second) {
  const values = {
    "model-a": first,
    "model-b": second,
    "two-model-hedge": baseForecast.modelWeights[0] * first + baseForecast.modelWeights[1] * second,
    cptec: baseForecast.expertPredictions[4],
    "safemix-2": baseForecast.expertPredictions[6],
  };
  return VARIANT_EXPERTS[id].map((expert) => values[expert]);
}

function methodVector(basePredictions, includeShrinkExperts) {
  const predictions = BASE_METHODS.map((method) => basePredictions[method]);
  if (includeShrinkExperts) {
    for (const slope of SHRINK_SLOPES) predictions.push(shrinkProbability(basePredictions["no-dependence-4"], slope));
  }
  return predictions;
}

function expertNames(includeShrinkExperts) {
  return includeShrinkExperts
    ? [...BASE_METHODS, ...SHRINK_SLOPES.map((slope) => `no-dependence-shrink-${slope}`)]
    : [...BASE_METHODS];
}

function customWeights(state, etaScale) {
  const eta = etaScale * Math.sqrt(8 * Math.log(state.expertLossSum.length) / Math.max(1, state.nFeedback));
  const scores = state.expertLossSum.map((loss) => -eta * loss);
  const maximum = Math.max(...scores);
  const unnormalized = scores.map((score) => Math.exp(score - maximum));
  const total = unnormalized.reduce((sum, value) => sum + value, 0);
  return unnormalized.map((value) => value / total);
}

function strategyPrediction(predictions, state, etaScale) {
  const weights = customWeights(state, etaScale);
  return predictions.reduce((sum, prediction, index) => sum + prediction * weights[index], 0);
}

function updateStrategyState(state, predictionsByEvent, outcomes, discount) {
  const nextLoss = state.expertLossSum.map((loss) => loss * discount);
  let nextFeedback = state.nFeedback * discount;
  for (let row = 0; row < outcomes.length; row += 1) {
    for (let index = 0; index < nextLoss.length; index += 1) {
      nextLoss[index] += brier(predictionsByEvent[row][index], outcomes[row]);
    }
    nextFeedback += 1;
  }
  return { expertLossSum: nextLoss, nFeedback: nextFeedback };
}

function rollingThresholds(priorQualities, bucketCount) {
  if (bucketCount === 1 || priorQualities.length < bucketCount) return [];
  const sorted = [...priorQualities].sort((first, second) => first - second);
  return Array.from({ length: bucketCount - 1 }, (_, index) => quantile(sorted, (index + 1) / bucketCount));
}

function bucketIndex(quality, thresholds) {
  let index = 0;
  while (index < thresholds.length && quality > thresholds[index]) index += 1;
  return index;
}

function addLoss(aggregate, method, value) {
  aggregate.loss[method] = (aggregate.loss[method] ?? 0) + value;
}

function summarizeAggregate(aggregate) {
  return Object.fromEntries(Object.entries(aggregate.loss).map(([method, loss]) => [method, loss / aggregate.n]));
}

async function buildFrozenCells(history, parameters) {
  const parametersByPair = new Map();
  for (const [date, historyLastDate, modelA, modelB, nHistory, nHistoryDates, historyBestSide, safeAlpha] of parameters.records) {
    if (historyLastDate >= date) throw new Error(`Non-prior parameter row for ${modelA} / ${modelB} on ${date}`);
    const key = pairKey(modelA, modelB);
    if (!parametersByPair.has(key)) parametersByPair.set(key, new Map());
    parametersByPair.get(key).set(date, { historyBestSide, safeAlpha, historyLastDate, nHistory, nHistoryDates });
  }

  const cellsByDate = new Map();
  const affineDiagnostics = new Map([...AFFINE_DIAGNOSTIC_METHODS].map((method) => [method, {
    cells: 0,
    predictions: 0,
    clippedLow: 0,
    clippedHigh: 0,
    coefficients: [[], [], []],
  }]));
  for (const [key, pairParameters] of parametersByPair) {
    const [modelA, modelB] = key.split("\u0000");
    const eventsByDate = new Map();
    for (const event of history.events) {
      if (event.forecasts[modelA] === undefined || event.forecasts[modelB] === undefined) continue;
      if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
      eventsByDate.get(event.date).push(event);
    }

    let fullState = createDash2State();
    let noDependenceState = createMetaState(VARIANT_EXPERTS["no-dependence-4"].length);
    let coreState = createMetaState(VARIANT_EXPERTS["core-5"].length);
    const ridgeStats = new Map(RIDGE_DISCOUNTS.map((discount) => [discount, { differenceResidual: 0, differenceSquared: 0 }]));
    const affineStats = new Map(AFFINE_DISCOUNTS.map((discount) => [discount, {
      xtx: Array.from({ length: 3 }, () => Array(3).fill(0)),
      xty: Array(3).fill(0),
    }]));
    const calibrationStats = new Map(CALIBRATION_DISCOUNTS.map((discount) => [discount, {
      n: 0,
      sumPrediction: 0,
      sumPredictionSquared: 0,
      sumOutcome: 0,
      sumPredictionOutcome: 0,
    }]));

    for (const date of [...eventsByDate.keys()].sort()) {
      const round = eventsByDate.get(date);
      const priorParameters = pairParameters.get(date) ?? null;
      const fullVectors = [];
      const noDependenceVectors = [];
      const coreVectors = [];
      const outcomes = [];
      const noDependencePredictions = [];
      const ridgeWeights = new Map(RIDGE_DISCOUNTS.map((discount) => [discount, Object.fromEntries(
        RIDGE_LAMBDAS.map((lambda) => [lambda, ridgeLinearWeight(ridgeStats.get(discount), lambda)]),
      )]));
      const affineCoefficients = new Map(AFFINE_DISCOUNTS.map((discount) => [discount, Object.fromEntries(
        AFFINE_LAMBDAS.map((lambda) => [lambda, ridgeAffineCoefficients(affineStats.get(discount), lambda)]),
      )]));
      const calibrationCoefficients = new Map(CALIBRATION_DISCOUNTS.map((discount) => [discount, Object.fromEntries(
        CALIBRATION_LAMBDAS.map((lambda) => [lambda, ridgeCalibrationCoefficients(calibrationStats.get(discount), lambda)]),
      )]));
      const cell = priorParameters ? {
        id: `${key}\u0000${date}`,
        pair: key,
        date,
        priorQuality: Math.min(fullState.expertLossSum[0], fullState.expertLossSum[1]) / fullState.nFeedback,
        priorQualityGap: Math.abs(fullState.expertLossSum[0] - fullState.expertLossSum[1]) / fullState.nFeedback,
        safeAlpha: priorParameters.safeAlpha,
        nHistory: priorParameters.nHistory,
        nHistoryDates: priorParameters.nHistoryDates,
        ridgeWeights: Object.fromEntries(RIDGE_DISCOUNTS.flatMap((discount) => RIDGE_LAMBDAS.map((lambda) => [
          ridgeMethodId(discount, lambda),
          ridgeWeights.get(discount)[lambda],
        ]))),
        affineCoefficients: Object.fromEntries(AFFINE_DISCOUNTS.flatMap((discount) => AFFINE_LAMBDAS.map((lambda) => [
          affineMethodId(discount, lambda),
          affineCoefficients.get(discount)[lambda],
        ]))),
        calibrationCoefficients: Object.fromEntries(CALIBRATION_DISCOUNTS.flatMap((discount) => CALIBRATION_LAMBDAS.map((lambda) => [
          calibrationMethodId(discount, lambda),
          calibrationCoefficients.get(discount)[lambda],
        ]))),
        rows: [],
      } : null;
      if (cell) {
        for (const discount of AFFINE_DISCOUNTS) {
          for (const lambda of AFFINE_LAMBDAS) {
            const method = affineMethodId(discount, lambda);
            if (!AFFINE_DIAGNOSTIC_METHODS.has(method)) continue;
            const diagnostic = affineDiagnostics.get(method);
            diagnostic.cells += 1;
            const coefficients = affineCoefficients.get(discount)[lambda];
            for (let index = 0; index < 3; index += 1) diagnostic.coefficients[index].push(coefficients[index]);
          }
        }
      }

      for (const event of round) {
        const first = event.forecasts[modelA];
        const second = event.forecasts[modelB];
        const baseForecast = forecastDash2Pair(first, second, fullState, priorParameters);
        const noDependenceVector = variantVector("no-dependence-4", baseForecast, first, second);
        const coreVector = variantVector("core-5", baseForecast, first, second);
        const basePredictions = {
          "full-7": baseForecast.dashHedge,
          "two-model-hedge": baseForecast.modelWeights[0] * first + baseForecast.modelWeights[1] * second,
          "no-dependence-4": metaPrediction(noDependenceVector, noDependenceState),
          "core-5": metaPrediction(coreVector, coreState),
          "historical-best": priorParameters?.historyBestSide === "b" ? second : first,
        };
        noDependencePredictions.push(basePredictions["no-dependence-4"]);
        for (const discount of AFFINE_DISCOUNTS) {
          for (const lambda of AFFINE_LAMBDAS) {
            const coefficients = affineCoefficients.get(discount)[lambda];
            const method = affineMethodId(discount, lambda);
            const rawPrediction = coefficients[0] + coefficients[1] * first + coefficients[2] * second;
            if (cell && AFFINE_DIAGNOSTIC_METHODS.has(method)) {
              const diagnostic = affineDiagnostics.get(method);
              diagnostic.predictions += 1;
              if (rawPrediction < 0) diagnostic.clippedLow += 1;
              else if (rawPrediction > 1) diagnostic.clippedHigh += 1;
            }
          }
        }
        if (cell) cell.rows.push({ outcome: event.outcome, first, second, basePredictions });
        fullVectors.push(baseForecast.expertPredictions);
        noDependenceVectors.push(noDependenceVector);
        coreVectors.push(coreVector);
        outcomes.push(event.outcome);
      }

      if (cell) {
        if (!cellsByDate.has(date)) cellsByDate.set(date, []);
        cellsByDate.get(date).push(cell);
      }
      fullState = updateDash2State(fullState, fullVectors, outcomes);
      noDependenceState = updateMetaState(noDependenceState, noDependenceVectors, outcomes);
      coreState = updateMetaState(coreState, coreVectors, outcomes);
      let roundDifferenceResidual = 0;
      let roundDifferenceSquared = 0;
      for (let index = 0; index < round.length; index += 1) {
        const difference = round[index].forecasts[modelA] - round[index].forecasts[modelB];
        roundDifferenceResidual += difference * (outcomes[index] - round[index].forecasts[modelB]);
        roundDifferenceSquared += difference ** 2;
      }
      for (const discount of RIDGE_DISCOUNTS) {
        const stats = ridgeStats.get(discount);
        stats.differenceResidual = discount * stats.differenceResidual + roundDifferenceResidual;
        stats.differenceSquared = discount * stats.differenceSquared + roundDifferenceSquared;
      }
      for (const discount of AFFINE_DISCOUNTS) {
        const stats = affineStats.get(discount);
        stats.xtx = stats.xtx.map((row) => row.map((value) => discount * value));
        stats.xty = stats.xty.map((value) => discount * value);
        for (let index = 0; index < round.length; index += 1) {
          const features = [1, round[index].forecasts[modelA], round[index].forecasts[modelB]];
          for (let firstIndex = 0; firstIndex < 3; firstIndex += 1) {
            stats.xty[firstIndex] += features[firstIndex] * outcomes[index];
            for (let secondIndex = 0; secondIndex < 3; secondIndex += 1) {
              stats.xtx[firstIndex][secondIndex] += features[firstIndex] * features[secondIndex];
            }
          }
        }
      }
      for (const discount of CALIBRATION_DISCOUNTS) {
        const stats = calibrationStats.get(discount);
        stats.n *= discount;
        stats.sumPrediction *= discount;
        stats.sumPredictionSquared *= discount;
        stats.sumOutcome *= discount;
        stats.sumPredictionOutcome *= discount;
        for (let index = 0; index < outcomes.length; index += 1) {
          const prediction = noDependencePredictions[index];
          stats.n += 1;
          stats.sumPrediction += prediction;
          stats.sumPredictionSquared += prediction ** 2;
          stats.sumOutcome += outcomes[index];
          stats.sumPredictionOutcome += prediction * outcomes[index];
        }
      }
    }
  }
  return {
    cellsByDate,
    affineDiagnostics: Object.fromEntries([...affineDiagnostics].map(([method, diagnostic]) => [method, {
      cells: diagnostic.cells,
      predictions: diagnostic.predictions,
      clippedLow: diagnostic.clippedLow,
      clippedHigh: diagnostic.clippedHigh,
      clippedFraction: (diagnostic.clippedLow + diagnostic.clippedHigh) / diagnostic.predictions,
      coefficientSummary: diagnostic.coefficients.map((values, index) => {
        const sorted = [...values].sort((first, second) => first - second);
        return {
          coefficient: ["intercept", "model-a", "model-b"][index],
          min: sorted[0],
          q05: quantile(sorted, 0.05),
          median: quantile(sorted, 0.5),
          q95: quantile(sorted, 0.95),
          max: sorted.at(-1),
        };
      }),
    }])),
  };
}

function strategyConfigs() {
  return [
    { id: "qas-b4-d1-e2-cal", bucketCount: 4, discount: 1, etaScale: 2, includeShrinkExperts: true },
    { id: "qas-b1-d0.95-e0.5-base", bucketCount: 1, discount: 0.95, etaScale: 0.5, includeShrinkExperts: false },
  ];
}

function gateConfigs() {
  const configs = [];
  for (const strongQuantile of [0.1, 0.2, 0.25, 0.3, 0.4]) {
    for (const ridgeLambda of [5, 10, 15, 20, 30, 50]) {
      for (const otherSlope of [1, 1.025, 1.05, 1.075]) {
        configs.push({
          id: `qgate-q${strongQuantile}-r${ridgeLambda}-s${otherSlope}`,
          family: "rolling-quality-gate",
          strongQuantile,
          ridgeLambda,
          otherSlope,
        });
      }
    }
  }
  for (const strongQuantile of [0.25, 0.4, 0.5]) {
    for (const strongMethod of ["no-dependence-4", "ridge-linear-20", "ridge-linear-30"]) {
      for (const otherMethod of [
        "ridge-affine-d0.95-l1",
        "ridge-affine-d0.95-l5",
        "ridge-affine-d0.8-l1",
        "ridge-affine-d0.8-l5",
        "ridge-affine-d0.5-l1",
        "ridge-affine-d0.5-l5",
        "ridge-affine-5",
      ]) {
        configs.push({
          id: `affine-gate-q${strongQuantile}-${strongMethod}-${otherMethod}`,
          family: "rolling-affine-quality-gate",
          strongQuantile,
          strongMethod,
          otherMethod,
        });
      }
    }
  }
  for (const strongQuantile of [0.25, 0.4, 0.5]) {
    for (const strongMethod of ["no-dependence-4", "ridge-linear-20", "ridge-linear-30"]) {
      for (const otherMethod of [
        "calibrated-no-dependence-d0.95-l1",
        "calibrated-no-dependence-d0.95-l5",
        "calibrated-no-dependence-d0.8-l1",
        "calibrated-no-dependence-d0.8-l5",
        "calibrated-no-dependence-d0.5-l1",
        "calibrated-no-dependence-d0.5-l5",
        "calibrated-no-dependence-5",
      ]) {
        configs.push({
          id: `calibration-gate-q${strongQuantile}-${strongMethod}-${otherMethod}`,
          family: "rolling-calibration-quality-gate",
          strongQuantile,
          strongMethod,
          otherMethod,
        });
      }
    }
  }
  return configs;
}

function selectorConfigs() {
  return [
    { id: "date-selector-ftl-1", family: "prior-date-selector", rule: "discounted-average", discount: 1 },
    { id: "date-selector-ftl-0.95", family: "prior-date-selector", rule: "discounted-average", discount: 0.95 },
    { id: "date-selector-ftl-0.8", family: "prior-date-selector", rule: "discounted-average", discount: 0.8 },
    { id: "date-selector-ftl-0.5", family: "prior-date-selector", rule: "discounted-average", discount: 0.5 },
    { id: "date-selector-last-winner", family: "prior-date-selector", rule: "last-winner" },
    { id: "date-selector-win-rate", family: "prior-date-selector", rule: "win-rate" },
    {
      id: "stack-selector-ftl-1",
      family: "prior-date-stack-selector",
      rule: "discounted-average",
      discount: 1,
      experts: [
        "no-dependence-4",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l5",
        "calibration-gate-q0.25-ridge-linear-20-calibrated-no-dependence-5",
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-5",
      ],
    },
    {
      id: "stack-selector-ftl-0.8",
      family: "prior-date-stack-selector",
      rule: "discounted-average",
      discount: 0.8,
      experts: [
        "no-dependence-4",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l5",
        "calibration-gate-q0.25-ridge-linear-20-calibrated-no-dependence-5",
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-5",
      ],
    },
    {
      id: "stack-selector-last-winner",
      family: "prior-date-stack-selector",
      rule: "last-winner",
      experts: [
        "no-dependence-4",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l5",
        "calibration-gate-q0.25-ridge-linear-20-calibrated-no-dependence-5",
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-5",
      ],
    },
  ];
}

function selectorExperts(config) {
  return config.experts ?? SELECTOR_EXPERTS;
}

function createSelectorState(experts) {
  return {
    loss: experts.map(() => 0),
    rounds: 0,
    wins: experts.map(() => 0),
    lastWinner: 0,
  };
}

function minimumIndex(values) {
  return values.reduce((best, value, index) => value < values[best] ? index : best, 0);
}

function selectedExpertIndex(config, state) {
  if (state.rounds === 0) return selectorExperts(config).indexOf("no-dependence-4");
  if (config.rule === "last-winner") return state.lastWinner;
  if (config.rule === "win-rate") {
    return state.wins.reduce((best, wins, index) => wins > state.wins[best]
      || (wins === state.wins[best] && state.loss[index] < state.loss[best]) ? index : best, 0);
  }
  return minimumIndex(state.loss);
}

function updateSelectorState(config, state, roundLoss, roundTargets) {
  const averageLoss = roundLoss.map((loss) => loss / roundTargets);
  const winner = minimumIndex(averageLoss);
  const discount = config.discount ?? 1;
  return {
    loss: state.loss.map((loss, index) => discount * loss + averageLoss[index]),
    rounds: discount * state.rounds + 1,
    wins: state.wins.map((wins, index) => wins + (index === winner ? 1 : 0)),
    lastWinner: winner,
  };
}

function ensureAggregate(container, key) {
  if (!container.has(key)) container.set(key, { n: 0, loss: {} });
  return container.get(key);
}

function addPredictionLoss(aggregates, predictions, outcome) {
  for (const aggregate of aggregates) aggregate.n += 1;
  for (const [method, prediction] of Object.entries(predictions)) {
    const loss = brier(prediction, outcome);
    for (const aggregate of aggregates) addLoss(aggregate, method, loss);
  }
}

function sotaRate(unitAggregates, method, tolerance = 0) {
  let sota = 0;
  let units = 0;
  let gainSum = 0;
  for (const aggregate of unitAggregates.values()) {
    if (!aggregate.n || aggregate.loss[method] === undefined) continue;
    const methodBrier = aggregate.loss[method] / aggregate.n;
    const baselineBest = Math.min(...SOTA_BASELINES.map((baseline) => aggregate.loss[baseline] / aggregate.n));
    gainSum += baselineBest - methodBrier;
    if (methodBrier <= baselineBest + tolerance + 1e-15) sota += 1;
    units += 1;
  }
  return { units, count: sota, rate: sota / units, meanGainVsBestBaseline: gainSum / units, tolerance };
}

function subsetAggregates(unitAggregates, keys) {
  return new Map([...unitAggregates].filter(([key]) => keys.has(key)));
}

function dateBlockBootstrap(dateAggregates, baseline, comparison, replicates = 20_000, seed = 20_260_823) {
  const dates = [...dateAggregates.keys()].sort();
  const random = mulberry32(seed);
  const differences = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let lossDifference = 0;
    let targets = 0;
    for (let draw = 0; draw < dates.length; draw += 1) {
      const aggregate = dateAggregates.get(dates[Math.floor(random() * dates.length)]);
      lossDifference += aggregate.loss[baseline] - aggregate.loss[comparison];
      targets += aggregate.n;
    }
    differences.push(lossDifference / targets);
  }
  differences.sort((first, second) => first - second);
  return {
    direction: `${baseline}_minus_${comparison}; positive means comparison is better`,
    estimate: [...dateAggregates.values()].reduce((sum, aggregate) => sum + aggregate.loss[baseline] - aggregate.loss[comparison], 0)
      / [...dateAggregates.values()].reduce((sum, aggregate) => sum + aggregate.n, 0),
    ci95: [quantile(differences, 0.025), quantile(differences, 0.975)],
    probabilityPositive: differences.filter((difference) => difference > 0).length / differences.length,
    replicates,
    seed,
  };
}

function pairComparison(pairAggregates, baseline, comparison) {
  const differences = [...pairAggregates.values()].map((aggregate) => (
    aggregate.loss[baseline] - aggregate.loss[comparison]
  ) / aggregate.n).sort((first, second) => first - second);
  return {
    pairs: differences.length,
    comparisonBetter: differences.filter((difference) => difference > 1e-15).length,
    comparisonWorse: differences.filter((difference) => difference < -1e-15).length,
    medianDifference: quantile(differences, 0.5),
    q25Difference: quantile(differences, 0.25),
    q75Difference: quantile(differences, 0.75),
  };
}

function evaluateStrategies(cellsByDate) {
  const metaConfigs = strategyConfigs();
  const gates = gateConfigs();
  const selectors = selectorConfigs();
  const strategies = new Map(metaConfigs.map((config) => [config.id, {
    config,
    states: Array.from({ length: config.bucketCount }, () => createMetaState(expertNames(config.includeShrinkExperts).length)),
  }]));
  const allCells = [...cellsByDate.values()].flat();
  const sortedCells = [...allCells].sort((first, second) => first.priorQuality - second.priorQuality || first.id.localeCompare(second.id));
  const q1Ids = new Set(sortedCells.slice(0, Math.floor(sortedCells.length / 4)).map((cell) => cell.id));
  const dates = [...cellsByDate.keys()].sort();
  const lateDates = new Set(dates.slice(Math.floor(dates.length / 2)));
  const earlyDates = new Set(dates.filter((date) => !lateDates.has(date)));
  const priorQualities = [];
  const aggregates = {
    overall: { n: 0, loss: {} },
    q1_strongest: { n: 0, loss: {} },
    late_half: { n: 0, loss: {} },
    q1_late_half: { n: 0, loss: {} },
    early_half: { n: 0, loss: {} },
    q1_early_half: { n: 0, loss: {} },
  };
  const dateAggregates = new Map();
  const q1DateAggregates = new Map();
  const pairAggregates = new Map();
  const q1PairAggregates = new Map();
  const selectorStates = new Map(selectors.map((selector) => [selector.id, createSelectorState(selectorExperts(selector))]));

  for (const date of dates) {
    const cells = cellsByDate.get(date);
    const thresholdsByBucketCount = new Map([1, 4].map((bucketCount) => [bucketCount, rollingThresholds(priorQualities, bucketCount)]));
    const sortedPriorQualities = [...priorQualities].sort((first, second) => first - second);
    const gateThresholds = new Map([...new Set(gates.map((gate) => gate.strongQuantile))]
      .map((probability) => [probability, sortedPriorQualities.length ? quantile(sortedPriorQualities, probability) : null]));
    const updates = new Map();
    const selectedExperts = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector)[selectedExpertIndex(selector, selectorStates.get(selector.id))]]));
    const selectorRoundLoss = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector).map(() => 0)]));
    let selectorRoundTargets = 0;
    for (const [id, strategy] of strategies) updates.set(id, Array.from({ length: strategy.config.bucketCount }, () => ({ vectors: [], outcomes: [] })));

    for (const cell of cells) {
      const isQ1 = q1Ids.has(cell.id);
      for (const row of cell.rows) {
        const predictions = { ...row.basePredictions };
        for (const [method, weight] of Object.entries(cell.ridgeWeights)) {
          predictions[method] = weight * row.first + (1 - weight) * row.second;
        }
        for (const [method, coefficients] of Object.entries(cell.affineCoefficients)) {
          predictions[method] = clampProbability(coefficients[0] + coefficients[1] * row.first + coefficients[2] * row.second);
        }
        for (const [method, coefficients] of Object.entries(cell.calibrationCoefficients)) {
          predictions[method] = clampProbability(coefficients[0] + coefficients[1] * row.basePredictions["no-dependence-4"]);
        }
        for (const slope of SHRINK_SLOPES) {
          predictions[`no-dependence-shrink-${slope}`] = shrinkProbability(row.basePredictions["no-dependence-4"], slope);
        }
        for (const gate of gates) {
          const threshold = gateThresholds.get(gate.strongQuantile);
          const strong = threshold !== null && cell.priorQuality <= threshold;
          predictions[gate.id] = gate.family === "rolling-affine-quality-gate" || gate.family === "rolling-calibration-quality-gate"
            ? predictions[strong ? gate.strongMethod : gate.otherMethod]
            : strong
              ? predictions[`ridge-linear-${gate.ridgeLambda}`]
              : shrinkProbability(row.basePredictions["no-dependence-4"], gate.otherSlope);
        }
        for (const [id, strategy] of strategies) {
          const thresholds = thresholdsByBucketCount.get(strategy.config.bucketCount);
          const bucket = bucketIndex(cell.priorQuality, thresholds);
          const vector = methodVector(row.basePredictions, strategy.config.includeShrinkExperts);
          predictions[id] = strategyPrediction(vector, strategy.states[bucket], strategy.config.etaScale);
          updates.get(id)[bucket].vectors.push(vector);
          updates.get(id)[bucket].outcomes.push(row.outcome);
        }
        for (const selector of selectors) {
          predictions[selector.id] = predictions[selectedExperts.get(selector.id)];
          const experts = selectorExperts(selector);
          for (let index = 0; index < experts.length; index += 1) {
            selectorRoundLoss.get(selector.id)[index] += brier(predictions[experts[index]], row.outcome);
          }
        }
        selectorRoundTargets += 1;
        const targets = [aggregates.overall, ensureAggregate(dateAggregates, date), ensureAggregate(pairAggregates, cell.pair)];
        if (isQ1) targets.push(aggregates.q1_strongest, ensureAggregate(q1DateAggregates, date), ensureAggregate(q1PairAggregates, cell.pair));
        if (lateDates.has(date)) targets.push(aggregates.late_half);
        if (isQ1 && lateDates.has(date)) targets.push(aggregates.q1_late_half);
        if (earlyDates.has(date)) targets.push(aggregates.early_half);
        if (isQ1 && earlyDates.has(date)) targets.push(aggregates.q1_early_half);
        addPredictionLoss(targets, predictions, row.outcome);
      }
    }

    for (const [id, strategy] of strategies) {
      const bucketUpdates = updates.get(id);
      strategy.states = strategy.states.map((state, index) => updateStrategyState(
        state,
        bucketUpdates[index].vectors,
        bucketUpdates[index].outcomes,
        strategy.config.discount,
      ));
    }
    for (const selector of selectors) {
      selectorStates.set(selector.id, updateSelectorState(selector, selectorStates.get(selector.id), selectorRoundLoss.get(selector.id), selectorRoundTargets));
    }
    priorQualities.push(...cells.map((cell) => cell.priorQuality));
  }

  const brierBySlice = Object.fromEntries(Object.entries(aggregates).map(([slice, aggregate]) => [slice, {
    targetEvaluations: aggregate.n,
    brier: summarizeAggregate(aggregate),
  }]));
  const configs = [...metaConfigs.map((config) => ({ ...config, family: "quality-specialist-hedge" })), ...gates, ...selectors];
  const earlyDateAggregates = subsetAggregates(dateAggregates, earlyDates);
  const lateDateAggregates = subsetAggregates(dateAggregates, lateDates);
  const q1EarlyDateAggregates = subsetAggregates(q1DateAggregates, earlyDates);
  const q1LateDateAggregates = subsetAggregates(q1DateAggregates, lateDates);
  const candidateRows = configs.map((config) => ({
    ...config,
    overallBrier: brierBySlice.overall.brier[config.id],
    q1Brier: brierBySlice.q1_strongest.brier[config.id],
    lateBrier: brierBySlice.late_half.brier[config.id],
    q1LateBrier: brierBySlice.q1_late_half.brier[config.id],
    earlyBrier: brierBySlice.early_half.brier[config.id],
    q1EarlyBrier: brierBySlice.q1_early_half.brier[config.id],
    overallGainVsNoDependence: brierBySlice.overall.brier["no-dependence-4"] - brierBySlice.overall.brier[config.id],
    q1GainVsNoDependence: brierBySlice.q1_strongest.brier["no-dependence-4"] - brierBySlice.q1_strongest.brier[config.id],
    dateSota: sotaRate(dateAggregates, config.id),
    dateNearSota: sotaRate(dateAggregates, config.id, 0.0001),
    q1DateSota: sotaRate(q1DateAggregates, config.id),
    q1DateNearSota: sotaRate(q1DateAggregates, config.id, 0.0001),
    pairSota: sotaRate(pairAggregates, config.id),
    q1PairSota: sotaRate(q1PairAggregates, config.id),
    earlyDateSota: sotaRate(earlyDateAggregates, config.id),
    lateDateSota: sotaRate(lateDateAggregates, config.id),
    q1EarlyDateSota: sotaRate(q1EarlyDateAggregates, config.id),
    q1LateDateSota: sotaRate(q1LateDateAggregates, config.id),
  }));
  candidateRows.sort((first, second) => first.overallBrier - second.overallBrier);
  const candidatesById = new Map(candidateRows.map((candidate) => [candidate.id, candidate]));
  const averageChampionId = "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1";
  const balancedRecommendationId = "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1";
  const staticMethods = Object.entries(brierBySlice.overall.brier)
    .filter(([method]) => !method.startsWith("qas-") && !method.startsWith("qgate-") && !method.startsWith("affine-gate-") && !method.startsWith("calibration-gate-"))
    .map(([method, overallBrier]) => ({
      method,
      overallBrier,
      q1Brier: brierBySlice.q1_strongest.brier[method],
      lateBrier: brierBySlice.late_half.brier[method],
      q1LateBrier: brierBySlice.q1_late_half.brier[method],
      earlyBrier: brierBySlice.early_half.brier[method],
      q1EarlyBrier: brierBySlice.q1_early_half.brier[method],
      dateSota: sotaRate(dateAggregates, method),
      q1DateSota: sotaRate(q1DateAggregates, method),
      pairSota: sotaRate(pairAggregates, method),
      q1PairSota: sotaRate(q1PairAggregates, method),
    }))
    .sort((first, second) => first.overallBrier - second.overallBrier);
  return {
    slices: brierBySlice,
    staticMethods,
    candidates: candidateRows,
    topOverall: candidateRows.slice(0, 15),
    topQ1: [...candidateRows].sort((first, second) => first.q1Brier - second.q1Brier).slice(0, 15),
    topDateSota: [...candidateRows].sort((first, second) => second.dateSota.rate - first.dateSota.rate || first.overallBrier - second.overallBrier).slice(0, 15),
    topQ1DateSota: [...candidateRows].sort((first, second) => second.q1DateSota.rate - first.q1DateSota.rate || first.q1Brier - second.q1Brier).slice(0, 15),
    selectedOnEarlyOverall: [...candidateRows].sort((first, second) => first.earlyBrier - second.earlyBrier).slice(0, 10),
    selectedOnEarlyQ1: [...candidateRows].sort((first, second) => first.q1EarlyBrier - second.q1EarlyBrier).slice(0, 10),
    researchRecommendation: {
      averageChampion: candidatesById.get(averageChampionId),
      balancedCandidate: candidatesById.get(balancedRecommendationId),
      selectionRule: "prefer the balanced candidate when both overall mean and strongest-quartile improvement are objectives",
      strongestQuartileDefinition: "bottom quartile of scored pair-date cells by the better constituent model's strictly-prior cumulative Raw Brier",
      sotaDefinition: `strictly lower Raw Brier than the best of: ${SOTA_BASELINES.join(", ")}`,
      deploymentStatus: "research candidate only; freeze before independent confirmatory evaluation",
    },
    finalistRobustness: Object.fromEntries([
      "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1",
      "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
      "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l5",
      "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
    ].map((method, index) => [method, {
      vsNoDependenceDateBootstrap: dateBlockBootstrap(dateAggregates, "no-dependence-4", method, 20_000, 20_260_823 + index),
      vsFull7DateBootstrap: dateBlockBootstrap(dateAggregates, "full-7", method, 20_000, 20_260_833 + index),
      q1VsNoDependenceDateBootstrap: dateBlockBootstrap(q1DateAggregates, "no-dependence-4", method, 20_000, 20_260_843 + index),
      pairComparisonVsNoDependence: pairComparison(pairAggregates, "no-dependence-4", method),
      q1PairComparisonVsNoDependence: pairComparison(q1PairAggregates, "no-dependence-4", method),
    }])),
    mechanismComparison: {
      affineMethod: "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
      calibrationControl: "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
      overallDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        20_000,
        20_260_853,
      ),
      lateDateBootstrap: dateBlockBootstrap(
        lateDateAggregates,
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        20_000,
        20_260_854,
      ),
      q1DateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
        20_000,
        20_260_855,
      ),
      pairComparison: pairComparison(
        pairAggregates,
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
      ),
      q1PairComparison: pairComparison(
        q1PairAggregates,
        "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
        "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
      ),
    },
    scoredPairDateCells: allCells.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyBytes = await readFile(args.history);
  const parameterBytes = await readFile(args.parameters);
  const history = JSON.parse(historyBytes);
  const parameters = JSON.parse(parameterBytes);
  const historySha256 = createHash("sha256").update(historyBytes).digest("hex");
  if (historySha256 !== parameters.history_sha256) throw new Error("History hash does not match published DASH parameters");
  if (!parameters.audit.all_history_dates_strictly_prior) throw new Error("Parameter audit does not guarantee strictly prior dates");

  const { cellsByDate, affineDiagnostics } = await buildFrozenCells(history, parameters);
  const summary = evaluateStrategies(cellsByDate);
  const result = {
    schemaVersion: "0.1.0-exploration",
    generatedAt: new Date().toISOString(),
    status: "post_hoc_candidate_search_not_independent_oos",
    protocol: {
      outcomeVisibility: "all forecasts on date t are frozen before any date-t outcome updates pair or cross-pair states",
      qualityFeature: "lower of the two pair-specific cumulative Raw Brier scores from strictly earlier forecast dates",
      rollingBuckets: "quality thresholds at date t use feature values from scored pair-date cells strictly before t",
      candidateSearchWarning: "candidate families and hyperparameters are compared on the same replay and must be frozen before confirmatory evaluation",
      metric: "target-weighted Raw Brier; difficulty-adjusted BI unavailable in this artifact",
    },
    audit: {
      sourceEvents: history.meta.events,
      sourceDates: history.meta.rounds,
      eligiblePairs: parameters.audit.unique_pairs,
      scoredPairDateCells: summary.scoredPairDateCells,
      scoredTargetEvaluations: summary.slices.overall.targetEvaluations,
      scoredDates: cellsByDate.size,
      allHistoryDatesStrictlyPrior: parameters.audit.all_history_dates_strictly_prior,
    },
    expertNames: {
      base: expertNames(false),
      calibrated: expertNames(true),
    },
    affineDiagnostics,
    ...summary,
  };
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    output: resolve(args.output),
    audit: result.audit,
    researchRecommendation: result.researchRecommendation,
    topOverall: result.topOverall.slice(0, 5).map(({ id, overallBrier, q1Brier, lateBrier }) => ({ id, overallBrier, q1Brier, lateBrier })),
    topQ1: result.topQ1.slice(0, 5).map(({ id, overallBrier, q1Brier, lateBrier }) => ({ id, overallBrier, q1Brier, lateBrier })),
  }, null, 2));
}

await main();
