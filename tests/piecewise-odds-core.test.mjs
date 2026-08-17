import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PIECEWISE_ODDS_THRESHOLD,
  piecewiseOddsProbability,
} from "../lib/piecewise-odds-core.js";

const closeTo = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
};

test("Piecewise Odds Pool reproduces the defining K=5 examples", () => {
  assert.equal(DEFAULT_PIECEWISE_ODDS_THRESHOLD, 5);
  closeTo(piecewiseOddsProbability([0.6, 0.6]), 0.6);
  closeTo(piecewiseOddsProbability([0.8, 0.8]), 16 / (16 + Math.sqrt(5)));
  closeTo(piecewiseOddsProbability([0.8, 0.2]), 0.5);
  closeTo(piecewiseOddsProbability([0.9, 0.6]), (13.5 / Math.sqrt(5)) / (1 + 13.5 / Math.sqrt(5)));
});

test("Piecewise Odds Pool is exchangeable and symmetric around one half", () => {
  const forward = piecewiseOddsProbability([0.73, 0.41]);
  closeTo(forward, piecewiseOddsProbability([0.41, 0.73]));
  closeTo(piecewiseOddsProbability([0.27, 0.59]), 1 - forward);
});

test("Piecewise Odds Pool is continuous at both odds-product boundaries", () => {
  const lowerProbability = (1 / 5) / (1 + 1 / 5);
  const upperProbability = 5 / (1 + 5);
  closeTo(piecewiseOddsProbability([lowerProbability, 0.5]), 1 / (1 + Math.sqrt(5)));
  closeTo(piecewiseOddsProbability([upperProbability, 0.5]), Math.sqrt(5) / (1 + Math.sqrt(5)));
});

test("Piecewise Odds Pool validates its two-model domain and threshold", () => {
  assert.throws(() => piecewiseOddsProbability([0.4]), /exactly two/);
  assert.throws(() => piecewiseOddsProbability([0.4, 0.6], 1), /greater than 1/);
  assert.throws(() => piecewiseOddsProbability([-0.1, 0.6]), /between 0 and 1/);
});
