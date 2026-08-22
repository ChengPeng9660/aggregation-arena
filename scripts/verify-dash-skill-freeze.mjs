#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_MANIFEST = "research/dash-skill-finalists-freeze-2026-08-23.json";

function parseArgs(argv) {
  const args = { manifest: DEFAULT_MANIFEST, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") args.manifest = argv[++index];
    else if (argv[index] === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

function assertClose(actual, expected, label, tolerance = 1e-12) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function findCandidate(output, id) {
  const candidate = output.candidates.find((row) => row.id === id);
  if (!candidate) throw new Error(`Frozen finalist missing from output: ${id}`);
  return candidate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  assertEqual(manifest.status, "frozen_for_future_confirmatory_evaluation", "manifest status");

  const historyBytes = await readFile(manifest.discovery.historyPath);
  const parameterBytes = await readFile(manifest.discovery.dashParameterPath);
  const scriptBytes = await readFile(manifest.discovery.explorationScriptPath);
  assertEqual(sha256(historyBytes), manifest.discovery.historySha256, "history SHA-256");
  assertEqual(sha256(parameterBytes), manifest.discovery.dashParameterSha256, "parameter SHA-256");
  assertEqual(sha256(scriptBytes), manifest.discovery.explorationScriptSha256, "exploration script SHA-256");

  const history = JSON.parse(historyBytes);
  const parameters = JSON.parse(parameterBytes);
  assertEqual(parameters.history_sha256, manifest.discovery.historySha256, "parameter-bound history SHA-256");
  assertEqual(history.meta.lastRound, manifest.discovery.forecastDateCutoffInclusive, "history cutoff");
  assertEqual(Math.max(...history.events.map((event) => Date.parse(event.date))), Date.parse(manifest.discovery.forecastDateCutoffInclusive), "maximum event date");

  const script = scriptBytes.toString("utf8");
  for (const finalist of manifest.finalists) {
    if (!script.includes(finalist.id)) throw new Error(`Frozen finalist ID absent from exploration script: ${finalist.id}`);
  }

  if (args.output) {
    const output = JSON.parse(await readFile(args.output, "utf8"));
    assertEqual(output.schemaVersion, manifest.discovery.outputSchemaVersion, "output schema version");
    assertEqual(output.audit.allHistoryDatesStrictlyPrior, true, "pair-history leakage audit");
    assertEqual(output.audit.allCrossPairSnapshotsStrictlyPrior, true, "cross-pair leakage audit");
    assertEqual(output.audit.scoredDates, manifest.discovery.scoredDates, "scored dates");
    assertEqual(output.audit.eligiblePairs, manifest.discovery.eligiblePairs, "eligible pairs");
    assertEqual(output.audit.scoredTargetEvaluations, manifest.discovery.scoredTargetEvaluations, "target evaluations");
    for (const finalist of manifest.finalists) {
      const candidate = findCandidate(output, finalist.id);
      assertClose(candidate.overallBrier, finalist.overallRawBrier, `${finalist.id} overall Raw Brier`);
      assertClose(candidate.q1Brier, finalist.strongestQ1RawBrier, `${finalist.id} strongest-Q1 Raw Brier`);
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
