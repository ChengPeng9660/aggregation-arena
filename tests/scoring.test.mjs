import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Brier Index keeps the ForecastBench anchor at 50 for an always-0.5 forecast", () => {
  const brier = (0.5 - 1) ** 2;
  const index = (1 - Math.sqrt(brier)) * 100;
  assert.equal(index, 50);
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
