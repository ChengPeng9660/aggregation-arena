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
const DEFAULT_OUTPUT = "output/research/dash-expert-subsets-2026-08-23.json";
const BOOTSTRAP_REPLICATES = 20_000;
const BOOTSTRAP_SEED = 20_260_823;

const VARIANTS = {
  "full-7": {
    label: "DASH-Full-7",
    experts: ["model-a", "model-b", "equal-mean", "log-odds", "cptec", "piecewise-odds", "safemix-2"],
  },
  "core-5": {
    label: "DASH-Core-5",
    experts: ["model-a", "model-b", "two-model-hedge", "safemix-2", "cptec"],
  },
  "core-4": {
    label: "DASH-Core-4",
    experts: ["model-a", "model-b", "two-model-hedge", "safemix-2"],
  },
  "no-dependence-4": {
    label: "DASH-No-Dependence-4",
    experts: ["model-a", "model-b", "two-model-hedge", "cptec"],
  },
};

const EXPECTED_REPRODUCTION = {
  "full-7": 0.157139,
  "two-model-hedge": 0.157194,
  "safemix-2": 0.158019,
  cptec: 0.158061,
  "log-odds": 0.158525,
  "equal-mean": 0.158836,
  "historical-best": 0.159045,
  "piecewise-odds": 0.159545,
};

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

function metaState(expertCount) {
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

function expertVector(id, baseForecast, first, second) {
  const twoModelHedge = baseForecast.modelWeights[0] * first + baseForecast.modelWeights[1] * second;
  const values = {
    "model-a": first,
    "model-b": second,
    "equal-mean": baseForecast.expertPredictions[2],
    "log-odds": baseForecast.expertPredictions[3],
    cptec: baseForecast.expertPredictions[4],
    "piecewise-odds": baseForecast.expertPredictions[5],
    "safemix-2": baseForecast.expertPredictions[6],
    "two-model-hedge": twoModelHedge,
  };
  return VARIANTS[id].experts.map((expert) => values[expert]);
}

function ensureAggregate(container, key) {
  if (!container.has(key)) container.set(key, { n: 0, loss: {} });
  return container.get(key);
}

function addLoss(aggregate, method, value) {
  aggregate.loss[method] = (aggregate.loss[method] ?? 0) + value;
}

function summarizeAggregate(aggregate) {
  return Object.fromEntries(Object.entries(aggregate.loss).map(([method, loss]) => [method, loss / aggregate.n]));
}

function dateBootstrap(dateAggregates, baseline, comparison, replicates, seed) {
  const dates = [...dateAggregates.keys()].sort();
  const random = mulberry32(seed);
  const samples = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let differenceSum = 0;
    let n = 0;
    for (let draw = 0; draw < dates.length; draw += 1) {
      const aggregate = dateAggregates.get(dates[Math.floor(random() * dates.length)]);
      differenceSum += aggregate.loss[baseline] - aggregate.loss[comparison];
      n += aggregate.n;
    }
    samples.push(differenceSum / n);
  }
  samples.sort((first, second) => first - second);
  return {
    unit: "forecast_date",
    replicates,
    seed,
    estimate_direction: `${baseline}_brier_minus_${comparison}_brier; positive means ${comparison} is better`,
    ci95: [quantile(samples, 0.025), quantile(samples, 0.975)],
    probability_positive: samples.filter((value) => value > 0).length / samples.length,
  };
}

function pairComparison(pairAggregates, baseline, comparison) {
  let better = 0;
  let worse = 0;
  let ties = 0;
  const differences = [];
  for (const aggregate of pairAggregates.values()) {
    const difference = (aggregate.loss[baseline] - aggregate.loss[comparison]) / aggregate.n;
    differences.push(difference);
    if (difference > 1e-15) better += 1;
    else if (difference < -1e-15) worse += 1;
    else ties += 1;
  }
  differences.sort((first, second) => first - second);
  return {
    pairs: differences.length,
    comparison_better_pairs: better,
    comparison_worse_pairs: worse,
    ties,
    comparison_better_fraction: better / differences.length,
    difference_direction: `${baseline}_brier_minus_${comparison}_brier; positive means ${comparison} is better`,
    median_difference: quantile(differences, 0.5),
    q25_difference: quantile(differences, 0.25),
    q75_difference: quantile(differences, 0.75),
  };
}

function splitSummary(dateAggregates) {
  const dates = [...dateAggregates.keys()].sort();
  const splitIndex = Math.floor(dates.length / 2);
  const periods = {
    early: dates.slice(0, splitIndex),
    late: dates.slice(splitIndex),
  };
  return Object.fromEntries(Object.entries(periods).map(([period, periodDates]) => {
    const aggregate = { n: 0, loss: {} };
    for (const date of periodDates) {
      const source = dateAggregates.get(date);
      aggregate.n += source.n;
      for (const [method, loss] of Object.entries(source.loss)) addLoss(aggregate, method, loss);
    }
    return [period, {
      dates: periodDates,
      target_evaluations: aggregate.n,
      brier: summarizeAggregate(aggregate),
    }];
  }));
}

function qualityQuartiles(rows, qualityLabel) {
  const sorted = [...rows].sort((first, second) => first.quality - second.quality || first.id.localeCompare(second.id));
  return Array.from({ length: 4 }, (_, quartileIndex) => {
    const start = Math.floor(quartileIndex * sorted.length / 4);
    const end = Math.floor((quartileIndex + 1) * sorted.length / 4);
    const members = sorted.slice(start, end);
    const aggregate = { n: 0, loss: {} };
    let referenceLoss = 0;
    for (const member of members) {
      aggregate.n += member.n;
      referenceLoss += member.referenceLoss;
      for (const [method, loss] of Object.entries(member.loss)) addLoss(aggregate, method, loss);
    }
    const brierByMethod = summarizeAggregate(aggregate);
    const referenceBrier = referenceLoss / aggregate.n;
    return {
      id: `q${quartileIndex + 1}`,
      label: quartileIndex === 0 ? "Q1 strongest" : quartileIndex === 3 ? "Q4 weakest" : `Q${quartileIndex + 1}`,
      quality_definition: qualityLabel,
      rows: members.length,
      target_evaluations: aggregate.n,
      quality_min: members[0].quality,
      quality_max: members.at(-1).quality,
      quality_mean_unweighted: members.reduce((sum, member) => sum + member.quality, 0) / members.length,
      reference_brier: referenceBrier,
      brier: brierByMethod,
      gain_vs_reference: Object.fromEntries(Object.entries(brierByMethod)
        .filter(([method]) => ["full-7", "core-5", "core-4", "no-dependence-4", "two-model-hedge"].includes(method))
        .map(([method, value]) => [method, referenceBrier - value])),
      full_7_minus_compact: Object.fromEntries(["core-5", "core-4", "no-dependence-4"]
        .map((method) => [method, brierByMethod["full-7"] - brierByMethod[method]])),
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyBytes = await readFile(args.history);
  const parameterBytes = await readFile(args.parameters);
  const history = JSON.parse(historyBytes);
  const parameters = JSON.parse(parameterBytes);
  const historySha256 = createHash("sha256").update(historyBytes).digest("hex");

  if (historySha256 !== parameters.history_sha256) throw new Error("History hash does not match published DASH parameters");
  if (!parameters.audit.all_history_dates_strictly_prior) throw new Error("Published parameter audit does not guarantee strictly prior dates");

  const parametersByPair = new Map();
  for (const [date, historyLastDate, modelA, modelB, nHistory, nHistoryDates, historyBestSide, safeAlpha] of parameters.records) {
    if (historyLastDate >= date) throw new Error(`Non-prior parameter row for ${modelA} / ${modelB} on ${date}`);
    const key = pairKey(modelA, modelB);
    if (!parametersByPair.has(key)) parametersByPair.set(key, new Map());
    parametersByPair.get(key).set(date, { historyBestSide, safeAlpha, historyLastDate, nHistory, nHistoryDates });
  }

  const overall = { n: 0, loss: {} };
  const dateAggregates = new Map();
  const pairAggregates = new Map();
  const pairDateCells = [];
  let scoredPairDateCells = 0;

  for (const [key, pairParameters] of parametersByPair) {
    const [modelA, modelB] = key.split("\u0000");
    const eventsByDate = new Map();
    for (const event of history.events) {
      if (event.forecasts[modelA] === undefined || event.forecasts[modelB] === undefined) continue;
      if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
      eventsByDate.get(event.date).push(event);
    }

    let fullState = createDash2State();
    const variantStates = Object.fromEntries(Object.entries(VARIANTS)
      .filter(([id]) => id !== "full-7")
      .map(([id, definition]) => [id, metaState(definition.experts.length)]));

    for (const date of [...eventsByDate.keys()].sort()) {
      const round = eventsByDate.get(date);
      const priorParameters = pairParameters.get(date) ?? null;
      const frozenFull = [];
      const frozenVariants = Object.fromEntries(Object.keys(variantStates).map((id) => [id, []]));
      const outcomes = [];
      const pairDateCell = priorParameters ? {
        id: `${key}\u0000${date}`,
        pair: key,
        date,
        quality: Math.min(fullState.expertLossSum[0], fullState.expertLossSum[1]) / fullState.nFeedback,
        n: 0,
        loss: {},
      } : null;
      if (priorParameters) scoredPairDateCells += 1;

      for (const event of round) {
        const first = event.forecasts[modelA];
        const second = event.forecasts[modelB];
        const baseForecast = forecastDash2Pair(first, second, fullState, priorParameters);
        const predictions = {
          "full-7": baseForecast.dashHedge,
          "two-model-hedge": baseForecast.modelWeights[0] * first + baseForecast.modelWeights[1] * second,
          "safemix-2": baseForecast.safeMix,
          cptec: baseForecast.expertPredictions[4],
          "log-odds": baseForecast.expertPredictions[3],
          "equal-mean": baseForecast.expertPredictions[2],
          "historical-best": priorParameters?.historyBestSide === "b" ? second : first,
          "piecewise-odds": baseForecast.expertPredictions[5],
          "model-a": first,
          "model-b": second,
        };

        for (const id of Object.keys(variantStates)) {
          const vector = expertVector(id, baseForecast, first, second);
          predictions[id] = metaPrediction(vector, variantStates[id]);
          frozenVariants[id].push(vector);
        }

        frozenFull.push(baseForecast.expertPredictions);
        outcomes.push(event.outcome);

        if (priorParameters) {
          const dateAggregate = ensureAggregate(dateAggregates, date);
          const pairAggregate = ensureAggregate(pairAggregates, key);
          for (const aggregate of [overall, dateAggregate, pairAggregate, pairDateCell]) aggregate.n += 1;
          for (const [method, prediction] of Object.entries(predictions)) {
            const loss = brier(prediction, event.outcome);
            addLoss(overall, method, loss);
            addLoss(dateAggregate, method, loss);
            addLoss(pairAggregate, method, loss);
            addLoss(pairDateCell, method, loss);
          }
        }
      }

      if (pairDateCell) {
        pairDateCell.referenceLoss = pairDateCell.loss["historical-best"];
        pairDateCells.push(pairDateCell);
      }

      fullState = updateDash2State(fullState, frozenFull, outcomes);
      for (const id of Object.keys(variantStates)) {
        variantStates[id] = updateMetaState(variantStates[id], frozenVariants[id], outcomes);
      }
    }
  }

  const overallBrier = summarizeAggregate(overall);
  for (const [method, expected] of Object.entries(EXPECTED_REPRODUCTION)) {
    const actualRounded = Number(overallBrier[method].toFixed(6));
    if (actualRounded !== expected) throw new Error(`Reproduction mismatch for ${method}: ${actualRounded} != ${expected}`);
  }
  if (parametersByPair.size !== parameters.audit.unique_pairs) throw new Error("Unique pair count mismatch");
  if (scoredPairDateCells !== parameters.audit.records) throw new Error("Pair-date cell count mismatch");

  const comparisons = {};
  for (const comparison of ["core-5", "core-4", "no-dependence-4"]) {
    comparisons[comparison] = {
      full_7_minus_comparison_brier: overallBrier["full-7"] - overallBrier[comparison],
      relative_brier_change_vs_full_7: (overallBrier[comparison] - overallBrier["full-7"]) / overallBrier["full-7"],
      date_block_bootstrap: dateBootstrap(dateAggregates, "full-7", comparison, BOOTSTRAP_REPLICATES, BOOTSTRAP_SEED + comparison.length),
      pair_level_descriptive: pairComparison(pairAggregates, "full-7", comparison),
    };
  }

  const directComparisons = {};
  for (const [baseline, comparison] of [
    ["core-5", "no-dependence-4"],
    ["core-5", "core-4"],
    ["two-model-hedge", "no-dependence-4"],
  ]) {
    const id = `${baseline}_vs_${comparison}`;
    directComparisons[id] = {
      baseline_brier_minus_comparison_brier: overallBrier[baseline] - overallBrier[comparison],
      date_block_bootstrap: dateBootstrap(dateAggregates, baseline, comparison, BOOTSTRAP_REPLICATES, BOOTSTRAP_SEED + id.length),
      pair_level_descriptive: pairComparison(pairAggregates, baseline, comparison),
    };
  }

  const realizedPairRows = [...pairAggregates.entries()].map(([id, aggregate]) => ({
    id,
    quality: Math.min(aggregate.loss["model-a"], aggregate.loss["model-b"]) / aggregate.n,
    referenceLoss: Math.min(aggregate.loss["model-a"], aggregate.loss["model-b"]),
    n: aggregate.n,
    loss: aggregate.loss,
  }));
  const qualityStratification = {
    prior_history_quality: {
      status: "outcome_blind_stratification_feature",
      unit: "pair_date_cell",
      ordering: "Q1 has the lowest strictly-prior best-constituent Raw Brier; Q4 has the highest",
      quartiles: qualityQuartiles(pairDateCells, "minimum cumulative Raw Brier of the two constituents on common targets strictly before the scored forecast date"),
    },
    realized_test_quality: {
      status: "descriptive_ex_post_not_deployable",
      unit: "exact_model_pair",
      ordering: "Q1 has the lowest ex-post better-constituent Raw Brier on the evaluation sample; Q4 has the highest",
      quartiles: qualityQuartiles(realizedPairRows, "minimum realized Raw Brier of the two constituents on the scored evaluation targets"),
    },
  };

  const result = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    status: "post_hoc_expert_set_ablation_not_independent_oos",
    inputs: {
      history: resolve(args.history),
      history_sha256: historySha256,
      parameters: resolve(args.parameters),
      parameter_sha256: createHash("sha256").update(parameterBytes).digest("hex"),
    },
    protocol: {
      outcome_visibility: "strictly_prior_forecast_dates_only",
      evaluation_sample: "only pair-date cells with published prior-history parameters",
      scoring: "target-weighted raw Brier",
      bootstrap: "paired forecast-date block bootstrap; descriptive because dates and pairs share events/models",
      expert_set_selection_warning: "Core variants were proposed after inspecting the existing historical results and therefore require a future or separately frozen holdout before confirmatory claims.",
    },
    audit: {
      models: history.meta.models,
      source_events: history.meta.events,
      source_dates: history.meta.rounds,
      eligible_pairs: parametersByPair.size,
      scored_pair_date_cells: scoredPairDateCells,
      scored_target_evaluations: overall.n,
      scored_dates: dateAggregates.size,
      date_min: [...dateAggregates.keys()].sort()[0],
      date_max: [...dateAggregates.keys()].sort().at(-1),
      all_history_dates_strictly_prior: parameters.audit.all_history_dates_strictly_prior,
      reproduction_rounded_6dp: Object.fromEntries(Object.keys(EXPECTED_REPRODUCTION).map((method) => [method, Number(overallBrier[method].toFixed(6))])),
    },
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([id, definition]) => [id, definition])),
    overall_brier: overallBrier,
    comparisons,
    direct_comparisons: directComparisons,
    temporal_halves: splitSummary(dateAggregates),
    quality_stratification: qualityStratification,
  };

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: resolve(args.output), audit: result.audit, overall_brier: overallBrier, quality_stratification: qualityStratification }, null, 2));
}

await main();
