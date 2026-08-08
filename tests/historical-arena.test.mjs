import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const datasetPath = new URL("../public/forecastbench/history.json", import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));

test("historical arena publishes a multi-provider resolved binary panel", () => {
  assert.equal(dataset.events.length, dataset.meta.events);
  assert.equal(dataset.models.length, dataset.meta.models);
  assert.ok(dataset.meta.providers >= 8);
  assert.ok(dataset.events.length >= 8_000);
  assert.ok(dataset.models.length >= 50);
  assert.equal(new Set(dataset.events.map((event) => event.id)).size, dataset.events.length);
});

test("historical public track excludes composite and unfinished event text", () => {
  for (const event of dataset.events) {
    const eventIdentity = event.id.split("|", 2)[1] ?? "";
    assert.equal(eventIdentity.trimStart().startsWith("["), false);
    assert.equal(event.question.startsWith("ForecastBench event "), false);
    assert.equal(/[{}]/.test(event.question), false);
    assert.ok(event.outcome === 0 || event.outcome === 1);
  }
});

test("every historical probability is valid and references a published model", () => {
  const modelIds = new Set(dataset.models.map((model) => model.id));
  const observedCoverage = new Map(dataset.models.map((model) => [model.id, 0]));
  for (const event of dataset.events) {
    for (const [modelId, probability] of Object.entries(event.forecasts)) {
      assert.ok(modelIds.has(modelId));
      assert.ok(probability >= 0 && probability <= 1);
      observedCoverage.set(modelId, observedCoverage.get(modelId) + 1);
    }
  }
  for (const model of dataset.models) assert.equal(observedCoverage.get(model.id), model.n);
});

test("default diverse model selection has a usable available-case sample", () => {
  const organizations = new Set();
  const selected = dataset.models.filter((model) => {
    if (organizations.has(model.organization) || organizations.size >= 8) return false;
    organizations.add(model.organization);
    return true;
  });
  assert.equal(selected.length, 8);
  const availableCounts = dataset.events.map((event) => selected.filter((model) => event.forecasts[model.id] !== undefined).length);
  const eligible = availableCounts.filter((count) => count >= 2);
  assert.ok(eligible.length >= 5_000);
  assert.ok(eligible.every((count) => count >= 2 && count <= selected.length));
});
