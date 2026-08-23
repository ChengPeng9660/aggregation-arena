import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const historyBytes = await readFile(new URL("../public/forecastbench/history.json", import.meta.url));
const history = JSON.parse(historyBytes);
const index = JSON.parse(await readFile(new URL("../public/forecastbench/hsqaa-history.json", import.meta.url), "utf8"));
const historyHash = createHash("sha256").update(historyBytes).digest("hex");

test("HSQAA index is bound to current public history and strict resolution visibility", () => {
  assert.equal(index.schema_version, "1.0.0");
  assert.equal(index.method_id, "hier-aa-source-q2-5-e2p0-p50p0-s1p0");
  assert.equal(index.method_name, "HSQAA-5 Balanced");
  assert.equal(index.history_sha256, historyHash);
  assert.equal(index.outcome_visibility, "resolution_date_strictly_before_forecast_date");
  assert.equal(index.fallback, "equal-mean");
  assert.equal(index.audit.historyEvents, history.events.length);
  assert.equal(index.audit.historyEventsWithResolutionDates, 8608);
  assert.equal(index.audit.missingResolutionDates, 7);
  assert.equal(index.audit.outcomeMismatches, 5);
  assert.equal(index.audit.missingResolutionDates + index.audit.outcomeMismatches, 12);
  assert.equal(index.audit.fixedPairs, 421);
  assert.equal(index.audit.supportedPairs, 260);
  assert.equal(index.audit.supportedPredictions, 253066);
  assert.equal(index.audit.allFeedbackStrictlyPreResolution, true);
  assert.match(index.content_sha256, /^[0-9a-f]{64}$/);
});

test("every HSQAA pair shard is immutable, valid, and references its selected pair", async () => {
  const expectedFiles = new Set(index.pairs.map((row) => row[2]));
  const observedFiles = new Set(await readdir(new URL("../public/forecastbench/hsqaa/", import.meta.url)));
  assert.deepEqual(observedFiles, expectedFiles);
  let totalRecords = 0;
  let totalBytes = 0;
  for (const [modelA, modelB, filename, count, dateMin, dateMax, expectedHash] of index.pairs) {
    assert.ok(dateMin <= dateMax);
    const bytes = await readFile(new URL(`../public/forecastbench/hsqaa/${filename}`, import.meta.url));
    totalBytes += bytes.length;
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
    const shard = JSON.parse(bytes);
    assert.equal(shard.schema_version, "1.0.0");
    assert.equal(shard.method_id, index.method_id);
    assert.equal(shard.history_sha256, historyHash);
    assert.equal(shard.model_a, modelA);
    assert.equal(shard.model_b, modelB);
    assert.equal(shard.fallback, "equal-mean");
    assert.equal(shard.records.length, count);
    const seen = new Set();
    for (const [eventIndex, probability] of shard.records) {
      assert.ok(Number.isInteger(eventIndex) && eventIndex >= 0 && eventIndex < history.events.length);
      assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1);
      assert.equal(seen.has(eventIndex), false);
      seen.add(eventIndex);
      const event = history.events[eventIndex];
      assert.ok(event.forecasts[modelA] !== undefined);
      assert.ok(event.forecasts[modelB] !== undefined);
    }
    totalRecords += shard.records.length;
  }
  assert.equal(totalRecords, index.audit.supportedPredictions);
  assert.equal(totalBytes, index.audit.pairShardBytes);
});
