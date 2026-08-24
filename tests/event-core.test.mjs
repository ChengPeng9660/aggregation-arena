import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateDistribution,
  normalizeDistribution,
  parseEventPredictionResponse,
  prophetEventBrier,
} from "../lib/event-core.js";

const outcomes = [
  { key: "market-a", label: "Candidate A" },
  { key: "market-b", label: "Candidate B" },
  { key: "other", label: "Other" },
];
const binaryOutcomes = [
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
];

test("normalizes a complete categorical probability distribution", () => {
  assert.deepEqual(normalizeDistribution({ a: 2, b: 1 }, ["a", "b"]), {
    a: 2 / 3,
    b: 1 / 3,
  });
});

test("parses Prophet-style outcome arrays by stable key or label", () => {
  const parsed = parseEventPredictionResponse({
    response: JSON.stringify({
      rationale: "Candidate A has the strongest evidence.",
      probabilities: [
        { market: "Candidate A", probability: 55 },
        { market: "market-b", probability: 30 },
        { market: "other", probability: 15 },
      ],
      citedSourceRanks: [1, 3],
    }),
  }, outcomes);
  assert.deepEqual(parsed.probabilities, {
    "market-a": 0.55,
    "market-b": 0.3,
    other: 0.15,
  });
});

test("recovers a complete probability array when Poe truncates only trailing metadata", () => {
  const parsed = parseEventPredictionResponse({ choices: [{ message: { content:
    '{"rationale":"Short view.","probabilities":[{"market":"yes","probability":0.53},{"market":"no","probability":0.47}],"cited'
  } }] }, [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ]);
  assert.deepEqual(parsed.probabilities, { yes: 0.53, no: 0.47 });
  assert.equal(parsed.rationale, "Short view.");
});

test("selects prediction JSON embedded after provider thinking text", () => {
  const parsed = parseEventPredictionResponse({ choices: [{ message: { content:
    'Thinking... example {not json}. Final: {"rationale":"Calibrated.","probabilities":[{"market":"yes","probability":0.54},{"market":"no","probability":0.46}],"citedSourceRanks":[1]}'
  } }] }, [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ]);
  assert.deepEqual(parsed.probabilities, { yes: 0.54, no: 0.46 });
});

test("prefers the final prediction over a zero-value schema example in provider thinking", () => {
  const parsed = parseEventPredictionResponse({ choices: [{ message: { content:
    'Schema example: {"rationale":"...","probabilities":[{"market":"yes","probability":0.0},{"market":"no","probability":0.0}]}. Final: {"rationale":"Calibrated.","probabilities":[{"market":"yes","probability":0.52},{"market":"no","probability":0.48}],"citedSourceRanks":[2]}'
  } }] }, [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ]);
  assert.deepEqual(parsed.probabilities, { yes: 0.52, no: 0.48 });
  assert.equal(parsed.rationale, "Calibrated.");
});

test("parses JSON returned in an OpenAI-compatible reasoning_content field", () => {
  const parsed = parseEventPredictionResponse({
    choices: [{
      message: {
        content: null,
        reasoning_content: JSON.stringify({
          rationale: "The distribution is calibrated to the frozen context.",
          probabilities: { "market-a": 0.5, "market-b": 0.35, other: 0.15 },
          citedSourceRanks: [2],
        }),
      },
    }],
  }, outcomes);
  assert.deepEqual(parsed.probabilities, {
    "market-a": 0.5,
    "market-b": 0.35,
    other: 0.15,
  });
});

test("parses JSON returned by Anthropic Messages", () => {
  const parsed = parseEventPredictionResponse({
    content: [{
      type: "text",
      text: JSON.stringify({
        rationale: "Anthropic response.",
        probabilities: [{ market: "yes", probability: 0.64 }, { market: "no", probability: 0.36 }],
        citedSourceRanks: [1],
      }),
    }],
  }, binaryOutcomes);
  assert.equal(parsed.probabilities.yes, 0.64);
});

test("parses JSON returned by the OpenAI Responses API", () => {
  const parsed = parseEventPredictionResponse({
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          rationale: "Responses output.",
          probabilities: [{ market: "yes", probability: 0.58 }, { market: "no", probability: 0.42 }],
          citedSourceRanks: [2],
        }),
      }],
    }],
  }, binaryOutcomes);
  assert.equal(parsed.probabilities.yes, 0.58);
});

test("categorical aggregation preserves the simplex", () => {
  const aggregate = aggregateDistribution([
    { a: 0.7, b: 0.2, c: 0.1 },
    { a: 0.4, b: 0.4, c: 0.2 },
  ], ["a", "b", "c"], "mean");
  assert.ok(Math.abs(Object.values(aggregate).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.equal(prophetEventBrier(aggregate, "a", ["a", "b", "c"]), (0.45 ** 2 + 0.3 ** 2 + 0.15 ** 2) / 3);
});
