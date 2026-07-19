import test from "node:test";
import assert from "node:assert/strict";
import { brier, buildAggregates, logitPool, median, trimmedMean } from "../src/scoring.js";

test("binary Brier score is squared probability error", () => {
  assert.ok(Math.abs(brier(0.8, 1) - 0.04) < 1e-12);
  assert.ok(Math.abs(brier(0.2, 0) - 0.04) < 1e-12);
});

test("median and trimmed mean are deterministic", () => {
  assert.equal(median([0.1, 0.8, 0.4]), 0.4);
  assert.ok(Math.abs(trimmedMean([0, 0.2, 0.4, 0.6, 1]) - 0.4) < 1e-12);
});

test("logit pool stays inside probability bounds", () => {
  const value = logitPool([0, 1, 0.7]);
  assert.ok(value > 0 && value < 1);
});

test("aggregate panel includes five model-only methods and one market-aware method", () => {
  const forecasts = [
    { participant_id: "a", probability_yes: 0.6 },
    { participant_id: "b", probability_yes: 0.7 },
    { participant_id: "c", probability_yes: 0.8 }
  ];
  const rows = buildAggregates(forecasts, 0.55, { a: 2, b: 1, c: 1 });
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(row => row.track === "market").length, 1);
  assert.ok(rows.every(row => row.probability_yes > 0 && row.probability_yes < 1));
});
