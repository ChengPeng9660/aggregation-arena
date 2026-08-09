import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const datasetPath = new URL("../public/forecastbench/history.json", import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const historicalSource = await readFile(new URL("../app/historical-arena.tsx", import.meta.url), "utf8");
const publicArenaSource = await readFile(new URL("../app/arena-client.tsx", import.meta.url), "utf8");
const arenaSource = await readFile(new URL("../lib/arena.ts", import.meta.url), "utf8");

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
    const [forecastDueDate, sourceKey, eventIdentity] = event.id.split("|", 3);
    assert.equal(forecastDueDate, event.date);
    assert.equal(sourceKey, event.sourceKey);
    assert.equal(eventIdentity.trimStart().startsWith("["), false);
    assert.equal(event.question.startsWith("ForecastBench event "), false);
    assert.equal(/[{}]/.test(event.question), false);
    assert.ok(event.outcome === 0 || event.outcome === 1);
  }
});

test("historical classifications reproduce ForecastBench question type and official source", () => {
  const datasetSources = new Set(["acled", "dbnomics", "fred", "wikipedia", "yfinance"]);
  const marketSources = new Set(["infer", "manifold", "metaculus", "polymarket"]);
  const observedTypes = { Dataset: 0, Market: 0 };
  const observedSources = new Map();
  for (const event of dataset.events) {
    const expectedType = datasetSources.has(event.sourceKey) ? "Dataset" : marketSources.has(event.sourceKey) ? "Market" : null;
    assert.ok(expectedType, `unknown official source ${event.sourceKey}`);
    assert.equal(event.questionType, expectedType);
    assert.equal(event.category, expectedType);
    observedTypes[expectedType] += 1;
    observedSources.set(event.source, (observedSources.get(event.source) ?? 0) + 1);
  }
  assert.deepEqual(observedTypes, dataset.meta.questionTypes);
  assert.deepEqual(Object.fromEntries([...observedSources].sort()), dataset.meta.sourceCounts);
  assert.equal(dataset.meta.officialQuestionMatches, dataset.events.length);
  assert.equal(dataset.meta.missingOfficialQuestions, 0);
  assert.equal(dataset.meta.joinKey, "forecast_due_date + official source + event_id");
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

test("historical leaderboard keeps 1 minus Brier on its documented zero-to-one scale", () => {
  assert.match(historicalSource, /row\.score\.toFixed\(4\)/);
  assert.doesNotMatch(historicalSource, /row\.score\s*\*\s*100/);
});

test("historical model count is user-adjustable across the published model panel", () => {
  assert.match(historicalSource, /className="k-stepper"/);
  assert.match(historicalSource, /min="2" max=\{data\.models\.length\}/);
  assert.match(historicalSource, /setModelCount/);
});

test("production arena cannot seed or display synthetic demo events", () => {
  assert.doesNotMatch(arenaSource, /seedDemoIfEmpty|Demo Season initialized|Seeded example event/);
  assert.match(arenaSource, /id NOT LIKE 'demo-%'/);
});

test("public leaderboard presents aggregation methods without redundant controls or metadata", () => {
  assert.doesNotMatch(publicArenaSource, /public-hero-signal|LIVE SCORE|Method \/ Forecaster/);
  assert.doesNotMatch(publicArenaSource, /onSeason|Individual models|const \[season, setSeason\] = useState\("all"\)/);
  assert.doesNotMatch(publicArenaSource, /row\.organization|row\.version/);
  assert.match(publicArenaSource, /<th>Method<\/th>/);
  assert.match(publicArenaSource, /track: "aggregators"/);
});
