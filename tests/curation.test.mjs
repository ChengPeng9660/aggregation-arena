import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_CATEGORIES,
  CURATION_CONFIG,
  classifyMarket,
  evaluateHardEligibility,
  rankCandidates,
  selectBalancedCandidates,
} from "../lib/curation-core.js";

const now = new Date("2026-07-29T00:00:00.000Z");

test("uses Prophet Arena's five public forecasting domains", () => {
  assert.deepEqual(CANONICAL_CATEGORIES, ["Politics", "Economics", "Science", "Sports", "Entertainment"]);
  const examples = [
    ["Will the candidate win the presidential election?", "Politics"],
    ["Will Bitcoin finish above $100,000?", "Economics"],
    ["Will an AI model pass the scientific benchmark?", "Science"],
    ["Will the home team win the football match?", "Sports"],
    ["Will the film win an Oscar?", "Entertainment"],
  ];
  for (const [title, expected] of examples) {
    assert.equal(classifyMarket({ title }, {}).category, expected);
  }
});

test("uses the relaxed market activity thresholds", () => {
  assert.equal(CURATION_CONFIG.minimumVolume24h, 7_500);
  assert.equal(CURATION_CONFIG.minimumTotalVolume, 35_000);
  assert.equal(CURATION_CONFIG.minimumLiquidity, 7_500);
});

function candidate(overrides = {}) {
  return {
    marketId: crypto.randomUUID(),
    sourceEventId: crypto.randomUUID(),
    title: "Will a well specified event happen before October 2026?",
    description: "This resolves Yes according to the official source by the stated deadline.",
    rules: "Official source is authoritative.",
    category: "Politics",
    outcomes: ["Yes", "No"],
    closeTime: "2026-09-01T00:00:00.000Z",
    startTime: "2026-07-01T00:00:00.000Z",
    yesPrice: 0.5,
    volume24h: 20_000,
    totalVolume: 100_000,
    liquidity: 30_000,
    active: true,
    closed: false,
    acceptingOrders: true,
    eligible: true,
    alreadySelected: false,
    selectionScore: 0.9,
    ...overrides,
  };
}

test("hard filters reject low-volume and non-binary markets", () => {
  const lowVolume = evaluateHardEligibility(candidate({ volume24h: 500 }), now);
  assert.equal(lowVolume.eligible, false);
  assert.ok(lowVolume.reasons.includes("low_24h_volume"));

  const multiOutcome = evaluateHardEligibility(candidate({ outcomes: ["A", "B", "C"] }), now);
  assert.equal(multiOutcome.eligible, false);
  assert.ok(multiOutcome.reasons.includes("not_binary_yes_no"));
});

test("category percentile ranks candidates but is not an eligibility gate", () => {
  const ranked = rankCandidates([
    candidate({ marketId: "lower-volume", volume24h: 20_000 }),
    candidate({ marketId: "higher-volume", volume24h: 100_000 }),
  ], now);
  const lowerVolume = ranked.find((item) => item.marketId === "lower-volume");
  assert.equal(lowerVolume.volume24Percentile, 0);
  assert.equal(lowerVolume.eligible, true);
  assert.ok(!lowerVolume.reasons.includes("below_category_volume_percentile"));
});

test("balanced selector caps every category at the target", () => {
  const candidates = CANONICAL_CATEGORIES.flatMap((category) =>
    Array.from({ length: category === "Sports" ? 20 : 4 }, (_, index) =>
      candidate({
        marketId: `${category}-${index}`,
        sourceEventId: `${category}-event-${index}`,
        title: [
          `${category} alpha horizon`,
          `${category} beta milestone`,
          `${category} gamma threshold`,
          `${category} delta outcome`,
          `${category} epsilon contest`,
        ][index % 5],
        category,
        selectionScore: 1 - index / 100,
      }),
    ),
  );
  const selected = selectBalancedCandidates(candidates, { targetPerCategory: 3 });
  for (const category of CANONICAL_CATEGORIES) {
    assert.equal(selected.filter((item) => item.category === category).length, 3);
  }
  assert.equal(selected.length, 15);
});

test("selector deduplicates source events and never fills weak empty slots", () => {
  const candidates = [
    candidate({ marketId: "one", sourceEventId: "shared", title: "First independent politics question", selectionScore: 1 }),
    candidate({ marketId: "two", sourceEventId: "shared", title: "Second independent politics question", selectionScore: 0.9 }),
    candidate({ marketId: "three", sourceEventId: "unique", title: "Third separate politics question", selectionScore: 0.8 }),
    candidate({ marketId: "old", sourceEventId: "old", title: "Already selected politics question", alreadySelected: true }),
  ];
  const selected = selectBalancedCandidates(candidates, { targetPerCategory: 3 });
  assert.deepEqual(selected.map((item) => item.marketId), ["one", "three"]);
});
