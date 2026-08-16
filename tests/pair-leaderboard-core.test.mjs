import assert from "node:assert/strict";
import test from "node:test";
import { buildBestPairStandings } from "../lib/pair-leaderboard-core.js";

const methods = [
  { id: "mean", aggregateMethod: "mean" },
  { id: "weighted", aggregateMethod: "weighted" },
];

test("pair standings name both models and select the best pair per method", () => {
  const standings = buildBestPairStandings({
    methods,
    participants: [
      { id: "a", name: "Model A" },
      { id: "b", name: "Model B" },
      { id: "new", name: "New Model" },
    ],
    events: [
      event("one", "2026-08-01", 1, { a: 0.6, b: 0.7, new: 0.99 }),
      event("two", "2026-08-02", 0, { a: 0.4, b: 0.3, new: 0.01 }),
    ],
  });

  assert.equal(standings.length, 2);
  assert.deepEqual(standings[0].modelPair.map((model) => model.name), ["Model B", "New Model"]);
  assert.equal(standings[0].pairCount, 3);
  assert.equal(standings[0].modelCount, 3);
  assert.equal(standings[0].losses.length, 2);
});

test("pair standings require a shared eligible resolution and support categorical events", () => {
  const standings = buildBestPairStandings({
    methods: [{ id: "logit", aggregateMethod: "logit" }],
    participants: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "queued", name: "Queued" }],
    events: [{
      id: "categorical",
      resolvedAt: "2026-08-03",
      resolvedOutcome: "red",
      outcomeKeys: ["red", "blue", "green"],
      eligible: true,
      forecasts: {
        a: { red: 0.7, blue: 0.2, green: 0.1 },
        b: { red: 0.6, blue: 0.3, green: 0.1 },
      },
    }],
  });

  assert.equal(standings[0].pairCount, 1);
  assert.equal(standings[0].modelCount, 2);
  assert.deepEqual(standings[0].modelPair.map((model) => model.id), ["a", "b"]);
  assert.ok(Number.isFinite(standings[0].brier));
});

function event(id, resolvedAt, resolution, forecasts) {
  return {
    id,
    resolvedAt,
    resolvedOutcome: resolution ? "yes" : "no",
    outcomeKeys: ["yes", "no"],
    eligible: true,
    forecasts: Object.fromEntries(Object.entries(forecasts).map(([modelId, probability]) => [
      modelId,
      { yes: probability, no: 1 - probability },
    ])),
  };
}
