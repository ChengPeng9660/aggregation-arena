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
const GROUP_AFFINE_LAMBDAS = [5, 20, 50, 100, 500];
const GROUP_AFFINE_DISCOUNTS = [1, 0.95];
const GROUP_AFFINE_FEATURES = ["sourceKey", "questionType"];
const GROUP_LINEAR_LAMBDAS = [5, 20, 50, 100, 500];
const GROUP_LINEAR_DISCOUNTS = [1, 0.95];
const GROUP_LOGIT_LAMBDAS = [5, 20, 50, 100];
const GROUP_LOGIT_DISCOUNT = 0.95;
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
const GROUP_AFFINE_DIAGNOSTIC_METHODS = new Set([
  "source-affine-d0.95-l50",
  "source-affine-d0.95-l100",
  "type-affine-d0.95-l20",
  "type-affine-d0.95-l50",
]);
const DEPENDENCE_RIDGE_CONFIGS = [
  ...[0, 5, 20].flatMap((ridgeLambda) => [0.5, 1, 1.5].map((alphaScale) => ({ ridgeLambda, alphaScale, alphaPower: 1 }))),
  ...[0, 20].flatMap((ridgeLambda) => [0.5, 2].map((alphaPower) => ({ ridgeLambda, alphaScale: 1, alphaPower }))),
];

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

function boundedLogit(probability) {
  const bounded = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(bounded / (1 - bounded));
}

function logistic(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function shrinkProbability(probability, slope) {
  return clampProbability(0.5 + slope * (probability - 0.5));
}

function ridgeLinearWeight(stats, lambda) {
  return Math.min(1, Math.max(0, (stats.differenceResidual + 0.5 * lambda) / (stats.differenceSquared + lambda)));
}

function ridgeLinearWeightWithPrior(stats, lambda, prior) {
  return Math.min(1, Math.max(0, (stats.differenceResidual + prior * lambda) / (stats.differenceSquared + lambda)));
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
  return ridgeAffineCoefficientsWithPrior(stats, lambda, prior);
}

function ridgeAffineCoefficientsWithPrior(stats, lambda, prior) {
  const matrix = stats.xtx.map((row, index) => row.map((value, column) => value + (index === column ? lambda : 0)));
  const vector = stats.xty.map((value, index) => value + lambda * prior[index]);
  return solveThreeByThree(matrix, vector);
}

function affineMethodId(discount, lambda) {
  return discount === 1 ? `ridge-affine-${lambda}` : `ridge-affine-d${discount}-l${lambda}`;
}

function groupAffineMethodId(feature, discount, lambda) {
  const group = feature === "sourceKey" ? "source" : "type";
  return discount === 1 ? `${group}-affine-${lambda}` : `${group}-affine-d${discount}-l${lambda}`;
}

function groupLinearMethodId(feature, discount, lambda) {
  const group = feature === "sourceKey" ? "source" : "type";
  return discount === 1 ? `${group}-linear-${lambda}` : `${group}-linear-d${discount}-l${lambda}`;
}

function groupLogitMethodId(feature, lambda) {
  const group = feature === "sourceKey" ? "source" : "type";
  return `${group}-logit-d${GROUP_LOGIT_DISCOUNT}-l${lambda}`;
}

function fitGroupedLogit(rows, lambda, prior, currentRoundIndex) {
  if (!rows.length) return [...prior];
  let coefficients = [...prior];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const hessian = Array.from({ length: 3 }, (_, row) => Array.from(
      { length: 3 },
      (_, column) => row === column ? lambda : 0,
    ));
    const gradient = coefficients.map((value, index) => -lambda * (value - prior[index]));
    for (const row of rows) {
      const features = [1, boundedLogit(row.first), boundedLogit(row.second)];
      const prediction = logistic(features.reduce((sum, feature, index) => sum + feature * coefficients[index], 0));
      const timeWeight = GROUP_LOGIT_DISCOUNT ** (currentRoundIndex - row.roundIndex);
      const varianceWeight = timeWeight * Math.max(1e-6, prediction * (1 - prediction));
      for (let firstIndex = 0; firstIndex < 3; firstIndex += 1) {
        gradient[firstIndex] += timeWeight * features[firstIndex] * (row.outcome - prediction);
        for (let secondIndex = 0; secondIndex < 3; secondIndex += 1) {
          hessian[firstIndex][secondIndex] += varianceWeight * features[firstIndex] * features[secondIndex];
        }
      }
    }
    const step = solveThreeByThree(hessian, gradient);
    coefficients = coefficients.map((value, index) => value + step[index]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return coefficients;
}

function createAffineStats() {
  return {
    xtx: Array.from({ length: 3 }, () => Array(3).fill(0)),
    xty: Array(3).fill(0),
  };
}

function discountAffineStats(stats, discount) {
  stats.xtx = stats.xtx.map((row) => row.map((value) => discount * value));
  stats.xty = stats.xty.map((value) => discount * value);
}

function updateAffineStats(stats, features, outcome) {
  for (let firstIndex = 0; firstIndex < 3; firstIndex += 1) {
    stats.xty[firstIndex] += features[firstIndex] * outcome;
    for (let secondIndex = 0; secondIndex < 3; secondIndex += 1) {
      stats.xtx[firstIndex][secondIndex] += features[firstIndex] * features[secondIndex];
    }
  }
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

function formatParameter(value) {
  return String(value).replace(".", "p");
}

function dependenceRidgeMethodId({ ridgeLambda, alphaScale, alphaPower }) {
  return `dependence-ridge-r${ridgeLambda}-s${formatParameter(alphaScale)}-p${formatParameter(alphaPower)}`;
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

function priorWeightedStrategyPrediction(predictions, state, etaScale, prior) {
  if (!prior || prior.length !== predictions.length || prior.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Pair-stack prior must contain one positive finite weight per expert");
  }
  const eta = etaScale * Math.sqrt(8 * Math.log(state.expertLossSum.length) / Math.max(1, state.nFeedback));
  const scores = state.expertLossSum.map((loss, index) => Math.log(prior[index]) - eta * loss);
  const maximum = Math.max(...scores);
  const unnormalized = scores.map((score) => Math.exp(score - maximum));
  const total = unnormalized.reduce((sum, value) => sum + value, 0);
  return predictions.reduce((sum, prediction, index) => sum + prediction * unnormalized[index] / total, 0);
}

function guardianPrediction(predictions, state, tolerance) {
  if (predictions.length !== 2 || state.expertLossSum.length !== 2) {
    throw new Error("Guardian requires exactly baseline and candidate experts");
  }
  if (state.nFeedback <= 0) return predictions[1];
  const candidateExcessLoss = (state.expertLossSum[1] - state.expertLossSum[0]) / state.nFeedback;
  return candidateExcessLoss <= tolerance ? predictions[1] : predictions[0];
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
  const affineDiagnostics = new Map([...AFFINE_DIAGNOSTIC_METHODS, ...GROUP_AFFINE_DIAGNOSTIC_METHODS].map((method) => [method, {
    cells: 0,
    fits: 0,
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
    const affineStats = new Map(AFFINE_DISCOUNTS.map((discount) => [discount, createAffineStats()]));
    const groupAffineStats = new Map(GROUP_AFFINE_FEATURES.map((feature) => [feature, new Map(
      GROUP_AFFINE_DISCOUNTS.map((discount) => [discount, new Map()]),
    )]));
    const groupLinearStats = new Map(GROUP_AFFINE_FEATURES.map((feature) => [feature, new Map(
      GROUP_LINEAR_DISCOUNTS.map((discount) => [discount, new Map()]),
    )]));
    const logitHistory = [];
    const groupedLogitHistory = new Map(GROUP_AFFINE_FEATURES.map((feature) => [feature, new Map()]));
    const calibrationStats = new Map(CALIBRATION_DISCOUNTS.map((discount) => [discount, {
      n: 0,
      sumPrediction: 0,
      sumPredictionSquared: 0,
      sumOutcome: 0,
      sumPredictionOutcome: 0,
    }]));

    const sortedPairDates = [...eventsByDate.keys()].sort();
    for (let roundIndex = 0; roundIndex < sortedPairDates.length; roundIndex += 1) {
      const date = sortedPairDates[roundIndex];
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
      const groupAffineCoefficients = Object.fromEntries(GROUP_AFFINE_FEATURES.flatMap((feature) => (
        GROUP_AFFINE_DISCOUNTS.flatMap((discount) => {
          const globalPrior = ridgeAffineCoefficients(affineStats.get(discount), 5);
          const statsByGroup = groupAffineStats.get(feature).get(discount);
          const currentGroups = [...new Set(round.map((event) => event[feature]))];
          return GROUP_AFFINE_LAMBDAS.map((lambda) => [
            groupAffineMethodId(feature, discount, lambda),
            Object.fromEntries(currentGroups.map((group) => [
              group,
              ridgeAffineCoefficientsWithPrior(statsByGroup.get(group) ?? createAffineStats(), lambda, globalPrior),
            ])),
          ]);
        })
      )));
      const groupLinearWeights = Object.fromEntries(GROUP_AFFINE_FEATURES.flatMap((feature) => (
        GROUP_LINEAR_DISCOUNTS.flatMap((discount) => {
          const globalPrior = ridgeLinearWeight(ridgeStats.get(discount), 20);
          const statsByGroup = groupLinearStats.get(feature).get(discount);
          const currentGroups = [...new Set(round.map((event) => event[feature]))];
          return GROUP_LINEAR_LAMBDAS.map((lambda) => [
            groupLinearMethodId(feature, discount, lambda),
            Object.fromEntries(currentGroups.map((group) => [
              group,
              ridgeLinearWeightWithPrior(
                statsByGroup.get(group) ?? { differenceResidual: 0, differenceSquared: 0 },
                lambda,
                globalPrior,
              ),
            ])),
          ]);
        })
      )));
      const globalLogitPrior = fitGroupedLogit(logitHistory, 20, [0, 0.5, 0.5], roundIndex);
      const groupLogitCoefficients = Object.fromEntries(GROUP_AFFINE_FEATURES.flatMap((feature) => {
        const historyByGroup = groupedLogitHistory.get(feature);
        const currentGroups = [...new Set(round.map((event) => event[feature]))];
        return GROUP_LOGIT_LAMBDAS.map((lambda) => [
          groupLogitMethodId(feature, lambda),
          Object.fromEntries(currentGroups.map((group) => [
            group,
            fitGroupedLogit(historyByGroup.get(group) ?? [], lambda, globalLogitPrior, roundIndex),
          ])),
        ]);
      }));
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
        groupAffineCoefficients,
        groupLinearWeights,
        groupLogitCoefficients,
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
            diagnostic.fits += 1;
            const coefficients = affineCoefficients.get(discount)[lambda];
            for (let index = 0; index < 3; index += 1) diagnostic.coefficients[index].push(coefficients[index]);
          }
        }
        for (const method of GROUP_AFFINE_DIAGNOSTIC_METHODS) {
          const diagnostic = affineDiagnostics.get(method);
          diagnostic.cells += 1;
          const coefficientsByGroup = cell.groupAffineCoefficients[method];
          for (const coefficients of Object.values(coefficientsByGroup)) {
            diagnostic.fits += 1;
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
        if (cell) {
          for (const method of GROUP_AFFINE_DIAGNOSTIC_METHODS) {
            const feature = method.startsWith("source-") ? "sourceKey" : "questionType";
            const coefficients = cell.groupAffineCoefficients[method][event[feature]];
            const rawPrediction = coefficients[0] + coefficients[1] * first + coefficients[2] * second;
            const diagnostic = affineDiagnostics.get(method);
            diagnostic.predictions += 1;
            if (rawPrediction < 0) diagnostic.clippedLow += 1;
            else if (rawPrediction > 1) diagnostic.clippedHigh += 1;
          }
        }
        if (cell) cell.rows.push({
          outcome: event.outcome,
          first,
          second,
          sourceKey: event.sourceKey,
          questionType: event.questionType,
          basePredictions,
        });
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
        discountAffineStats(stats, discount);
        for (let index = 0; index < round.length; index += 1) {
          const features = [1, round[index].forecasts[modelA], round[index].forecasts[modelB]];
          updateAffineStats(stats, features, outcomes[index]);
        }
      }
      for (const feature of GROUP_AFFINE_FEATURES) {
        for (const discount of GROUP_AFFINE_DISCOUNTS) {
          const statsByGroup = groupAffineStats.get(feature).get(discount);
          for (const stats of statsByGroup.values()) discountAffineStats(stats, discount);
          for (let index = 0; index < round.length; index += 1) {
            const group = round[index][feature];
            if (!statsByGroup.has(group)) statsByGroup.set(group, createAffineStats());
            updateAffineStats(
              statsByGroup.get(group),
              [1, round[index].forecasts[modelA], round[index].forecasts[modelB]],
              outcomes[index],
            );
          }
        }
      }
      for (let index = 0; index < round.length; index += 1) {
        const historyRow = {
          first: round[index].forecasts[modelA],
          second: round[index].forecasts[modelB],
          outcome: outcomes[index],
          roundIndex,
        };
        logitHistory.push(historyRow);
        for (const feature of GROUP_AFFINE_FEATURES) {
          const group = round[index][feature];
          const historyByGroup = groupedLogitHistory.get(feature);
          if (!historyByGroup.has(group)) historyByGroup.set(group, []);
          historyByGroup.get(group).push(historyRow);
        }
      }
      for (const feature of GROUP_AFFINE_FEATURES) {
        for (const discount of GROUP_LINEAR_DISCOUNTS) {
          const statsByGroup = groupLinearStats.get(feature).get(discount);
          for (const stats of statsByGroup.values()) {
            stats.differenceResidual *= discount;
            stats.differenceSquared *= discount;
          }
          for (let index = 0; index < round.length; index += 1) {
            const group = round[index][feature];
            if (!statsByGroup.has(group)) statsByGroup.set(group, { differenceResidual: 0, differenceSquared: 0 });
            const stats = statsByGroup.get(group);
            const difference = round[index].forecasts[modelA] - round[index].forecasts[modelB];
            stats.differenceResidual += difference * (outcomes[index] - round[index].forecasts[modelB]);
            stats.differenceSquared += difference ** 2;
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
      fits: diagnostic.fits,
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
  for (const strongQuantile of [0.25, 0.4]) {
    for (const dependenceConfig of DEPENDENCE_RIDGE_CONFIGS) {
      const strongMethod = dependenceRidgeMethodId(dependenceConfig);
      for (const otherMethod of ["ridge-affine-d0.95-l1", "ridge-affine-d0.95-l5"]) {
        configs.push({
          id: `dependence-gate-q${strongQuantile}-${strongMethod}-${otherMethod}`,
          family: "rolling-quality-dependence-gate",
          strongQuantile,
          strongMethod,
          otherMethod,
          dependenceConfig,
        });
      }
    }
  }
  for (const strongQuantile of [0.25, 0.4]) {
    for (const strongMethod of ["ridge-linear-20", "ridge-linear-30"]) {
      for (const feature of GROUP_AFFINE_FEATURES) {
        for (const discount of GROUP_LINEAR_DISCOUNTS) {
          for (const lambda of [20, 50, 100, 500]) {
            const otherMethod = groupLinearMethodId(feature, discount, lambda);
            configs.push({
              id: `bounded-group-gate-q${strongQuantile}-${strongMethod}-${otherMethod}`,
              family: "rolling-quality-bounded-group-gate",
              strongQuantile,
              strongMethod,
              otherMethod,
              groupFeature: feature,
            });
          }
        }
      }
    }
  }
  for (const strongQuantile of [0.25, 0.4]) {
    for (const strongMethod of ["ridge-linear-20", "ridge-linear-30"]) {
      for (const feature of GROUP_AFFINE_FEATURES) {
        for (const discount of GROUP_AFFINE_DISCOUNTS) {
          for (const lambda of [20, 50, 100, 500]) {
            const otherMethod = groupAffineMethodId(feature, discount, lambda);
            configs.push({
              id: `group-gate-q${strongQuantile}-${strongMethod}-${otherMethod}`,
              family: "rolling-quality-group-affine-gate",
              strongQuantile,
              strongMethod,
              otherMethod,
              groupFeature: feature,
            });
          }
        }
      }
    }
  }
  for (const strongQuantile of [0.1, 0.2, 0.25]) {
    for (const middleQuantile of [0.4, 0.5]) {
      for (const strongMethod of ["ridge-linear-20", "ridge-linear-30"]) {
        for (const middleMethod of ["type-affine-d0.95-l20", "type-affine-d0.95-l50"]) {
          for (const otherMethod of [
            "source-affine-d0.95-l50",
            "source-affine-d0.95-l100",
            "source-affine-d0.95-l500",
          ]) {
            configs.push({
              id: `hierarchical-gate-q${strongQuantile}-q${middleQuantile}-${strongMethod}-${middleMethod}-${otherMethod}`,
              family: "rolling-hierarchical-group-gate",
              strongQuantile,
              middleQuantile,
              strongMethod,
              middleMethod,
              otherMethod,
            });
          }
        }
      }
    }
  }
  for (const strongQuantile of [0.1, 0.2, 0.25]) {
    for (const middleQuantile of [0.4, 0.5]) {
      for (const strongMethod of ["ridge-linear-20", "ridge-linear-30"]) {
        for (const middleMethod of ["type-logit-d0.95-l5", "type-logit-d0.95-l20", "type-logit-d0.95-l50"]) {
          for (const otherMethod of ["source-logit-d0.95-l5", "source-logit-d0.95-l20", "source-logit-d0.95-l50"]) {
            configs.push({
              id: `logit-hierarchical-gate-q${strongQuantile}-q${middleQuantile}-${strongMethod}-${middleMethod}-${otherMethod}`,
              family: "rolling-hierarchical-group-gate",
              strongQuantile,
              middleQuantile,
              strongMethod,
              middleMethod,
              otherMethod,
            });
          }
        }
      }
    }
  }
  for (const strongQuantile of [0.1, 0.2, 0.25]) {
    for (const middleQuantile of [0.4, 0.5]) {
      for (const strongMethod of ["ridge-linear-20", "ridge-linear-30"]) {
        for (const middleMethod of ["type-linear-d0.95-l20", "type-linear-d0.95-l50"]) {
          for (const otherMethod of ["source-linear-d0.95-l20", "source-linear-d0.95-l50", "source-linear-d0.95-l100"]) {
            configs.push({
              id: `bounded-hierarchical-gate-q${strongQuantile}-q${middleQuantile}-${strongMethod}-${middleMethod}-${otherMethod}`,
              family: "rolling-hierarchical-group-gate",
              strongQuantile,
              middleQuantile,
              strongMethod,
              middleMethod,
              otherMethod,
            });
          }
        }
      }
    }
  }
  for (const alphaThreshold of [0.02, 0.05, 0.075, 0.1, 0.2, 0.35, 0.5]) {
    for (const highUsesFirst of [true, false]) {
      for (const [firstMiddleMethod, secondMiddleMethod] of [
        ["type-affine-d0.95-l20", "type-affine-d0.95-l50"],
        ["type-affine-d0.95-l20", "source-affine-d0.95-l50"],
      ]) {
        configs.push({
          id: `correlation-gate-a${formatParameter(alphaThreshold)}-${highUsesFirst ? "high-first" : "low-first"}-${firstMiddleMethod}-${secondMiddleMethod}`,
          family: "rolling-correlation-hierarchical-gate",
          strongQuantile: 0.2,
          middleQuantile: 0.5,
          strongMethod: "ridge-linear-30",
          firstMiddleMethod,
          secondMiddleMethod,
          otherMethod: "source-affine-d0.95-l50",
          alphaThreshold,
          highUsesFirst,
        });
      }
    }
  }
  for (const alphaThreshold of [0.02, 0.05, 0.075, 0.1, 0.2, 0.35, 0.5]) {
    for (const highUsesFirst of [true, false]) {
      for (const [firstMiddleMethod, secondMiddleMethod, otherMethod] of [
        ["type-logit-d0.95-l5", "source-logit-d0.95-l20", "source-logit-d0.95-l20"],
        ["type-logit-d0.95-l5", "source-logit-d0.95-l5", "source-logit-d0.95-l20"],
        ["type-logit-d0.95-l20", "source-logit-d0.95-l20", "source-logit-d0.95-l20"],
      ]) {
        configs.push({
          id: `logit-correlation-gate-a${formatParameter(alphaThreshold)}-${highUsesFirst ? "high-first" : "low-first"}-${firstMiddleMethod}-${secondMiddleMethod}-${otherMethod}`,
          family: "rolling-correlation-hierarchical-gate",
          strongQuantile: 0.2,
          middleQuantile: 0.5,
          strongMethod: "ridge-linear-20",
          firstMiddleMethod,
          secondMiddleMethod,
          otherMethod,
          alphaThreshold,
          highUsesFirst,
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

function pairStackConfigs() {
  const balanced = "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1";
  const average = "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1";
  const calibrated = "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1";
  const configs = [];
  for (const discount of [1, 0.95, 0.8]) {
    for (const etaScale of [0.5, 1, 2]) {
      configs.push({
        id: `pair-stack-2-d${discount}-e${etaScale}-uniform`,
        family: "pair-specific-aggregator-hedge",
        discount,
        etaScale,
        experts: ["no-dependence-4", balanced],
        prior: [0.5, 0.5],
      });
      configs.push({
        id: `pair-stack-2-d${discount}-e${etaScale}-qar75`,
        family: "pair-specific-aggregator-hedge",
        discount,
        etaScale,
        experts: ["no-dependence-4", balanced],
        prior: [0.25, 0.75],
      });
      for (const qarPrior of [0.9, 0.95, 0.975, 0.99]) {
        configs.push({
          id: `pair-stack-2-d${discount}-e${etaScale}-qar${formatParameter(qarPrior * 100)}`,
          family: "pair-specific-aggregator-hedge",
          discount,
          etaScale,
          experts: ["no-dependence-4", balanced],
          prior: [1 - qarPrior, qarPrior],
        });
      }
    }
  }
  for (const discount of [1, 0.95]) {
    for (const etaScale of [0.5, 1]) {
      configs.push({
        id: `pair-stack-4-d${discount}-e${etaScale}`,
        family: "pair-specific-aggregator-hedge",
        discount,
        etaScale,
        experts: ["no-dependence-4", average, balanced, calibrated],
        prior: [0.1, 0.1, 0.7, 0.1],
      });
      for (const qarPrior of [0.85, 0.95, 0.975, 0.99]) {
        const remainder = (1 - qarPrior) / 3;
        configs.push({
          id: `pair-stack-4-d${discount}-e${etaScale}-qar${formatParameter(qarPrior * 100)}`,
          family: "pair-specific-aggregator-hedge",
          discount,
          etaScale,
          experts: ["no-dependence-4", average, balanced, calibrated],
          prior: [remainder, remainder, qarPrior, remainder],
        });
      }
    }
  }
  for (const discount of [1, 0.95, 0.8]) {
    for (const tolerance of [0, 0.0001, 0.00025, 0.0005, 0.001]) {
      configs.push({
        id: `pair-guardian-d${discount}-t${formatParameter(tolerance)}`,
        family: "pair-specific-guardian",
        rule: "guardian",
        discount,
        tolerance,
        experts: ["no-dependence-4", balanced],
      });
    }
  }
  return configs;
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

function unitBreakdown(unitAggregates, methods) {
  return [...unitAggregates.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([unit, aggregate]) => {
    const briers = Object.fromEntries(methods.map((method) => [method, aggregate.loss[method] / aggregate.n]));
    const bestBaseline = Math.min(...SOTA_BASELINES.map((baseline) => aggregate.loss[baseline] / aggregate.n));
    return {
      unit,
      targetEvaluations: aggregate.n,
      briers,
      bestCurrentBaseline: bestBaseline,
      gainVsBestCurrentBaseline: Object.fromEntries(methods.map((method) => [method, bestBaseline - briers[method]])),
    };
  });
}

function evaluateStrategies(cellsByDate) {
  const metaConfigs = strategyConfigs();
  const gates = gateConfigs();
  const selectors = selectorConfigs();
  const pairStacks = pairStackConfigs();
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
  const pairStackStates = new Map(pairStacks.map((config) => [config.id, new Map()]));

  for (const date of dates) {
    const cells = cellsByDate.get(date);
    const thresholdsByBucketCount = new Map([1, 4].map((bucketCount) => [bucketCount, rollingThresholds(priorQualities, bucketCount)]));
    const sortedPriorQualities = [...priorQualities].sort((first, second) => first - second);
    const gateThresholds = new Map([...new Set(gates.flatMap((gate) => [gate.strongQuantile, gate.middleQuantile]
      .filter((value) => value !== undefined)))]
      .map((probability) => [probability, sortedPriorQualities.length ? quantile(sortedPriorQualities, probability) : null]));
    const updates = new Map();
    const selectedExperts = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector)[selectedExpertIndex(selector, selectorStates.get(selector.id))]]));
    const selectorRoundLoss = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector).map(() => 0)]));
    const pairStackUpdates = new Map(pairStacks.map((config) => [config.id, new Map()]));
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
        for (const [method, coefficientsByGroup] of Object.entries(cell.groupAffineCoefficients)) {
          const feature = method.startsWith("source-") ? "sourceKey" : "questionType";
          const coefficients = coefficientsByGroup[row[feature]];
          predictions[method] = clampProbability(coefficients[0] + coefficients[1] * row.first + coefficients[2] * row.second);
        }
        for (const [method, weightsByGroup] of Object.entries(cell.groupLinearWeights)) {
          const feature = method.startsWith("source-") ? "sourceKey" : "questionType";
          const weight = weightsByGroup[row[feature]];
          predictions[method] = weight * row.first + (1 - weight) * row.second;
        }
        for (const [method, coefficientsByGroup] of Object.entries(cell.groupLogitCoefficients)) {
          const feature = method.startsWith("source-") ? "sourceKey" : "questionType";
          const coefficients = coefficientsByGroup[row[feature]];
          predictions[method] = logistic(
            coefficients[0] + coefficients[1] * boundedLogit(row.first) + coefficients[2] * boundedLogit(row.second),
          );
        }
        for (const [method, coefficients] of Object.entries(cell.calibrationCoefficients)) {
          predictions[method] = clampProbability(coefficients[0] + coefficients[1] * row.basePredictions["no-dependence-4"]);
        }
        for (const slope of SHRINK_SLOPES) {
          predictions[`no-dependence-shrink-${slope}`] = shrinkProbability(row.basePredictions["no-dependence-4"], slope);
        }
        for (const config of DEPENDENCE_RIDGE_CONFIGS) {
          const alpha = clampProbability(config.alphaScale * cell.safeAlpha ** config.alphaPower);
          predictions[dependenceRidgeMethodId(config)] = (1 - alpha) * row.basePredictions["historical-best"]
            + alpha * predictions[`ridge-linear-${config.ridgeLambda}`];
        }
        for (const gate of gates) {
          const threshold = gateThresholds.get(gate.strongQuantile);
          const strong = threshold !== null && cell.priorQuality <= threshold;
          if (gate.family === "rolling-hierarchical-group-gate" || gate.family === "rolling-correlation-hierarchical-gate") {
            const middleThreshold = gateThresholds.get(gate.middleQuantile);
            const middle = middleThreshold !== null && cell.priorQuality <= middleThreshold;
            if (gate.family === "rolling-correlation-hierarchical-gate" && middle && !strong) {
              const useFirst = cell.safeAlpha >= gate.alphaThreshold ? gate.highUsesFirst : !gate.highUsesFirst;
              predictions[gate.id] = predictions[useFirst ? gate.firstMiddleMethod : gate.secondMiddleMethod];
            } else {
              predictions[gate.id] = predictions[strong
                ? gate.strongMethod
                : middle
                  ? gate.middleMethod
                  : gate.otherMethod];
            }
          } else {
            predictions[gate.id] = gate.family !== "rolling-quality-gate"
              ? predictions[strong ? gate.strongMethod : gate.otherMethod]
              : strong
                ? predictions[`ridge-linear-${gate.ridgeLambda}`]
                : shrinkProbability(row.basePredictions["no-dependence-4"], gate.otherSlope);
          }
        }
        for (const config of pairStacks) {
          const states = pairStackStates.get(config.id);
          if (!states.has(cell.pair)) states.set(cell.pair, createMetaState(config.experts.length));
          const vector = config.experts.map((expert) => predictions[expert]);
          predictions[config.id] = config.rule === "guardian"
            ? guardianPrediction(vector, states.get(cell.pair), config.tolerance)
            : priorWeightedStrategyPrediction(vector, states.get(cell.pair), config.etaScale, config.prior);
          const updates = pairStackUpdates.get(config.id);
          if (!updates.has(cell.pair)) updates.set(cell.pair, { vectors: [], outcomes: [] });
          updates.get(cell.pair).vectors.push(vector);
          updates.get(cell.pair).outcomes.push(row.outcome);
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
    for (const config of pairStacks) {
      const states = pairStackStates.get(config.id);
      for (const [pair, update] of pairStackUpdates.get(config.id)) {
        states.set(pair, updateStrategyState(states.get(pair), update.vectors, update.outcomes, config.discount));
      }
    }
    priorQualities.push(...cells.map((cell) => cell.priorQuality));
  }

  const brierBySlice = Object.fromEntries(Object.entries(aggregates).map(([slice, aggregate]) => [slice, {
    targetEvaluations: aggregate.n,
    brier: summarizeAggregate(aggregate),
  }]));
  const configs = [
    ...metaConfigs.map((config) => ({ ...config, family: "quality-specialist-hedge" })),
    ...gates,
    ...pairStacks,
    ...selectors,
  ];
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
  const legacyAverageChampionId = "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1";
  const legacyBalancedId = "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1";
  const overallChampionId = "logit-correlation-gate-a0p35-low-first-type-logit-d0.95-l5-source-logit-d0.95-l20-source-logit-d0.95-l20";
  const balancedRecommendationId = "logit-hierarchical-gate-q0.2-q0.5-ridge-linear-20-type-logit-d0.95-l5-source-logit-d0.95-l20";
  const strongestGroupChampionId = "logit-hierarchical-gate-q0.25-q0.5-ridge-linear-30-type-logit-d0.95-l5-source-logit-d0.95-l5";
  const coverageChampionId = "logit-hierarchical-gate-q0.2-q0.5-ridge-linear-30-type-logit-d0.95-l5-source-logit-d0.95-l50";
  const boundedConvexControlId = "source-linear-d0.95-l5";
  const staticMethods = Object.entries(brierBySlice.overall.brier)
    .filter(([method]) => !method.startsWith("qas-")
      && !method.startsWith("qgate-")
      && !method.startsWith("affine-gate-")
      && !method.startsWith("calibration-gate-")
      && !method.startsWith("dependence-gate-")
      && !method.startsWith("group-gate-")
      && !method.startsWith("hierarchical-gate-")
      && !method.startsWith("correlation-gate-")
      && !method.startsWith("bounded-")
      && !method.startsWith("logit-")
      && !method.startsWith("pair-stack-")
      && !method.startsWith("pair-guardian-"))
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
      overallChampion: candidatesById.get(overallChampionId),
      balancedCandidate: candidatesById.get(balancedRecommendationId),
      strongestGroupChampion: candidatesById.get(strongestGroupChampionId),
      coverageChampion: candidatesById.get(coverageChampionId),
      boundedConvexControl: staticMethods.find((method) => method.method === boundedConvexControlId),
      legacyAverageChampion: candidatesById.get(legacyAverageChampionId),
      legacyBalancedCandidate: candidatesById.get(legacyBalancedId),
      selectionRule: "prefer the hierarchical balanced candidate when overall mean, strongest-quartile improvement, late stability, and SOTA coverage are joint objectives",
      strongestQuartileDefinition: "bottom quartile of scored pair-date cells by the better constituent model's strictly-prior cumulative Raw Brier",
      sotaDefinition: `strictly lower Raw Brier than the best of: ${SOTA_BASELINES.join(", ")}`,
      deploymentStatus: "research candidate only; freeze before independent confirmatory evaluation",
    },
    finalistRobustness: Object.fromEntries([
      "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l1",
      "affine-gate-q0.4-ridge-linear-20-ridge-affine-d0.95-l1",
      "affine-gate-q0.25-ridge-linear-20-ridge-affine-d0.95-l5",
      "calibration-gate-q0.4-ridge-linear-20-calibrated-no-dependence-d0.95-l1",
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
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
    hierarchicalMechanismComparison: {
      balancedMethod: balancedRecommendationId,
      legacyBalancedMethod: legacyBalancedId,
      overallVsLegacyDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        legacyBalancedId,
        balancedRecommendationId,
        20_000,
        20_260_863,
      ),
      lateVsLegacyDateBootstrap: dateBlockBootstrap(
        lateDateAggregates,
        legacyBalancedId,
        balancedRecommendationId,
        20_000,
        20_260_864,
      ),
      q1VsLegacyDateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        legacyBalancedId,
        balancedRecommendationId,
        20_000,
        20_260_865,
      ),
      pairComparisonVsLegacy: pairComparison(pairAggregates, legacyBalancedId, balancedRecommendationId),
      q1PairComparisonVsLegacy: pairComparison(q1PairAggregates, legacyBalancedId, balancedRecommendationId),
    },
    probabilitySafeMechanismComparison: {
      overallMethod: overallChampionId,
      balancedMethod: balancedRecommendationId,
      coverageMethod: coverageChampionId,
      strongestGroupMethod: strongestGroupChampionId,
      boundedConvexControl: boundedConvexControlId,
      overallVsBoundedConvexDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        boundedConvexControlId,
        overallChampionId,
        20_000,
        20_260_873,
      ),
      overallVsLegacyAffineDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        legacyBalancedId,
        overallChampionId,
        20_000,
        20_260_874,
      ),
      correlationGateVsNoCorrelationDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        balancedRecommendationId,
        overallChampionId,
        20_000,
        20_260_875,
      ),
      q1OverallVsNoDependenceDateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        "no-dependence-4",
        overallChampionId,
        20_000,
        20_260_876,
      ),
      pairComparisonVsNoDependence: pairComparison(pairAggregates, "no-dependence-4", overallChampionId),
      q1PairComparisonVsNoDependence: pairComparison(q1PairAggregates, "no-dependence-4", overallChampionId),
    },
    selectedDateBreakdown: unitBreakdown(dateAggregates, [
      "no-dependence-4",
      legacyBalancedId,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
    ]),
    selectedQ1DateBreakdown: unitBreakdown(q1DateAggregates, [
      "no-dependence-4",
      legacyBalancedId,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
    ]),
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
    schemaVersion: "0.2.0-exploration",
    generatedAt: new Date().toISOString(),
    status: "post_hoc_candidate_search_not_independent_oos",
    protocol: {
      outcomeVisibility: "all forecasts on date t are frozen before any date-t outcome updates pair or cross-pair states",
      qualityFeature: "lower of the two pair-specific cumulative Raw Brier scores from strictly earlier forecast dates",
      rollingBuckets: "quality thresholds at date t use feature values from scored pair-date cells strictly before t",
      groupingFeatures: "official sourceKey and Dataset/Market questionType; group-specific states use strictly earlier dates only",
      probabilitySafeMethods: "group-linear predictions are convex combinations; group-logit predictions use a logistic link, so neither requires clipping",
      dependenceFeature: "safeAlpha is the published strictly-prior synthesis of Adjusted POG, High-Loss Lift, Adjusted-Loss Correlation, quality gap, and support",
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
