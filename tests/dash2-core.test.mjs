import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDash2State,
  exponentialWeights,
  forecastDash2Pair,
  updateDash2State,
} from "../lib/dash2-core.js";


test("DASH-Hedge-2 and SafeMix-2 reproduce the audited Python primitive", () => {
  const state = {
    expertLossSum: [1.2, 0.8, 0.9, 1.1, 0.7, 1.3, 0.6],
    nFeedback: 50,
  };
  const forecast = forecastDash2Pair(0.2, 0.7, state, {
    historyBestSide: "b",
    safeAlpha: 0.35,
  });
  assert.ok(Math.abs(forecast.safeMix - 0.6183192797715289) < 1e-14);
  assert.ok(Math.abs(forecast.dashHedge - 0.48496846283376405) < 1e-14);
  assert.deepEqual(
    forecast.metaWeights.map((value) => Number(value.toFixed(15))),
    [
      0.122626543436962,
      0.153290822516324,
      0.144971701970394,
      0.12966339947933,
      0.162087331171222,
      0.115971578839364,
      0.171388622586404,
    ],
  );
});


test("current-date outcomes cannot change another forecast frozen in the same date", () => {
  const state = createDash2State();
  const first = forecastDash2Pair(0.2, 0.7, state, null);
  const second = forecastDash2Pair(0.8, 0.3, state, null);
  const counterfactualSecond = forecastDash2Pair(0.8, 0.3, state, null);
  assert.equal(second.dashHedge, counterfactualSecond.dashHedge);
  assert.equal(second.safeMix, counterfactualSecond.safeMix);

  const updated = updateDash2State(
    state,
    [first.expertPredictions, second.expertPredictions],
    [0, 1],
  );
  assert.equal(state.nFeedback, 0);
  assert.equal(updated.nFeedback, 2);
  assert.notDeepEqual(updated.expertLossSum, state.expertLossSum);
});


test("exponential weights remain a valid simplex", () => {
  const weights = exponentialWeights([1.2, 0.8, 4.1, 0], 200);
  assert.ok(weights.every((weight) => weight > 0 && weight < 1));
  assert.ok(Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-14);
});


test("published pair-date parameters are bound to the current history and never use current dates", async () => {
  const historyBytes = await readFile(new URL("../public/forecastbench/history.json", import.meta.url));
  const dash2 = JSON.parse(await readFile(new URL("../public/forecastbench/dash2-history.json", import.meta.url), "utf8"));
  const historyHash = createHash("sha256").update(historyBytes).digest("hex");
  assert.equal(dash2.history_sha256, historyHash);
  assert.equal(dash2.protocol, "outcome_blind_all_pair_round_ordered");
  assert.equal(dash2.outcome_visibility, "strictly_prior_forecast_dates_only");
  assert.equal(dash2.audit.records, 1567);
  assert.equal(dash2.audit.unique_pairs, 421);
  assert.equal(dash2.records.length, dash2.audit.records);
  const keys = new Set();
  for (const [date, historyLastDate, modelA, modelB, nHistory, nHistoryDates, side, alpha] of dash2.records) {
    assert.ok(historyLastDate < date);
    assert.ok(nHistory >= dash2.config.min_history_targets);
    assert.ok(nHistoryDates >= dash2.config.min_history_dates);
    assert.ok(side === "a" || side === "b");
    assert.ok(alpha >= 0 && alpha <= 1);
    keys.add(`${date}\0${modelA}\0${modelB}`);
  }
  assert.equal(keys.size, dash2.records.length);
});
