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

test("the leaderboard registers blind and evidence-aware agent harness methods separately", async () => {
  const source = await readFile(new URL("../lib/arena.ts", import.meta.url), "utf8");
  const harnessSource = await readFile(new URL("../lib/agent-aggregation.ts", import.meta.url), "utf8");
  assert.match(source, /agg-agent-harness-blind-v1/);
  assert.match(source, /agg-agent-harness-evidence-v1/);
  assert.match(source, /informationSet: "blind"/);
  assert.match(source, /informationSet: "evidence-aware"/);
  assert.match(harnessSource, /AGENT_HARNESS_MODEL = "qwen-3\.7-plus"/);
  assert.match(harnessSource, /modelGatewayModelProblem\(env, AGENT_HARNESS_MODEL\)/);
  assert.doesNotMatch(harnessSource, /activeModels\.some\(\(model\) => model\.modelId === AGENT_HARNESS_MODEL\)/);
  assert.match(harnessSource, /runModelGateway\(env/);
  assert.match(harnessSource, /requiredForecasts = options\.resolvedOnly \? 2 : activeModels\.length/);
  assert.match(harnessSource, /getActiveForecastModels\(env\.PROPHET_DISABLED_MODEL_IDS\)/);
  assert.match(harnessSource, /status: "failed" as const/);
  assert.doesNotMatch(harnessSource, /env\.AI|Workers AI binding/);
});
