import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateDistribution,
  normalizeDistribution,
  parseEventPredictionResponse,
  prophetEventBrier,
} from "../lib/event-core.js";

const outcomes = [
  { key: "market-a", label: "Candidate A" },
  { key: "market-b", label: "Candidate B" },
  { key: "other", label: "Other" },
];

test("normalizes a complete categorical probability distribution", () => {
  assert.deepEqual(normalizeDistribution({ a: 2, b: 1 }, ["a", "b"]), {
    a: 2 / 3,
    b: 1 / 3,
  });
});

test("parses Prophet-style outcome arrays by stable key or label", () => {
  const parsed = parseEventPredictionResponse({
    response: JSON.stringify({
      rationale: "Candidate A has the strongest evidence.",
      probabilities: [
        { market: "Candidate A", probability: 55 },
        { market: "market-b", probability: 30 },
        { market: "other", probability: 15 },
      ],
      citedSourceRanks: [1, 3],
    }),
  }, outcomes);
  assert.deepEqual(parsed.probabilities, {
    "market-a": 0.55,
    "market-b": 0.3,
    other: 0.15,
  });
});

test("categorical aggregation preserves the simplex", () => {
  const aggregate = aggregateDistribution([
    { a: 0.7, b: 0.2, c: 0.1 },
    { a: 0.4, b: 0.4, c: 0.2 },
  ], ["a", "b", "c"], "mean");
  assert.ok(Math.abs(Object.values(aggregate).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.equal(prophetEventBrier(aggregate, "a", ["a", "b", "c"]), (0.45 ** 2 + 0.3 ** 2 + 0.15 ** 2) / 3);
});
