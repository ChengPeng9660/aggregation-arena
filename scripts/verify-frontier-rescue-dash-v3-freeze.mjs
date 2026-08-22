#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_MANIFEST = "research/frontier-rescue-dash-v3-freeze-2026-08-23.json";

function parseArgs(argv) {
  const args = { manifest: DEFAULT_MANIFEST, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") args.manifest = argv[++index];
    else if (argv[index] === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

function assertClose(actual, expected, label, tolerance = 1e-12) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  assertEqual(
    manifest.status,
    "frozen_secondary_challengers_for_future_confirmatory_evaluation",
    "manifest status",
  );

  const historyBytes = await readFile(manifest.discovery.historyPath);
  const parameterBytes = await readFile(manifest.discovery.dashParameterPath);
  const scriptBytes = await readFile(manifest.discovery.scriptPath);
  assertEqual(sha256(historyBytes), manifest.discovery.historySha256, "history SHA-256");
  assertEqual(sha256(parameterBytes), manifest.discovery.dashParameterSha256, "parameter SHA-256");
  assertEqual(sha256(scriptBytes), manifest.discovery.scriptSha256, "script SHA-256");

  const history = JSON.parse(historyBytes);
  const parameters = JSON.parse(parameterBytes);
  assertEqual(parameters.history_sha256, manifest.discovery.historySha256, "parameter-bound history SHA-256");
  assertEqual(history.meta.lastRound, manifest.discovery.forecastDateCutoffInclusive, "history cutoff");
  assertEqual(
    Math.max(...history.events.map((event) => Date.parse(event.date))),
    Date.parse(manifest.discovery.forecastDateCutoffInclusive),
    "maximum event date",
  );

  const script = scriptBytes.toString("utf8");
  for (const finalist of manifest.finalists) {
    if (!script.includes(finalist.id)) throw new Error(`Frozen finalist ID absent from script: ${finalist.id}`);
  }

  if (args.output) {
    const output = JSON.parse(await readFile(args.output, "utf8"));
    assertEqual(output.schemaVersion, manifest.discovery.outputSchemaVersion, "output schema version");
    assertEqual(output.audit.allHistoryDatesStrictlyPrior, true, "pair-history leakage audit");
    assertEqual(output.audit.allCrossPairSnapshotsStrictlyPrior, true, "cross-pair leakage audit");
    assertEqual(output.audit.allKnnExamplesStrictlyPrior, true, "KNN-history leakage audit");
    assertEqual(output.audit.scoredDates, manifest.discovery.scoredDates, "scored dates");
    assertEqual(output.audit.eligiblePairs, manifest.discovery.eligiblePairs, "eligible pairs");
    assertEqual(output.audit.scoredPairDateCells, manifest.discovery.scoredPairDateCells, "pair-date cells");
    assertEqual(output.audit.scoredTargetEvaluations, manifest.discovery.scoredTargetEvaluations, "target evaluations");
    delete output.generatedAt;
    assertEqual(
      sha256(stableStringify(output)),
      manifest.discovery.canonicalOutputSha256ExcludingGeneratedAt,
      "canonical output SHA-256",
    );
    for (const finalist of manifest.finalists) {
      const candidate = output.candidates.find((row) => row.id === finalist.id);
      if (!candidate) throw new Error(`Frozen finalist missing from output: ${finalist.id}`);
      assertClose(candidate.overallBrier, finalist.overallRawBrier, `${finalist.id} overall Raw Brier`);
      assertClose(candidate.q1Brier, finalist.strongestQ1RawBrier, `${finalist.id} strongest-Q1 Raw Brier`);
      assertClose(candidate.lateBrier, finalist.lateRawBrier, `${finalist.id} late Raw Brier`);
      assertEqual(`${candidate.dateSota.strictCount}/${candidate.dateSota.units}`, finalist.dateSota, `${finalist.id} date SOTA`);
      assertEqual(`${candidate.pairSota.strictCount}/${candidate.pairSota.units}`, finalist.pairSota, `${finalist.id} pair SOTA`);
      assertEqual(`${candidate.q1PairSota.strictCount}/${candidate.q1PairSota.units}`, finalist.strongestQ1PairSota, `${finalist.id} strongest-Q1 pair SOTA`);
    }
  }

  console.log(JSON.stringify({
    manifest: args.manifest,
    cutoff: manifest.discovery.forecastDateCutoffInclusive,
    finalists: manifest.finalists.length,
    sourceHashesVerified: true,
    outputVerified: Boolean(args.output),
  }, null, 2));
}

await main();
