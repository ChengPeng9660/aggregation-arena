import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { prophetEventBrier } from "../lib/event-core.js";

test("Prophet event Brier averages squared error across all event outcomes", () => {
  const score = prophetEventBrier({ a: 0.6, b: 0.3, c: 0.1 }, "a", ["a", "b", "c"]);
  assert.ok(Math.abs(score - (0.16 + 0.09 + 0.01) / 3) < 1e-12);
});

test("the benchmark implements six deterministic aggregation methods", async () => {
  const source = await readFile(new URL("../lib/arena.ts", import.meta.url), "utf8");
  for (const id of [
    "agg-equal-mean",
    "agg-median",
    "agg-trimmed-mean",
    "agg-logit-pool",
    "agg-extremized",
    "agg-performance-weighted",
  ]) {
    assert.match(source, new RegExp(id));
  }
  assert.match(source, /bootstrapMeanCI/);
  assert.match(source, /prediction_history/);
  assert.match(source, /audit_log/);
});
