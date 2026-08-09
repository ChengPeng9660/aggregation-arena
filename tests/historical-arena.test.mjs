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

test("historical leaderboard uses the strict selected-model intersection", () => {
  assert.match(historicalSource, /available\.length !== selected\.length/);
  assert.match(historicalSource, /ids\.every\(\(id\) => event\.forecasts\[id\] !== undefined\)/);
  assert.doesNotMatch(historicalSource, /completeCases|setCompleteCases|byK|Performance vs model count/);
  assert.doesNotMatch(historicalSource, /row\.coverage|row\.avgK|<th>Coverage<\/th>|<th>Avg K<\/th>/);
});

test("historical leaderboard can rank methods alone or with selected individual models", () => {
  assert.match(historicalSource, /leaderboardView/);
  assert.match(historicalSource, />Aggregation methods<\/button>/);
  assert.match(historicalSource, />Methods \+ individual models<\/button>/);
  assert.match(historicalSource, /makeIndividualRanking\(scored, selected, models\)/);
  assert.match(historicalSource, /row\.event\.forecasts\[modelId\]/);
  assert.match(historicalSource, /combinedRanking = \[\.\.\.ranking, \.\.\.individualRanking\]\.sort\(compareRankingRows\)/);
  assert.doesNotMatch(historicalSource, /history-provenance|<b>Evaluation rule<\/b>|<b>Data provenance<\/b>/);
});

test("historical diagnostics use one large Prophet-style performance history", () => {
  const performancePanelSource = historicalSource.slice(historicalSource.indexOf("function PerformanceHistory("), historicalSource.indexOf("function PerformanceHistoryChart("));
  assert.match(historicalSource, /OUTPUT 02/);
  assert.match(historicalSource, /Performance History/);
  assert.match(historicalSource, />Rank<\/button>/);
  assert.match(historicalSource, />Values<\/button>/);
  assert.match(historicalSource, /Rank by/);
  assert.match(performancePanelSource, /<b>1 − Brier<\/b>/);
  assert.match(historicalSource, /Last 12 runs/);
  assert.match(historicalSource, /const width = 1000, height = 460/);
  assert.doesNotMatch(historicalSource, /OUTPUT 03|OUTPUT 04|Cumulative performance|Rank history|title="Calibration"/);
  assert.doesNotMatch(performancePanelSource, /Edge over market|Avg return|ECE/);
  assert.doesNotMatch(historicalSource, /EVENT AUDIT|What entered the score|representativeAudit|history-audit|history-event-list/);
});

test("historical leaderboard keeps 1 minus Brier on its documented zero-to-one scale", () => {
  assert.match(historicalSource, /row\.score\.toFixed\(4\)/);
  assert.doesNotMatch(historicalSource, /row\.score\s*\*\s*100/);
});

test("historical model count is user-adjustable across the published model panel", () => {
  assert.match(historicalSource, /className="k-stepper"/);
  assert.match(historicalSource, /min="2" max=\{data\.models\.length\}/);
  assert.match(historicalSource, /setModelCount/);
  assert.match(historicalSource, /className="picker-count-control"/);
  assert.match(historicalSource, /className="model-preset-block"/);
  assert.match(historicalSource, />Quick select<\/span>/);
  assert.doesNotMatch(historicalSource, /className="k-control"/);
});

test("production arena cannot seed or display synthetic demo events", () => {
  assert.doesNotMatch(arenaSource, /seedDemoIfEmpty|Demo Season initialized|Seeded example event/);
  assert.match(arenaSource, /id NOT LIKE 'demo-%'/);
});

test("public leaderboard keeps compact method and individual model standings", () => {
  assert.doesNotMatch(publicArenaSource, /public-hero-signal|LIVE SCORE|Method \/ Forecaster/);
  assert.doesNotMatch(publicArenaSource, /onSeason|const \[season, setSeason\] = useState\("all"\)|View a live event/);
  assert.doesNotMatch(publicArenaSource, /row\.organization|row\.version/);
  assert.match(publicArenaSource, /<h1 className="public-hero-title">Forecast Aggregation Leaderboard<\/h1>/);
  assert.match(publicArenaSource, /Submit your aggregation method/);
  assert.match(publicArenaSource, /Aggregation Methods/);
  assert.match(publicArenaSource, /Individual Models/);
  assert.match(publicArenaSource, /track: leaderboardTrack/);
  assert.match(publicArenaSource, /onTrack\("forecasters"\)/);
});

test("historical arena uses the compact benchmark information hierarchy", () => {
  assert.match(historicalSource, /Historical Aggregation Leaderboard/);
  assert.match(historicalSource, /className="history-stat-line"/);
  assert.doesNotMatch(historicalSource, /Aggregation<br \/>Leaderboard/);
});
