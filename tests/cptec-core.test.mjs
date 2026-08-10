import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CPTEC_WEIGHT, cptecProbability } from "../lib/cptec-core.js";

test("CPTEC defaults to a 0.56 log-odds weight on the first selected model", () => {
  assert.equal(DEFAULT_CPTEC_WEIGHT, 0.56);
  const first = 0.8;
  const second = 0.3;
  const expected = 1 / (1 + Math.exp(-(
    0.56 * Math.log(first / (1 - first))
    + 0.44 * Math.log(second / (1 - second))
  )));
  assert.ok(Math.abs(cptecProbability([first, second]) - expected) < 1e-12);
});

test("CPTEC at w=0.5 equals the equal log-odds pool", () => {
  const probabilities = [0.72, 0.41];
  const equalLogOdds = 1 / (1 + Math.exp(-probabilities
    .map((probability) => Math.log(probability / (1 - probability)))
    .reduce((sum, value) => sum + value, 0) / 2));
  assert.ok(Math.abs(cptecProbability(probabilities, 0.5) - equalLogOdds) < 1e-12);
});

test("CPTEC validates its two-model domain and weight", () => {
  assert.throws(() => cptecProbability([0.4]), /exactly two/);
  assert.throws(() => cptecProbability([0.4, 0.6], 1.01), /between 0 and 1/);
  assert.throws(() => cptecProbability([-0.1, 0.6], 0.56), /between 0 and 1/);
});
