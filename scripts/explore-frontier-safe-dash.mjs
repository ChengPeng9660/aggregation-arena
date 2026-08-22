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
const DEFAULT_OUTPUT = "output/research/frontier-safe-dash-exploration-2026-08-23.json";
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
const MODEL_CALIBRATION_BINS = 10;
const MODEL_CALIBRATION_DISCOUNT = 0.95;
const MODEL_CALIBRATION_CONFIGS = ["sourceKey", "questionType"].flatMap((feature) => (
  [20, 100, 500].flatMap((modelLambda) => [0.5, 1].map((mix) => ({
    feature,
    modelLambda,
    providerLambda: 200,
    mix,
  })))
));
const MODEL_CALIBRATION_PILOT_ID = "hier-model-cal-source-m20-p200-x0p5";
const MODEL_SKILL_CONFIGS = ["global", "sourceKey"].flatMap((feature) => (
  [10, 30].map((pairLambda) => ({
    feature,
    modelLambda: 50,
    providerLambda: 200,
    temperature: 25,
    pairLambda,
  }))
));
const MODEL_SKILL_PILOT_ID = "hier-skill-source-m50-p200-g25-r30";
const VARIANT_EXPERTS = {
  "no-dependence-4": ["model-a", "model-b", "two-model-hedge", "cptec"],
  "core-5": ["model-a", "model-b", "two-model-hedge", "safemix-2", "cptec"],
};
const SHRINK_SLOPES = [0.8, 0.9, 0.95, 1, 1.025, 1.05, 1.075, 1.1];
const SOTA_BASELINES = ["no-dependence-4", "two-model-hedge", "full-7", "core-5"];
const HSLOP_OVERALL_ID = "logit-correlation-gate-a0p35-low-first-type-logit-d0.95-l5-source-logit-d0.95-l20-source-logit-d0.95-l20";
const HSLOP_BALANCED_ID = "logit-hierarchical-gate-q0.2-q0.5-ridge-linear-20-type-logit-d0.95-l5-source-logit-d0.95-l20";
const HSLOP_STRONG_ID = "logit-hierarchical-gate-q0.25-q0.5-ridge-linear-30-type-logit-d0.95-l5-source-logit-d0.95-l5";
const HSLOP_COVERAGE_ID = "logit-hierarchical-gate-q0.2-q0.5-ridge-linear-30-type-logit-d0.95-l5-source-logit-d0.95-l50";
const HSLOP_META_OVERALL_ID = "global-hslop-ftl-d0.5";
const HSLOP_META_STABLE_ID = "global-hslop-hedge-d0.5-e1";
const HSLOP_META_BALANCED_ID = "fixed-hslop-coverage-strong-s0p45";
const HSLOP_META_STRONG_MEAN_ID = "fixed-hslop-balanced-strong-s0p75";
const HSLOP_META_STRONG_SOTA_ID = "fixed-hslop-balanced-strong-s0p7";
const HSLOP_SUPPORT_NODEP_ID = "support-gate-nHistory-t1000-nodep-meta-balanced";
const HSLOP_SUPPORT_CALIBRATED_ID = "support-gate-nHistory-t1000-modelcal-ridge20-nodep50-meta-balanced";
const CROSS_SKILL_STRONG_MEAN_ID = "fixed-skill-strong-sota-w0p1";
const CROSS_SKILL_COVERAGE_ID = "support-gate-nHistory-t1000-modelcal-skill-strong-w0p3";
const CROSS_SKILL_FIXED_MEAN_GATE_ID = "support-gate-nHistory-t1000-modelcal-skill-strong-w0p1";
const CROSS_SKILL_FTL_ID = "global-skill-share-ftl-d0.5";
const CROSS_SKILL_HEDGE_ID = "global-skill-share-hedge-d0.5-e1";
const CROSS_SKILL_QUALITY_ID = "quality-gate-q0.25-skill-w0p1-skill-ftl";
const CROSS_SKILL_ONLINE_HEDGE_GATE_ID = "support-gate-nHistory-t1000-modelcal-skill-hedge";
const CROSS_SKILL_QUALITY_GATE_ID = "support-gate-nHistory-t1000-modelcal-quality-skill-ftl";
const HSLOP_SUPPORT_OVERALL_ID = "support-gate-nHistory-t1000-modelcal-skill-ftl";
const FRONTIER_Q1_FTL_ID = "frontier-context-ftl-gap-alpha-stable";
const FRONTIER_Q1_HEDGE_ID = "frontier-context-gap2-stable";
const FRONTIER_JOINT_ID = "frontier-quality-gate-q0p5-ftl-overall";
const FRONTIER_COVERAGE_ID = "frontier-quality-gate-q0p4-ftl-overall";
const FRONTIER_STRONG_ID = "frontier-quality-gate-q0p5-ftl-strong-mean";
const FROZEN_FINALIST_IDS = [
  HSLOP_SUPPORT_OVERALL_ID,
  CROSS_SKILL_FIXED_MEAN_GATE_ID,
  CROSS_SKILL_COVERAGE_ID,
  CROSS_SKILL_QUALITY_GATE_ID,
  CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
];
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

function modelProvider(model) {
  return model.startsWith("z-ai-") ? "z-ai" : model.split("-")[0];
}

function calibrationBin(probability) {
  return Math.min(MODEL_CALIBRATION_BINS - 1, Math.max(0, Math.floor(probability * MODEL_CALIBRATION_BINS)));
}

function calibrationConfigId(config) {
  const feature = config.feature === "sourceKey" ? "source" : "type";
  return `hier-model-cal-${feature}-m${config.modelLambda}-p${config.providerLambda}-x${formatParameter(config.mix)}`;
}

function calibrationStatsKey(feature, entity, group, bin) {
  return `${feature}\u0000${entity}\u0000${group}\u0000${bin}`;
}

function cloneCalibrationStats(stats) {
  return new Map([...stats].map(([key, value]) => [key, { ...value }]));
}

function discountCalibrationStats(stats) {
  for (const value of stats.values()) {
    value.n *= MODEL_CALIBRATION_DISCOUNT;
    value.outcomes *= MODEL_CALIBRATION_DISCOUNT;
  }
}

function updateCalibrationStats(stats, key, outcome) {
  if (!stats.has(key)) stats.set(key, { n: 0, outcomes: 0 });
  const value = stats.get(key);
  value.n += 1;
  value.outcomes += outcome;
}

function skillStatsKey(feature, entity, group) {
  return `${feature}\u0000${entity}\u0000${group}`;
}

function updateSkillStats(stats, key, loss) {
  if (!stats.has(key)) stats.set(key, { n: 0, loss: 0 });
  const value = stats.get(key);
  value.n += 1;
  value.loss += loss;
}

function discountSkillStats(stats) {
  for (const value of stats.values()) {
    value.n *= MODEL_CALIBRATION_DISCOUNT;
    value.loss *= MODEL_CALIBRATION_DISCOUNT;
  }
}

function modelSkillMethodId(config) {
  const feature = config.feature === "sourceKey" ? "source" : "global";
  return `hier-skill-${feature}-m${config.modelLambda}-p${config.providerLambda}-g${config.temperature}-r${config.pairLambda}`;
}

function hierarchicalModelSkill(snapshot, model, event, config) {
  const group = config.feature === "global" ? "all" : event[config.feature];
  const globalRate = snapshot.skillGlobal.n > 0 ? snapshot.skillGlobal.loss / snapshot.skillGlobal.n : 0.2;
  const providerStats = snapshot.skillProvider.get(skillStatsKey(
    config.feature,
    modelProvider(model),
    group,
  )) ?? { n: 0, loss: 0 };
  const providerRate = (providerStats.loss + config.providerLambda * globalRate)
    / (providerStats.n + config.providerLambda);
  const modelStats = snapshot.skillModel.get(skillStatsKey(config.feature, model, group))
    ?? { n: 0, loss: 0 };
  return (modelStats.loss + config.modelLambda * providerRate) / (modelStats.n + config.modelLambda);
}

function buildModelCalibrationSnapshots(history) {
  const providerStats = new Map();
  const modelStats = new Map();
  const skillProviderStats = new Map();
  const skillModelStats = new Map();
  const skillGlobalStats = { n: 0, loss: 0 };
  const snapshots = new Map();
  const eventsByDate = new Map();
  let historyLastDate = null;
  for (const event of history.events) {
    if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
    eventsByDate.get(event.date).push(event);
  }
  for (const date of [...eventsByDate.keys()].sort()) {
    snapshots.set(date, {
      historyLastDate,
      provider: cloneCalibrationStats(providerStats),
      model: cloneCalibrationStats(modelStats),
      skillProvider: cloneCalibrationStats(skillProviderStats),
      skillModel: cloneCalibrationStats(skillModelStats),
      skillGlobal: { ...skillGlobalStats },
    });
    discountCalibrationStats(providerStats);
    discountCalibrationStats(modelStats);
    discountSkillStats(skillProviderStats);
    discountSkillStats(skillModelStats);
    skillGlobalStats.n *= MODEL_CALIBRATION_DISCOUNT;
    skillGlobalStats.loss *= MODEL_CALIBRATION_DISCOUNT;
    for (const event of eventsByDate.get(date)) {
      for (const [model, probability] of Object.entries(event.forecasts)) {
        const bin = calibrationBin(probability);
        for (const feature of ["sourceKey", "questionType"]) {
          const group = event[feature];
          updateCalibrationStats(
            providerStats,
            calibrationStatsKey(feature, modelProvider(model), group, bin),
            event.outcome,
          );
          updateCalibrationStats(
            modelStats,
            calibrationStatsKey(feature, model, group, bin),
            event.outcome,
          );
        }
        const loss = brier(probability, event.outcome);
        skillGlobalStats.n += 1;
        skillGlobalStats.loss += loss;
        for (const feature of ["global", "sourceKey"]) {
          const group = feature === "global" ? "all" : event[feature];
          updateSkillStats(
            skillProviderStats,
            skillStatsKey(feature, modelProvider(model), group),
            loss,
          );
          updateSkillStats(
            skillModelStats,
            skillStatsKey(feature, model, group),
            loss,
          );
        }
      }
    }
    historyLastDate = date;
  }
  return snapshots;
}

function hierarchicalModelCalibration(snapshot, model, probability, event, config) {
  const bin = calibrationBin(probability);
  const group = event[config.feature];
  const providerStats = snapshot.provider.get(calibrationStatsKey(
    config.feature,
    modelProvider(model),
    group,
    bin,
  )) ?? { n: 0, outcomes: 0 };
  const providerRate = (providerStats.outcomes + config.providerLambda * probability)
    / (providerStats.n + config.providerLambda);
  const modelStats = snapshot.model.get(calibrationStatsKey(config.feature, model, group, bin))
    ?? { n: 0, outcomes: 0 };
  const modelRate = (modelStats.outcomes + config.modelLambda * providerRate)
    / (modelStats.n + config.modelLambda);
  return (1 - config.mix) * probability + config.mix * modelRate;
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

function fixedMixturePrediction(predictions, weights) {
  return predictions.reduce((sum, prediction, index) => sum + weights[index] * prediction, 0);
}

function followTheLeaderPrediction(predictions, state, initialIndex) {
  return predictions[state.nFeedback > 0 ? minimumIndex(state.expertLossSum) : initialIndex];
}

function supportGatePrediction(predictions, cell, field, threshold) {
  return predictions[cell[field] < threshold ? 0 : 1];
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

async function buildFrozenCells(history, parameters, modelCalibrationSnapshots) {
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
      const modelCalibrationSnapshot = modelCalibrationSnapshots.get(date);
      if (!modelCalibrationSnapshot) throw new Error(`Missing model calibration snapshot for ${date}`);
      if (modelCalibrationSnapshot.historyLastDate !== null && modelCalibrationSnapshot.historyLastDate >= date) {
        throw new Error(`Non-prior cross-pair snapshot for ${date}`);
      }
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
        const hierarchicalModelPredictions = {};
        for (const config of MODEL_CALIBRATION_CONFIGS) {
          const method = calibrationConfigId(config);
          const calibratedFirst = hierarchicalModelCalibration(modelCalibrationSnapshot, modelA, first, event, config);
          const calibratedSecond = hierarchicalModelCalibration(modelCalibrationSnapshot, modelB, second, event, config);
          const equalPrediction = (calibratedFirst + calibratedSecond) / 2;
          hierarchicalModelPredictions[method] = equalPrediction;
          if (method === MODEL_CALIBRATION_PILOT_ID) {
            const ridgeWeight = cell?.ridgeWeights["ridge-linear-20"] ?? 0.5;
            const ridgePrediction = ridgeWeight * calibratedFirst + (1 - ridgeWeight) * calibratedSecond;
            hierarchicalModelPredictions[`${method}-nodep50`] = (equalPrediction + basePredictions["no-dependence-4"]) / 2;
            hierarchicalModelPredictions[`${method}-ridge20`] = ridgePrediction;
            hierarchicalModelPredictions[`${method}-ridge20-nodep50`] = (ridgePrediction + basePredictions["no-dependence-4"]) / 2;
          }
        }
        for (const config of MODEL_SKILL_CONFIGS) {
          const firstSkill = hierarchicalModelSkill(modelCalibrationSnapshot, modelA, event, config);
          const secondSkill = hierarchicalModelSkill(modelCalibrationSnapshot, modelB, event, config);
          const skillPrior = logistic(config.temperature * (secondSkill - firstSkill));
          const weight = ridgeLinearWeightWithPrior(ridgeStats.get(1), config.pairLambda, skillPrior);
          hierarchicalModelPredictions[modelSkillMethodId(config)] = weight * first + (1 - weight) * second;
        }
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
          hierarchicalModelPredictions,
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
  for (const balancedWeight of [0.25, 0.5, 0.75]) {
    configs.push({
      id: `fixed-hslop-balanced-coverage-b${formatParameter(balancedWeight)}`,
      family: "fixed-hslop-mixture",
      rule: "fixed",
      discount: 1,
      experts: [HSLOP_BALANCED_ID, HSLOP_COVERAGE_ID],
      prior: [balancedWeight, 1 - balancedWeight],
    });
  }
  for (const [id, experts, prior] of [
    ["fixed-hslop-balanced-overall", [HSLOP_BALANCED_ID, HSLOP_OVERALL_ID], [0.5, 0.5]],
    ["fixed-hslop-balanced-strong-s25", [HSLOP_BALANCED_ID, HSLOP_STRONG_ID], [0.75, 0.25]],
    ["fixed-hslop-pareto-3", [HSLOP_BALANCED_ID, HSLOP_COVERAGE_ID, HSLOP_STRONG_ID], [0.5, 0.25, 0.25]],
    ["fixed-hslop-pareto-4", [HSLOP_BALANCED_ID, HSLOP_COVERAGE_ID, HSLOP_STRONG_ID, HSLOP_OVERALL_ID], [0.4, 0.2, 0.2, 0.2]],
  ]) {
    configs.push({ id, family: "fixed-hslop-mixture", rule: "fixed", discount: 1, experts, prior });
  }
  for (const strongWeight of [0.1, 0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    for (const [anchorName, anchor] of [
      ["balanced", HSLOP_BALANCED_ID],
      ["coverage", HSLOP_COVERAGE_ID],
      ["overall", HSLOP_OVERALL_ID],
    ]) {
      configs.push({
        id: `fixed-hslop-${anchorName}-strong-s${formatParameter(strongWeight)}`,
        family: "fixed-hslop-strong-mixture",
        rule: "fixed",
        discount: 1,
        experts: [anchor, HSLOP_STRONG_ID],
        prior: [1 - strongWeight, strongWeight],
      });
    }
  }
  for (const skillWeight of [0.1, 0.2, 0.3]) {
    configs.push({
      id: `fixed-skill-strong-sota-w${formatParameter(skillWeight)}`,
      family: "fixed-cross-pair-skill-mixture",
      rule: "fixed",
      discount: 1,
      experts: [HSLOP_META_STRONG_SOTA_ID, MODEL_SKILL_PILOT_ID],
      prior: [1 - skillWeight, skillWeight],
    });
  }
  const skillShareExperts = [0.1, 0.2, 0.3].map((skillWeight) => (
    `fixed-skill-strong-sota-w${formatParameter(skillWeight)}`
  ));
  configs.push({
    id: CROSS_SKILL_FTL_ID,
    family: "global-skill-share-selector",
    rule: "ftl",
    scope: "global",
    discount: 0.5,
    experts: skillShareExperts,
    initialIndex: 0,
  });
  configs.push({
    id: CROSS_SKILL_HEDGE_ID,
    family: "global-skill-share-hedge",
    scope: "global",
    discount: 0.5,
    etaScale: 1,
    experts: skillShareExperts,
    prior: [0.5, 0.3, 0.2],
  });
  configs.push({
    id: CROSS_SKILL_QUALITY_ID,
    family: "rolling-quality-skill-share-gate",
    rule: "quality-gate",
    discount: 1,
    qualityQuantile: 0.25,
    experts: ["fixed-skill-strong-sota-w0p1", CROSS_SKILL_FTL_ID],
  });
  const hslopExperts = [HSLOP_BALANCED_ID, HSLOP_COVERAGE_ID, HSLOP_STRONG_ID, HSLOP_OVERALL_ID, "no-dependence-4"];
  for (const discount of [1, 0.95, 0.8, 0.5]) {
    configs.push({
      id: `pair-hslop-ftl-d${discount}`,
      family: "pair-specific-hslop-selector",
      rule: "ftl",
      discount,
      experts: hslopExperts,
      initialIndex: 0,
    });
    for (const etaScale of [0.25, 0.5, 1, 2]) {
      configs.push({
        id: `pair-hslop-hedge-d${discount}-e${etaScale}`,
        family: "pair-specific-hslop-hedge",
        discount,
        etaScale,
        experts: hslopExperts,
        prior: [0.5, 0.2, 0.1, 0.15, 0.05],
      });
    }
  }
  for (const discount of [1, 0.95, 0.8, 0.5]) {
    configs.push({
      id: `global-hslop-ftl-d${discount}`,
      family: "global-hslop-selector",
      rule: "ftl",
      scope: "global",
      discount,
      experts: hslopExperts,
      initialIndex: 0,
    });
    for (const etaScale of [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]) {
      configs.push({
        id: `global-hslop-hedge-d${discount}-e${etaScale}`,
        family: "global-hslop-hedge",
        scope: "global",
        discount,
        etaScale,
        experts: hslopExperts,
        prior: [0.5, 0.2, 0.1, 0.15, 0.05],
      });
    }
  }
  for (const [field, thresholds] of [
    ["nHistory", [300, 500, 750, 1000, 1500]],
    ["nHistoryDates", [4, 6, 8]],
  ]) {
    for (const threshold of thresholds) {
      for (const [fallbackName, fallback] of [["nodep", "no-dependence-4"]]) {
        for (const [primaryName, primary] of [
          ["coverage", HSLOP_COVERAGE_ID],
          ["meta-balanced", HSLOP_META_BALANCED_ID],
        ]) {
          configs.push({
            id: `support-gate-${field}-t${threshold}-${fallbackName}-${primaryName}`,
            family: "strictly-prior-support-gate",
            rule: "support-gate",
            discount: 1,
            field,
            threshold,
            experts: [fallback, primary],
          });
        }
      }
    }
  }
  for (const threshold of [500, 1000]) {
    for (const [fallbackName, fallback] of [["ridge20", "ridge-linear-20"], ["ridge30", "ridge-linear-30"]]) {
      configs.push({
        id: `support-gate-nHistory-t${threshold}-${fallbackName}-coverage`,
        family: "strictly-prior-support-gate",
        rule: "support-gate",
        discount: 1,
        field: "nHistory",
        threshold,
        experts: [fallback, HSLOP_COVERAGE_ID],
      });
    }
  }
  for (const threshold of [500, 750, 1000, 1500]) {
    for (const [fallbackName, fallback] of [
      ["modelcal-ridge20", `${MODEL_CALIBRATION_PILOT_ID}-ridge20`],
      ["modelcal-ridge20-nodep50", `${MODEL_CALIBRATION_PILOT_ID}-ridge20-nodep50`],
    ]) {
      configs.push({
        id: `support-gate-nHistory-t${threshold}-${fallbackName}-meta-balanced`,
        family: "strictly-prior-cross-pair-calibration-gate",
        rule: "support-gate",
        discount: 1,
        field: "nHistory",
        threshold,
        experts: [fallback, HSLOP_META_BALANCED_ID],
      });
    }
  }
  for (const skillWeight of [0.1, 0.2, 0.3]) {
    configs.push({
      id: `support-gate-nHistory-t1000-modelcal-skill-strong-w${formatParameter(skillWeight)}`,
      family: "strictly-prior-cross-pair-skill-gate",
      rule: "support-gate",
      discount: 1,
      field: "nHistory",
      threshold: 1000,
      experts: [
        `${MODEL_CALIBRATION_PILOT_ID}-ridge20-nodep50`,
        `fixed-skill-strong-sota-w${formatParameter(skillWeight)}`,
      ],
    });
  }
  for (const [selectorName, selector] of [
    ["skill-ftl", CROSS_SKILL_FTL_ID],
    ["skill-hedge", CROSS_SKILL_HEDGE_ID],
    ["quality-skill-ftl", CROSS_SKILL_QUALITY_ID],
  ]) {
    configs.push({
      id: `support-gate-nHistory-t1000-modelcal-${selectorName}`,
      family: "strictly-prior-online-skill-share-gate",
      rule: "support-gate",
      discount: 1,
      field: "nHistory",
      threshold: 1000,
      experts: [`${MODEL_CALIBRATION_PILOT_ID}-ridge20-nodep50`, selector],
    });
  }

  // V2 discovery leaves the frozen V1 script untouched and treats both the
  // incumbent SOTA controls and the V1 frontier candidates as online experts.
  // Every selection state is updated only after the current forecast date.
  const frontierCoreExperts = [
    "no-dependence-4",
    "two-model-hedge",
    "full-7",
    "core-5",
    CROSS_SKILL_FIXED_MEAN_GATE_ID,
  ];
  const frontierFullExperts = [
    ...frontierCoreExperts,
    CROSS_SKILL_COVERAGE_ID,
    CROSS_SKILL_QUALITY_GATE_ID,
    CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
    HSLOP_SUPPORT_OVERALL_ID,
  ];
  const frontierSettings = [
    { name: "stable", discount: 0.8, etaScale: 0.25, candidatePrior: 0.95 },
    { name: "adaptive", discount: 0.8, etaScale: 1, candidatePrior: 0.8 },
    { name: "recent", discount: 0.5, etaScale: 1, candidatePrior: 0.8 },
  ];
  for (const setting of frontierSettings) {
    const incumbentPrior = (1 - setting.candidatePrior) / 4;
    const prior = [incumbentPrior, incumbentPrior, incumbentPrior, incumbentPrior, setting.candidatePrior];
    const scopedIds = {};
    for (const [scopeName, scope] of [
      ["pair", undefined],
      ["global", "global"],
      ["model-a", "model-a"],
      ["model-b", "model-b"],
      ["provider-a", "provider-a"],
      ["provider-b", "provider-b"],
    ]) {
      const id = `frontier-core-${scopeName}-${setting.name}`;
      scopedIds[scopeName] = id;
      configs.push({
        id,
        family: `${scopeName}-frontier-hedge`,
        scope,
        discount: setting.discount,
        etaScale: setting.etaScale,
        experts: frontierCoreExperts,
        prior,
      });
    }
    configs.push({
      id: `frontier-model-mean-${setting.name}`,
      family: "cross-pair-model-frontier-mixture",
      rule: "fixed",
      discount: 1,
      experts: [scopedIds["model-a"], scopedIds["model-b"]],
      prior: [0.5, 0.5],
    });
    configs.push({
      id: `frontier-provider-mean-${setting.name}`,
      family: "cross-pair-provider-frontier-mixture",
      rule: "fixed",
      discount: 1,
      experts: [scopedIds["provider-a"], scopedIds["provider-b"]],
      prior: [0.5, 0.5],
    });
    configs.push({
      id: `frontier-model-global-${setting.name}`,
      family: "hierarchical-model-frontier-mixture",
      rule: "fixed",
      discount: 1,
      experts: [scopedIds["model-a"], scopedIds["model-b"], scopedIds.global],
      prior: [0.4, 0.4, 0.2],
    });
    configs.push({
      id: `frontier-hierarchical-${setting.name}`,
      family: "hierarchical-model-provider-frontier-mixture",
      rule: "fixed",
      discount: 1,
      experts: [
        scopedIds["model-a"],
        scopedIds["model-b"],
        scopedIds["provider-a"],
        scopedIds["provider-b"],
        scopedIds.global,
      ],
      prior: [0.3, 0.3, 0.1, 0.1, 0.2],
    });
    for (const contextVariant of ["gap2", "gap4", "gap-alpha", "quality-gap-alpha", "support-gap"]) {
      configs.push({
        id: `frontier-context-${contextVariant}-${setting.name}`,
        family: "rolling-contextual-frontier-hedge",
        scope: "context",
        contextVariant,
        discount: setting.discount,
        etaScale: setting.etaScale,
        experts: frontierCoreExperts,
        prior,
      });
      configs.push({
        id: `frontier-context-ftl-${contextVariant}-${setting.name}`,
        family: "rolling-contextual-frontier-ftl",
        rule: "ftl",
        scope: "context",
        contextVariant,
        discount: setting.discount,
        experts: frontierCoreExperts,
        initialIndex: frontierCoreExperts.indexOf(CROSS_SKILL_FIXED_MEAN_GATE_ID),
      });
    }
  }
  for (const qualityQuantile of [0.2, 0.25, 0.3, 0.4, 0.5, 0.75]) {
    for (const [fallbackName, fallback] of [
      ["overall", HSLOP_SUPPORT_OVERALL_ID],
      ["strong-mean", CROSS_SKILL_FIXED_MEAN_GATE_ID],
    ]) {
      configs.push({
        id: `frontier-quality-gate-q${formatParameter(qualityQuantile)}-ftl-${fallbackName}`,
        family: "rolling-quality-contextual-frontier-gate",
        rule: "quality-gate",
        discount: 1,
        qualityQuantile,
        experts: [FRONTIER_Q1_FTL_ID, fallback],
      });
    }
  }
  configs.push({
    id: "frontier-full-global-overall-pilot",
    family: "global-frontier-hedge",
    scope: "global",
    discount: 0.5,
    etaScale: 2,
    experts: frontierFullExperts,
    prior: [0.025, 0.025, 0.025, 0.025, 0.18, 0.18, 0.18, 0.18, 0.18],
  });
  return configs;
}

function pairStackStateKey(config, cell) {
  if (config.scope === "global") return "__global__";
  if (config.scope === "context") return cell.contextStateKeys[config.contextVariant];
  const [modelA, modelB] = cell.pair.split("\u0000");
  if (config.scope === "model-a") return modelA;
  if (config.scope === "model-b") return modelB;
  if (config.scope === "provider-a") return modelA.split("-")[0];
  if (config.scope === "provider-b") return modelB.split("-")[0];
  return cell.pair;
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
  let strictSota = 0;
  let units = 0;
  let gainSum = 0;
  for (const aggregate of unitAggregates.values()) {
    if (!aggregate.n || aggregate.loss[method] === undefined) continue;
    const methodBrier = aggregate.loss[method] / aggregate.n;
    const baselineBest = Math.min(...SOTA_BASELINES.map((baseline) => aggregate.loss[baseline] / aggregate.n));
    gainSum += baselineBest - methodBrier;
    if (methodBrier <= baselineBest + tolerance + 1e-15) sota += 1;
    if (methodBrier < baselineBest - 1e-15) strictSota += 1;
    units += 1;
  }
  return {
    units,
    count: sota,
    rate: sota / units,
    strictCount: strictSota,
    strictRate: strictSota / units,
    meanGainVsBestBaseline: gainSum / units,
    tolerance,
  };
}

function subsetAggregates(unitAggregates, keys) {
  return new Map([...unitAggregates].filter(([key]) => keys.has(key)));
}

function summarizeAggregateSubset(unitAggregates, methods) {
  const combined = { n: 0, loss: {} };
  for (const aggregate of unitAggregates.values()) {
    combined.n += aggregate.n;
    for (const method of methods) addLoss(combined, method, aggregate.loss[method]);
  }
  if (combined.n === 0) return { targetEvaluations: 0, brier: null };
  return {
    targetEvaluations: combined.n,
    brier: Object.fromEntries(methods.map((method) => [method, combined.loss[method] / combined.n])),
  };
}

function pairOracleDiagnostics(unitAggregates, candidateMethods, referenceMethod) {
  let targets = 0;
  let oracleLoss = 0;
  let strictSota = 0;
  let referenceFailures = 0;
  let recoverableReferenceFailures = 0;
  const oracleWinnerCounts = {};
  const unrecoverableReferenceUnits = [];
  for (const [unit, aggregate] of unitAggregates) {
    const bestBaselineLoss = Math.min(...SOTA_BASELINES.map((method) => aggregate.loss[method]));
    const available = candidateMethods
      .filter((method) => Number.isFinite(aggregate.loss[method]))
      .map((method) => ({ method, loss: aggregate.loss[method] }));
    const oracle = available.reduce((best, candidate) => candidate.loss < best.loss ? candidate : best);
    targets += aggregate.n;
    oracleLoss += oracle.loss;
    oracleWinnerCounts[oracle.method] = (oracleWinnerCounts[oracle.method] ?? 0) + 1;
    if (oracle.loss < bestBaselineLoss) strictSota += 1;
    if (aggregate.loss[referenceMethod] >= bestBaselineLoss) {
      referenceFailures += 1;
      if (oracle.loss < bestBaselineLoss) recoverableReferenceFailures += 1;
      else unrecoverableReferenceUnits.push(unit);
    }
  }
  return {
    units: unitAggregates.size,
    targetEvaluations: targets,
    oracleBrier: oracleLoss / targets,
    strictSota,
    strictSotaRate: strictSota / unitAggregates.size,
    referenceMethod,
    referenceFailures,
    recoverableReferenceFailures,
    unrecoverableReferenceFailures: referenceFailures - recoverableReferenceFailures,
    unrecoverableReferenceUnits,
    oracleWinnerCounts: Object.fromEntries(Object.entries(oracleWinnerCounts)
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))),
  };
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

function methodSetCoverage(unitAggregates, methods) {
  const bestMethodCounts = Object.fromEntries(methods.map((method) => [method, 0]));
  let atLeastOneSota = 0;
  let allSota = 0;
  let units = 0;
  for (const aggregate of unitAggregates.values()) {
    if (!aggregate.n || methods.some((method) => aggregate.loss[method] === undefined)) continue;
    const baselineBest = Math.min(...SOTA_BASELINES.map((baseline) => aggregate.loss[baseline] / aggregate.n));
    const briers = methods.map((method) => aggregate.loss[method] / aggregate.n);
    if (briers.some((value) => value <= baselineBest + 1e-15)) atLeastOneSota += 1;
    if (briers.every((value) => value <= baselineBest + 1e-15)) allSota += 1;
    bestMethodCounts[methods[minimumIndex(briers)]] += 1;
    units += 1;
  }
  return { units, atLeastOneSota, atLeastOneSotaRate: atLeastOneSota / units, allSota, allSotaRate: allSota / units, bestMethodCounts };
}

function sotaTransition(unitAggregates, beforeMethod, afterMethod) {
  const counts = { both: 0, gained: 0, lost: 0, neither: 0 };
  for (const aggregate of unitAggregates.values()) {
    const baselineLoss = Math.min(...SOTA_BASELINES.map((method) => aggregate.loss[method]));
    const before = aggregate.loss[beforeMethod] < baselineLoss;
    const after = aggregate.loss[afterMethod] < baselineLoss;
    if (before && after) counts.both += 1;
    else if (!before && after) counts.gained += 1;
    else if (before && !after) counts.lost += 1;
    else counts.neither += 1;
  }
  return { units: unitAggregates.size, ...counts, netGain: counts.gained - counts.lost };
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
  const pairStackQualityQuantiles = [...new Set(pairStacks
    .filter((config) => config.rule === "quality-gate")
    .map((config) => config.qualityQuantile))];
  const strategies = new Map(metaConfigs.map((config) => [config.id, {
    config,
    states: Array.from({ length: config.bucketCount }, () => createMetaState(expertNames(config.includeShrinkExperts).length)),
  }]));
  const allCells = [...cellsByDate.values()].flat();
  const sortedCells = [...allCells].sort((first, second) => first.priorQuality - second.priorQuality || first.id.localeCompare(second.id));
  const q1Ids = new Set(sortedCells.slice(0, Math.floor(sortedCells.length / 4)).map((cell) => cell.id));
  const q1FeatureStatsByPair = new Map();
  for (const cell of allCells) {
    if (!q1Ids.has(cell.id)) continue;
    if (!q1FeatureStatsByPair.has(cell.pair)) {
      q1FeatureStatsByPair.set(cell.pair, {
        cells: 0,
        targets: 0,
        priorQuality: 0,
        priorQualityGap: 0,
        safeAlpha: 0,
        nHistory: 0,
        nHistoryDates: 0,
        minimumHistory: Infinity,
        maximumHistory: -Infinity,
      });
    }
    const stats = q1FeatureStatsByPair.get(cell.pair);
    const targets = cell.rows.length;
    stats.cells += 1;
    stats.targets += targets;
    stats.priorQuality += targets * cell.priorQuality;
    stats.priorQualityGap += targets * cell.priorQualityGap;
    stats.safeAlpha += targets * cell.safeAlpha;
    stats.nHistory += targets * cell.nHistory;
    stats.nHistoryDates += targets * cell.nHistoryDates;
    stats.minimumHistory = Math.min(stats.minimumHistory, cell.nHistory);
    stats.maximumHistory = Math.max(stats.maximumHistory, cell.nHistory);
  }
  const dates = [...cellsByDate.keys()].sort();
  const lateDates = new Set(dates.slice(Math.floor(dates.length / 2)));
  const earlyDates = new Set(dates.filter((date) => !lateDates.has(date)));
  const priorQualities = [];
  const priorQualityGaps = [];
  const priorSafeAlphas = [];
  const aggregates = {
    overall: { n: 0, loss: {} },
    q1_strongest: { n: 0, loss: {} },
    late_half: { n: 0, loss: {} },
    q1_late_half: { n: 0, loss: {} },
    early_half: { n: 0, loss: {} },
    q1_early_half: { n: 0, loss: {} },
    low_support: { n: 0, loss: {} },
    low_support_late: { n: 0, loss: {} },
  };
  const dateAggregates = new Map();
  const q1DateAggregates = new Map();
  const pairAggregates = new Map();
  const q1PairAggregates = new Map();
  const selectorStates = new Map(selectors.map((selector) => [selector.id, createSelectorState(selectorExperts(selector))]));
  const pairStackStates = new Map(pairStacks.map((config) => [config.id, new Map()]));
  const globalSelectionTrace = new Map(pairStacks
    .filter((config) => config.scope === "global" && config.rule === "ftl")
    .map((config) => [config.id, []]));
  const supportGateUsage = new Map(pairStacks
    .filter((config) => config.rule === "support-gate")
    .map((config) => [config.id, { pairDateCells: 0, fallbackPairDateCells: 0, targetEvaluations: 0, fallbackTargetEvaluations: 0 }]));
  const contextualFtlUsage = new Map([FRONTIER_Q1_FTL_ID].map((id) => [id, {
    pairDateCells: 0,
    targetEvaluations: 0,
    expertPairDateCells: {},
    expertTargetEvaluations: {},
  }]));

  for (const date of dates) {
    const cells = cellsByDate.get(date);
    const thresholdsByBucketCount = new Map([1, 4].map((bucketCount) => [bucketCount, rollingThresholds(priorQualities, bucketCount)]));
    const quality2 = rollingThresholds(priorQualities, 2);
    const gap2 = rollingThresholds(priorQualityGaps, 2);
    const gap4 = rollingThresholds(priorQualityGaps, 4);
    const alpha2 = rollingThresholds(priorSafeAlphas, 2);
    for (const cell of cells) {
      const [modelA, modelB] = cell.pair.split("\u0000");
      const qualityBucket = bucketIndex(cell.priorQuality, quality2);
      const gapBucket2 = bucketIndex(cell.priorQualityGap, gap2);
      const alphaBucket = bucketIndex(cell.safeAlpha, alpha2);
      cell.contextStateKeys = {
        gap2: `g${gapBucket2}`,
        gap4: `g${bucketIndex(cell.priorQualityGap, gap4)}`,
        "gap-alpha": `g${gapBucket2}-a${alphaBucket}`,
        "quality-gap-alpha": `q${qualityBucket}-g${gapBucket2}-a${alphaBucket}`,
        "support-gap": `s${cell.nHistory < 1000 ? 0 : 1}-g${gapBucket2}`,
        sameProvider: modelA.split("-")[0] === modelB.split("-")[0],
      };
    }
    for (const cell of cells) {
      for (const [id, usage] of contextualFtlUsage) {
        const config = pairStacks.find((candidate) => candidate.id === id);
        const states = pairStackStates.get(id);
        const stateKey = pairStackStateKey(config, cell);
        if (!states.has(stateKey)) states.set(stateKey, createMetaState(config.experts.length));
        const state = states.get(stateKey);
        const selectedIndex = state.nFeedback > 0 ? minimumIndex(state.expertLossSum) : config.initialIndex;
        const expert = config.experts[selectedIndex];
        usage.pairDateCells += 1;
        usage.targetEvaluations += cell.rows.length;
        usage.expertPairDateCells[expert] = (usage.expertPairDateCells[expert] ?? 0) + 1;
        usage.expertTargetEvaluations[expert] = (usage.expertTargetEvaluations[expert] ?? 0) + cell.rows.length;
      }
    }
    const sortedPriorQualities = [...priorQualities].sort((first, second) => first - second);
    const pairStackQualityThresholds = new Map(pairStackQualityQuantiles.map((probability) => [
      probability,
      sortedPriorQualities.length ? quantile(sortedPriorQualities, probability) : null,
    ]));
    const gateThresholds = new Map([...new Set(gates.flatMap((gate) => [gate.strongQuantile, gate.middleQuantile]
      .filter((value) => value !== undefined)))]
      .map((probability) => [probability, sortedPriorQualities.length ? quantile(sortedPriorQualities, probability) : null]));
    const updates = new Map();
    const selectedExperts = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector)[selectedExpertIndex(selector, selectorStates.get(selector.id))]]));
    const selectorRoundLoss = new Map(selectors.map((selector) => [selector.id, selectorExperts(selector).map(() => 0)]));
    const pairStackUpdates = new Map(pairStacks.map((config) => [config.id, new Map()]));
    for (const config of pairStacks.filter((candidate) => candidate.scope === "global" && candidate.rule === "ftl")) {
      const states = pairStackStates.get(config.id);
      if (!states.has("__global__")) states.set("__global__", createMetaState(config.experts.length));
      const state = states.get("__global__");
      const selectedIndex = state.nFeedback > 0 ? minimumIndex(state.expertLossSum) : config.initialIndex;
      globalSelectionTrace.get(config.id).push({ date, expert: config.experts[selectedIndex], nFeedback: state.nFeedback });
    }
    let selectorRoundTargets = 0;
    for (const [id, strategy] of strategies) updates.set(id, Array.from({ length: strategy.config.bucketCount }, () => ({ vectors: [], outcomes: [] })));

    for (const cell of cells) {
      const isQ1 = q1Ids.has(cell.id);
      for (const config of pairStacks.filter((candidate) => candidate.rule === "support-gate")) {
        const usage = supportGateUsage.get(config.id);
        usage.pairDateCells += 1;
        if (cell[config.field] < config.threshold) usage.fallbackPairDateCells += 1;
      }
      for (const row of cell.rows) {
        const predictions = { ...row.basePredictions, ...row.hierarchicalModelPredictions };
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
          const stateKey = pairStackStateKey(config, cell);
          if (!states.has(stateKey)) states.set(stateKey, createMetaState(config.experts.length));
          const vector = config.experts.map((expert) => predictions[expert]);
          if (config.rule === "support-gate") {
            const usage = supportGateUsage.get(config.id);
            usage.targetEvaluations += 1;
            if (cell[config.field] < config.threshold) usage.fallbackTargetEvaluations += 1;
          }
          predictions[config.id] = config.rule === "guardian"
            ? guardianPrediction(vector, states.get(stateKey), config.tolerance)
            : config.rule === "fixed"
              ? fixedMixturePrediction(vector, config.prior)
              : config.rule === "ftl"
                ? followTheLeaderPrediction(vector, states.get(stateKey), config.initialIndex)
                : config.rule === "quality-gate"
                  ? vector[
                    pairStackQualityThresholds.get(config.qualityQuantile) !== null
                      && cell.priorQuality <= pairStackQualityThresholds.get(config.qualityQuantile)
                      ? 0
                      : 1
                  ]
                : config.rule === "support-gate"
                  ? supportGatePrediction(vector, cell, config.field, config.threshold)
                : priorWeightedStrategyPrediction(vector, states.get(stateKey), config.etaScale, config.prior);
          const updates = pairStackUpdates.get(config.id);
          if (!updates.has(stateKey)) updates.set(stateKey, { vectors: [], outcomes: [] });
          updates.get(stateKey).vectors.push(vector);
          updates.get(stateKey).outcomes.push(row.outcome);
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
        if (cell.nHistory < 1000) targets.push(aggregates.low_support);
        if (cell.nHistory < 1000 && lateDates.has(date)) targets.push(aggregates.low_support_late);
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
    priorQualityGaps.push(...cells.map((cell) => cell.priorQualityGap));
    priorSafeAlphas.push(...cells.map((cell) => cell.safeAlpha));
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
  const trailingWindowRobustness = Object.fromEntries([3, 5, 8].map((windowSize) => {
    const windowDates = dates.slice(-windowSize);
    const windowDateSet = new Set(windowDates);
    const overallDates = subsetAggregates(dateAggregates, windowDateSet);
    const q1Dates = subsetAggregates(q1DateAggregates, windowDateSet);
    return [windowSize, {
      dates: windowDates,
      overall: {
        ...summarizeAggregateSubset(overallDates, FROZEN_FINALIST_IDS),
        dateSota: Object.fromEntries(FROZEN_FINALIST_IDS.map((method) => [method, sotaRate(overallDates, method)])),
      },
      strongestQ1: {
        ...summarizeAggregateSubset(q1Dates, FROZEN_FINALIST_IDS),
        dateSota: q1Dates.size
          ? Object.fromEntries(FROZEN_FINALIST_IDS.map((method) => [method, sotaRate(q1Dates, method)]))
          : null,
      },
    }];
  }));
  const frontierV2TrailingWindow = Object.fromEntries([3, 5, 8].map((windowSize) => {
    const windowDates = dates.slice(-windowSize);
    const windowDateSet = new Set(windowDates);
    const overallDates = subsetAggregates(dateAggregates, windowDateSet);
    const q1Dates = subsetAggregates(q1DateAggregates, windowDateSet);
    const methods = [
      HSLOP_SUPPORT_OVERALL_ID,
      CROSS_SKILL_FIXED_MEAN_GATE_ID,
      FRONTIER_JOINT_ID,
      FRONTIER_COVERAGE_ID,
      FRONTIER_STRONG_ID,
      FRONTIER_Q1_FTL_ID,
      FRONTIER_Q1_HEDGE_ID,
    ];
    return [windowSize, {
      dates: windowDates,
      overall: {
        ...summarizeAggregateSubset(overallDates, methods),
        dateSota: Object.fromEntries(methods.map((method) => [method, sotaRate(overallDates, method)])),
      },
      strongestQ1: {
        ...summarizeAggregateSubset(q1Dates, methods),
        dateSota: q1Dates.size
          ? Object.fromEntries(methods.map((method) => [method, sotaRate(q1Dates, method)]))
          : null,
      },
    }];
  }));
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
  const overallChampionId = HSLOP_OVERALL_ID;
  const balancedRecommendationId = HSLOP_BALANCED_ID;
  const strongestGroupChampionId = HSLOP_STRONG_ID;
  const coverageChampionId = HSLOP_COVERAGE_ID;
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
  const configuredMethodIds = configs.map((config) => config.id);
  const allLegalMethodIds = Object.keys(aggregates.overall.loss)
    .filter((method) => !SOTA_BASELINES.includes(method));
  const q1PairFeatureDiagnostics = [...q1FeatureStatsByPair].map(([pair, stats]) => {
    const aggregate = q1PairAggregates.get(pair);
    const baselineMethod = SOTA_BASELINES.reduce((best, method) => (
      aggregate.loss[method] < aggregate.loss[best] ? method : best
    ), SOTA_BASELINES[0]);
    const baselineBrier = aggregate.loss[baselineMethod] / aggregate.n;
    const referenceBrier = aggregate.loss[CROSS_SKILL_FIXED_MEAN_GATE_ID] / aggregate.n;
    const [modelA, modelB] = pair.split("\u0000");
    return {
      pair,
      modelA,
      modelB,
      sameProvider: modelA.split("-")[0] === modelB.split("-")[0],
      cells: stats.cells,
      targetEvaluations: stats.targets,
      meanPriorQuality: stats.priorQuality / stats.targets,
      meanPriorQualityGap: stats.priorQualityGap / stats.targets,
      meanSafeAlpha: stats.safeAlpha / stats.targets,
      meanHistoryTargets: stats.nHistory / stats.targets,
      meanHistoryDates: stats.nHistoryDates / stats.targets,
      minimumHistoryTargets: stats.minimumHistory,
      maximumHistoryTargets: stats.maximumHistory,
      bestBaselineMethod: baselineMethod,
      bestBaselineBrier: baselineBrier,
      referenceBrier,
      referenceGain: baselineBrier - referenceBrier,
      referenceStrictSota: referenceBrier < baselineBrier,
    };
  }).sort((first, second) => first.referenceGain - second.referenceGain);
  return {
    slices: brierBySlice,
    staticMethods,
    candidates: candidateRows,
    topOverall: candidateRows.slice(0, 15),
    topQ1: [...candidateRows].sort((first, second) => first.q1Brier - second.q1Brier).slice(0, 15),
    topDateSota: [...candidateRows].sort((first, second) => second.dateSota.rate - first.dateSota.rate || first.overallBrier - second.overallBrier).slice(0, 15),
    topQ1DateSota: [...candidateRows].sort((first, second) => second.q1DateSota.rate - first.q1DateSota.rate || first.q1Brier - second.q1Brier).slice(0, 15),
    pairOracleDiagnostics: {
      configuredCandidates: pairOracleDiagnostics(q1PairAggregates, configuredMethodIds, CROSS_SKILL_FIXED_MEAN_GATE_ID),
      allLegalPredictionMethods: pairOracleDiagnostics(q1PairAggregates, allLegalMethodIds, CROSS_SKILL_FIXED_MEAN_GATE_ID),
      warning: "Post-hoc per-pair oracle upper bounds are diagnostics only and are not deployable algorithms.",
    },
    q1PairFeatureDiagnostics,
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
      sotaDefinition: `Raw Brier no higher than the best of: ${SOTA_BASELINES.join(", ")}; strictCount separately requires a strictly lower score`,
      deploymentStatus: "research candidate only; freeze before independent confirmatory evaluation",
    },
    frontierV2Recommendation: {
      jointOverallAndStrongestGroup: candidatesById.get(FRONTIER_JOINT_ID),
      strongestGroupCoverage: candidatesById.get(FRONTIER_COVERAGE_ID),
      strongestGroupMean: candidatesById.get(FRONTIER_STRONG_ID),
      strongestGroupFtl: candidatesById.get(FRONTIER_Q1_FTL_ID),
      conservativeCoverageHedge: candidatesById.get(FRONTIER_Q1_HEDGE_ID),
      jointOverallVsV1ChampionDateBootstrap: dateBlockBootstrap(dateAggregates, HSLOP_SUPPORT_OVERALL_ID, FRONTIER_JOINT_ID, 20_000, 20_260_920),
      jointStrongestQ1VsV1ChampionDateBootstrap: dateBlockBootstrap(q1DateAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_JOINT_ID, 20_000, 20_260_921),
      jointLateOverallVsV1ChampionDateBootstrap: dateBlockBootstrap(lateDateAggregates, HSLOP_SUPPORT_OVERALL_ID, FRONTIER_JOINT_ID, 20_000, 20_260_922),
      overallVsV1DateBootstrap: dateBlockBootstrap(dateAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID, 20_000, 20_260_923),
      strongestQ1VsV1DateBootstrap: dateBlockBootstrap(q1DateAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID, 20_000, 20_260_924),
      lateStrongestQ1VsV1DateBootstrap: dateBlockBootstrap(q1LateDateAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID, 20_000, 20_260_925),
      pairComparisonVsV1: pairComparison(pairAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID),
      strongestQ1PairComparisonVsV1: pairComparison(q1PairAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID),
      strongestQ1SotaTransitionVsV1: sotaTransition(q1PairAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_Q1_FTL_ID),
      jointStrongestQ1SotaTransitionVsMeanV1: sotaTransition(q1PairAggregates, CROSS_SKILL_FIXED_MEAN_GATE_ID, FRONTIER_JOINT_ID),
      jointOverallPairSotaTransitionVsOverallV1: sotaTransition(pairAggregates, HSLOP_SUPPORT_OVERALL_ID, FRONTIER_JOINT_ID),
      coverageStrongestQ1SotaTransitionVsCoverageV1: sotaTransition(q1PairAggregates, CROSS_SKILL_QUALITY_GATE_ID, FRONTIER_COVERAGE_ID),
      candidateSearchWarning: "Selected on the same historical replay; discovery evidence only until frozen and evaluated on future dates.",
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
      HSLOP_META_OVERALL_ID,
      HSLOP_META_STABLE_ID,
      HSLOP_META_BALANCED_ID,
      HSLOP_META_STRONG_MEAN_ID,
      HSLOP_META_STRONG_SOTA_ID,
      HSLOP_SUPPORT_NODEP_ID,
      HSLOP_SUPPORT_CALIBRATED_ID,
      CROSS_SKILL_STRONG_MEAN_ID,
      CROSS_SKILL_COVERAGE_ID,
      CROSS_SKILL_FIXED_MEAN_GATE_ID,
      CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
      CROSS_SKILL_QUALITY_GATE_ID,
      HSLOP_SUPPORT_OVERALL_ID,
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
    hslopComplementarity: {
      methods: [overallChampionId, balancedRecommendationId, strongestGroupChampionId, coverageChampionId],
      pairCoverage: methodSetCoverage(
        pairAggregates,
        [overallChampionId, balancedRecommendationId, strongestGroupChampionId, coverageChampionId],
      ),
      strongestPairCoverage: methodSetCoverage(
        q1PairAggregates,
        [overallChampionId, balancedRecommendationId, strongestGroupChampionId, coverageChampionId],
      ),
      dateCoverage: methodSetCoverage(
        dateAggregates,
        [overallChampionId, balancedRecommendationId, strongestGroupChampionId, coverageChampionId],
      ),
    },
    metaAggregationRecommendation: {
      overallMeanChampion: candidatesById.get(HSLOP_META_OVERALL_ID),
      stableOnlineHedge: candidatesById.get(HSLOP_META_STABLE_ID),
      balancedFixedMixture: candidatesById.get(HSLOP_META_BALANCED_ID),
      strongestMeanMixture: candidatesById.get(HSLOP_META_STRONG_MEAN_ID),
      strongestSotaMixture: candidatesById.get(HSLOP_META_STRONG_SOTA_ID),
      overallPairCoverageChampion: candidatesById.get(coverageChampionId),
      interpretation: "fixed mixtures reduce squared-error variance; global FTL/Hedge adapt only from strictly prior dates; all meta hyperparameters remain post-hoc candidates",
      balancedVsBaseDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        balancedRecommendationId,
        HSLOP_META_BALANCED_ID,
        20_000,
        20_260_883,
      ),
      balancedVsNoDependenceDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        "no-dependence-4",
        HSLOP_META_BALANCED_ID,
        20_000,
        20_260_884,
      ),
      balancedQ1VsNoDependenceDateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        "no-dependence-4",
        HSLOP_META_BALANCED_ID,
        20_000,
        20_260_885,
      ),
      strongestMeanQ1VsNoDependenceDateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        "no-dependence-4",
        HSLOP_META_STRONG_MEAN_ID,
        20_000,
        20_260_886,
      ),
      balancedPairComparisonVsNoDependence: pairComparison(pairAggregates, "no-dependence-4", HSLOP_META_BALANCED_ID),
      balancedQ1PairComparisonVsNoDependence: pairComparison(q1PairAggregates, "no-dependence-4", HSLOP_META_BALANCED_ID),
      strongestSotaQ1PairComparisonVsNoDependence: pairComparison(q1PairAggregates, "no-dependence-4", HSLOP_META_STRONG_SOTA_ID),
    },
    supportGateRecommendation: {
      overallMeanChampion: candidatesById.get(HSLOP_SUPPORT_OVERALL_ID),
      usage: supportGateUsage.get(HSLOP_SUPPORT_OVERALL_ID),
      previousNoDependenceFallback: candidatesById.get(HSLOP_SUPPORT_NODEP_ID),
      previousCalibratedFallback: candidatesById.get(HSLOP_SUPPORT_CALIBRATED_ID),
      previousFixedSkillMeanGate: candidatesById.get(CROSS_SKILL_FIXED_MEAN_GATE_ID),
      interpretation: "below 1000 strictly-prior common targets, use a conservative calibrated fallback; otherwise use discounted global FTL to select the 10%, 20%, or 30% hierarchical skill share from strictly earlier dates",
      vsNoDependenceDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        "no-dependence-4",
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_893,
      ),
      vsMetaBalancedDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        HSLOP_META_BALANCED_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_894,
      ),
      lateVsMetaBalancedDateBootstrap: dateBlockBootstrap(
        lateDateAggregates,
        HSLOP_META_BALANCED_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_895,
      ),
      vsPreviousNoDependenceFallbackDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        HSLOP_SUPPORT_NODEP_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_896,
      ),
      vsPreviousCalibratedFallbackDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        HSLOP_SUPPORT_CALIBRATED_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_897,
      ),
      vsPreviousFixedSkillMeanDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        CROSS_SKILL_FIXED_MEAN_GATE_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_900,
      ),
      pairComparisonVsNoDependence: pairComparison(pairAggregates, "no-dependence-4", HSLOP_SUPPORT_OVERALL_ID),
    },
    crossPairSkillRecommendation: {
      directSkillPilot: staticMethods.find((method) => method.method === MODEL_SKILL_PILOT_ID),
      strongestMeanMixture: candidatesById.get(CROSS_SKILL_STRONG_MEAN_ID),
      fixedMeanGate: candidatesById.get(CROSS_SKILL_FIXED_MEAN_GATE_ID),
      onlineOverallChampion: candidatesById.get(HSLOP_SUPPORT_OVERALL_ID),
      onlineBalancedHedge: candidatesById.get(CROSS_SKILL_ONLINE_HEDGE_GATE_ID),
      overallCoverageChampion: candidatesById.get(CROSS_SKILL_COVERAGE_ID),
      strongestCoverageChampion: candidatesById.get(CROSS_SKILL_QUALITY_GATE_ID),
      interpretation: "hierarchical model skill is not competitive alone, but small fixed or strictly-prior online shares supply complementary pair weighting that expands the mean and SOTA frontiers",
      unifiedVsPreviousOverallDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        HSLOP_SUPPORT_CALIBRATED_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_898,
      ),
      strongestMeanVsPreviousQ1DateBootstrap: dateBlockBootstrap(
        q1DateAggregates,
        HSLOP_META_STRONG_MEAN_ID,
        CROSS_SKILL_STRONG_MEAN_ID,
        20_000,
        20_260_899,
      ),
      onlineOverallVsFixedMeanDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        CROSS_SKILL_FIXED_MEAN_GATE_ID,
        HSLOP_SUPPORT_OVERALL_ID,
        20_000,
        20_260_900,
      ),
      onlineHedgeVsFixedMeanDateBootstrap: dateBlockBootstrap(
        dateAggregates,
        CROSS_SKILL_FIXED_MEAN_GATE_ID,
        CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
        20_000,
        20_260_901,
      ),
      unifiedPairComparisonVsNoDependence: pairComparison(pairAggregates, "no-dependence-4", HSLOP_SUPPORT_OVERALL_ID),
      unifiedQ1PairComparisonVsNoDependence: pairComparison(q1PairAggregates, "no-dependence-4", HSLOP_SUPPORT_OVERALL_ID),
    },
    globalSelectionTrace: Object.fromEntries(globalSelectionTrace),
    trailingWindowRobustness,
    frontierV2TrailingWindow,
    contextualFtlUsage: Object.fromEntries(contextualFtlUsage),
    supportGateUsage: Object.fromEntries(supportGateUsage),
    selectedDateBreakdown: unitBreakdown(dateAggregates, [
      "no-dependence-4",
      legacyBalancedId,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
      ...FROZEN_FINALIST_IDS,
      FRONTIER_Q1_FTL_ID,
      FRONTIER_Q1_HEDGE_ID,
      FRONTIER_JOINT_ID,
      FRONTIER_COVERAGE_ID,
      FRONTIER_STRONG_ID,
    ]),
    selectedQ1DateBreakdown: unitBreakdown(q1DateAggregates, [
      "no-dependence-4",
      legacyBalancedId,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
      ...FROZEN_FINALIST_IDS,
      FRONTIER_Q1_FTL_ID,
      FRONTIER_Q1_HEDGE_ID,
      FRONTIER_JOINT_ID,
      FRONTIER_COVERAGE_ID,
      FRONTIER_STRONG_ID,
    ]),
    selectedPairBreakdown: unitBreakdown(pairAggregates, [
      ...SOTA_BASELINES,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
      HSLOP_META_BALANCED_ID,
      HSLOP_META_STRONG_SOTA_ID,
      HSLOP_SUPPORT_NODEP_ID,
      HSLOP_SUPPORT_CALIBRATED_ID,
      CROSS_SKILL_STRONG_MEAN_ID,
      CROSS_SKILL_COVERAGE_ID,
      CROSS_SKILL_FIXED_MEAN_GATE_ID,
      CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
      CROSS_SKILL_QUALITY_GATE_ID,
      HSLOP_SUPPORT_OVERALL_ID,
      FRONTIER_Q1_FTL_ID,
      FRONTIER_Q1_HEDGE_ID,
      FRONTIER_JOINT_ID,
      FRONTIER_COVERAGE_ID,
      FRONTIER_STRONG_ID,
    ]),
    selectedQ1PairBreakdown: unitBreakdown(q1PairAggregates, [
      ...SOTA_BASELINES,
      overallChampionId,
      balancedRecommendationId,
      strongestGroupChampionId,
      coverageChampionId,
      HSLOP_META_BALANCED_ID,
      HSLOP_META_STRONG_SOTA_ID,
      HSLOP_SUPPORT_NODEP_ID,
      HSLOP_SUPPORT_CALIBRATED_ID,
      CROSS_SKILL_STRONG_MEAN_ID,
      CROSS_SKILL_COVERAGE_ID,
      CROSS_SKILL_FIXED_MEAN_GATE_ID,
      CROSS_SKILL_ONLINE_HEDGE_GATE_ID,
      CROSS_SKILL_QUALITY_GATE_ID,
      HSLOP_SUPPORT_OVERALL_ID,
      FRONTIER_Q1_FTL_ID,
      FRONTIER_Q1_HEDGE_ID,
      FRONTIER_JOINT_ID,
      FRONTIER_COVERAGE_ID,
      FRONTIER_STRONG_ID,
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

  const modelCalibrationSnapshots = buildModelCalibrationSnapshots(history);
  const { cellsByDate, affineDiagnostics } = await buildFrozenCells(history, parameters, modelCalibrationSnapshots);
  const summary = evaluateStrategies(cellsByDate);
  const result = {
    schemaVersion: "0.8.0-frontier-exploration",
    generatedAt: new Date().toISOString(),
    status: "post_hoc_candidate_search_not_independent_oos",
    protocol: {
      outcomeVisibility: "all forecasts on date t are frozen before any date-t outcome updates pair or cross-pair states",
      qualityFeature: "lower of the two pair-specific cumulative Raw Brier scores from strictly earlier forecast dates",
      rollingBuckets: "quality thresholds at date t use feature values from scored pair-date cells strictly before t",
      groupingFeatures: "official sourceKey and Dataset/Market questionType; group-specific states use strictly earlier dates only",
      probabilitySafeMethods: "group-linear predictions are convex combinations; group-logit predictions use a logistic link, so neither requires clipping",
      dependenceFeature: "safeAlpha is the published strictly-prior synthesis of Adjusted POG, High-Loss Lift, Adjusted-Loss Correlation, quality gap, and support",
      metaAggregation: "fixed mixtures use no outcomes at prediction time; FTL and Hedge weights on date t are frozen from losses on strictly earlier dates",
      supportGate: "cold-start routing uses only strictly-prior common-target count or prior-date count; reported SOTA includes both no-worse and strictly-better rates",
      crossPairCalibration: "model and provider probability-bin calibration snapshots use only earlier forecast dates; the selected cold-start expert is pair-ridge weighted and shrunk 50% toward No-Dependence-4",
      crossPairSkill: "model and provider Brier skill snapshots use only earlier forecast dates; pair ridge weights shrink toward source-conditioned hierarchical model-skill priors",
      onlineSkillShare: "global FTL and Hedge choose among frozen 10%, 20%, and 30% skill shares using only losses from strictly earlier dates; the rolling quality gate uses only prior pair-quality values",
      frontierStack: "V2 pair-specific and global FTL/Hedge stacks include the four incumbent SOTA controls and frozen V1 frontier candidates; all date-t weights use losses from dates strictly before t",
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
      allCrossPairSnapshotsStrictlyPrior: [...modelCalibrationSnapshots].every(([date, snapshot]) => (
        snapshot.historyLastDate === null || snapshot.historyLastDate < date
      )),
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
