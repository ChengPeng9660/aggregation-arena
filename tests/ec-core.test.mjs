import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EC_WEIGHT, evidenceCombinationProbability } from "../lib/ec-core.js";

test("EC reproduces the research w=0.56 evidence-combination rule", () => {
  assert.equal(DEFAULT_EC_WEIGHT, 0.56);
  const first = 0.8;
  const second = 0.3;
  const expected = 1 / (1 + Math.exp(-0.56 * (
    Math.log(first / (1 - first)) + Math.log(second / (1 - second))
  )));
  assert.ok(Math.abs(evidenceCombinationProbability([first, second]) - expected) < 1e-12);
});

test("EC is exchangeable and symmetric around one half", () => {
  const forward = evidenceCombinationProbability([0.73, 0.41]);
  assert.ok(Math.abs(forward - evidenceCombinationProbability([0.41, 0.73])) < 1e-12);
  assert.ok(Math.abs(evidenceCombinationProbability([0.27, 0.59]) - (1 - forward)) < 1e-12);
});

test("EC validates its two-model domain and weight", () => {
  assert.throws(() => evidenceCombinationProbability([0.4]), /exactly two/);
  assert.throws(() => evidenceCombinationProbability([0.4, 0.6], 0), /positive/);
  assert.throws(() => evidenceCombinationProbability([-0.1, 0.6]), /between 0 and 1/);
});
