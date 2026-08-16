import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_CATEGORIES,
  CURATION_CONFIG,
  classifyMarket,
  diversityAnchors,
  evaluateHardEligibility,
  normalizeKalshiMarket,
  rankCandidates,
  selectPersistenceCandidates,
  selectRapidResolutionCandidates,
  selectBalancedCandidates,
  selectDiverseSourceBalancedCandidates,
  titleSimilarity,
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
  assert.deepEqual(CURATION_CONFIG.sourceQuotas, { polymarket: 10, kalshi: 10 });
  assert.equal(CURATION_CONFIG.dailyTotal, 20);
  assert.equal(CURATION_CONFIG.kalshiMinimumVolume24h, 25);
  assert.equal(CURATION_CONFIG.kalshiMinimumTotalVolume, 250);
});

function candidate(overrides = {}) {
  return {
    sourcePlatform: "polymarket",
    marketId: crypto.randomUUID(),
    sourceEventId: crypto.randomUUID(),
    diversityGroupId: crypto.randomUUID(),
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

test("normalizes Kalshi's public market schema without requiring display liquidity", () => {
  const normalized = normalizeKalshiMarket({
    event_ticker: "KXOPENAIIPO-26",
    series_ticker: "KXOPENAIIPO",
    category: "Companies",
    title: "OpenAI IPO timing",
  }, {
    ticker: "KXOPENAIIPO-26-DEC31",
    event_ticker: "KXOPENAIIPO-26",
    title: "Will OpenAI complete an IPO before 2027?",
    status: "active",
    open_time: "2026-07-01T00:00:00Z",
    close_time: "2026-12-15T00:00:00Z",
    last_price_dollars: "0.4200",
    volume_24h_fp: "40.00",
    volume_fp: "500.00",
    open_interest_fp: "120.00",
    liquidity_dollars: "0.0000",
    rules_primary: "Resolves Yes if OpenAI completes a public listing before the close time.",
  }, now);
  assert.equal(normalized.sourcePlatform, "kalshi");
  assert.equal(normalized.category, "Economics");
  assert.equal(normalized.sourceEventId, "kalshi:KXOPENAIIPO-26-DEC31");
  assert.equal(normalized.diversityGroupId, "kalshi-event:KXOPENAIIPO-26");
  assert.equal(normalized.yesPrice, 0.42);
  assert.equal(evaluateHardEligibility(normalized, now).eligible, true);
});

test("Kalshi early-close markets freeze at expected determination instead of the fallback close", () => {
  const normalized = normalizeKalshiMarket({
    event_ticker: "KXSPORT-26AUG16",
    series_ticker: "KXSPORT",
    category: "Sports",
    title: "Will Team A win?",
  }, {
    ticker_name: "KXSPORT-26AUG16-TEAMA",
    status: "active",
    open_date: "2026-08-15T14:00:00Z",
    close_date: "2026-08-30T14:00:00Z",
    event_occurrence_datetime: "2026-08-16T17:00:00Z",
    expected_expiration_date: "2026-08-16T17:00:00Z",
    yes_bid_dollars: "0.4800",
    yes_ask_dollars: "0.5200",
  }, now);
  assert.equal(normalized.marketId, "kalshi:KXSPORT-26AUG16-TEAMA");
  assert.equal(normalized.startTime, "2026-08-15T14:00:00.000Z");
  assert.equal(normalized.closeTime, "2026-08-16T17:00:00.000Z");
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

test("hourly persistence keeps every market in an eligible event and drops irrelevant events", () => {
  const persisted = selectPersistenceCandidates([
    candidate({ marketId: "eligible", sourceEventId: "event-a", eligible: true }),
    candidate({ marketId: "sibling", sourceEventId: "event-a", eligible: false }),
    candidate({ marketId: "irrelevant", sourceEventId: "event-b", eligible: false }),
  ]);
  assert.deepEqual(persisted.map((item) => item.marketId), ["eligible", "sibling"]);
});

test("rapid selector admits only near-close markets that pass every non-time gate", () => {
  const ranked = rankCandidates([
    candidate({
      marketId: "rapid-good",
      sourceEventId: "rapid-event-a",
      diversityGroupId: "rapid-group-a",
      closeTime: "2026-07-29T02:00:00.000Z",
    }),
    candidate({
      marketId: "rapid-low-volume",
      sourceEventId: "rapid-event-b",
      diversityGroupId: "rapid-group-b",
      closeTime: "2026-07-29T02:15:00.000Z",
      volume24h: 100,
    }),
    candidate({
      marketId: "rapid-too-soon",
      sourceEventId: "rapid-event-c",
      diversityGroupId: "rapid-group-c",
      closeTime: "2026-07-29T00:10:00.000Z",
    }),
    candidate({
      marketId: "rapid-too-late",
      sourceEventId: "rapid-event-d",
      diversityGroupId: "rapid-group-d",
      closeTime: "2026-07-29T04:00:00.000Z",
    }),
  ], now);
  const selected = selectRapidResolutionCandidates(ranked, { now, horizonHours: 3, minimumLeadMinutes: 30 });
  assert.deepEqual(selected.map((item) => item.marketId), ["rapid-good"]);
  assert.deepEqual(selected[0].reasons, ["outside_close_window"]);
});

test("rapid selector deduplicates sibling markets from one source event", () => {
  const ranked = rankCandidates([
    candidate({
      marketId: "rapid-sibling-strong",
      sourceEventId: "rapid-event-shared",
      diversityGroupId: "rapid-group-shared",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 80_000,
    }),
    candidate({
      marketId: "rapid-sibling-weak",
      sourceEventId: "rapid-event-shared",
      diversityGroupId: "rapid-group-shared",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 20_000,
    }),
  ], now);
  const selected = selectRapidResolutionCandidates(ranked, { now });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].marketId, "rapid-sibling-strong");
});

test("rapid experiment can admit a bounded number of sibling questions", () => {
  const ranked = rankCandidates([
    candidate({
      marketId: "rapid-sibling-a",
      sourceEventId: "rapid-event-shared",
      diversityGroupId: "rapid-group-shared",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 80_000,
    }),
    candidate({
      marketId: "rapid-sibling-b",
      sourceEventId: "rapid-event-shared",
      diversityGroupId: "rapid-group-shared",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 60_000,
    }),
    candidate({
      marketId: "rapid-sibling-c",
      sourceEventId: "rapid-event-shared",
      diversityGroupId: "rapid-group-shared",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 40_000,
    }),
  ], now);
  const selected = selectRapidResolutionCandidates(ranked, {
    now,
    limit: 3,
    maxPerDiversityGroup: 2,
  });
  assert.deepEqual(selected.map((item) => item.marketId), ["rapid-sibling-a", "rapid-sibling-b"]);
});

test("rapid experiment may waive long-market activity gates but keeps source quality floors", () => {
  const ranked = rankCandidates([
    candidate({
      marketId: "rapid-thin-but-valid",
      sourceEventId: "rapid-thin-event",
      diversityGroupId: "rapid-thin-group",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 0,
      totalVolume: 0,
      liquidity: 80,
      startTime: "2026-07-28T23:00:00.000Z",
    }),
    candidate({
      marketId: "rapid-no-liquidity",
      sourceEventId: "rapid-empty-event",
      diversityGroupId: "rapid-empty-group",
      closeTime: "2026-07-29T02:00:00.000Z",
      volume24h: 0,
      totalVolume: 0,
      liquidity: 0,
    }),
  ], now);
  const selected = selectRapidResolutionCandidates(ranked, {
    now,
    allowedReasons: ["outside_close_window", "low_total_volume", "low_24h_volume", "low_liquidity", "market_too_new"],
    minimumPolymarketLiquidity: 40,
  });
  assert.deepEqual(selected.map((item) => item.marketId), ["rapid-thin-but-valid"]);
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

test("dual-market selector publishes exactly 10 plus 10 with cross-source diversity", () => {
  const uniqueTerms = [
    "albatross", "banyan", "cobalt", "dahlia", "ember", "fjord",
    "garnet", "harbor", "indigo", "juniper", "keystone", "lantern",
    "monsoon", "nectar", "orchid",
    "prairie", "quartz", "redwood", "saffron", "tundra", "upland",
    "velvet", "willow", "xenon", "yarrow", "zephyr", "aurora",
    "bramble", "citadel", "drizzle",
  ];
  const candidates = ["polymarket", "kalshi"].flatMap((sourcePlatform, sourceIndex) =>
    CANONICAL_CATEGORIES.flatMap((category, categoryIndex) =>
      Array.from({ length: 3 }, (_, index) => {
        const term = uniqueTerms[sourceIndex * 15 + categoryIndex * 3 + index];
        return candidate({
          sourcePlatform,
          marketId: `${sourcePlatform}-${category}-${index}`,
          sourceEventId: `${sourcePlatform}-${category}-${index}`,
          diversityGroupId: `${sourcePlatform}-group-${category}-${index}`,
          title: `Will ${term} decide the ${category.toLowerCase()} outcome?`,
          category,
          selectionScore: 1 - index / 100,
        });
      }),
    ),
  );
  // The strongest Kalshi candidate mirrors a Polymarket question and must be
  // replaced, while a sibling strike from the same Kalshi event is also blocked.
  const mirrored = candidates.find((item) => item.marketId === "kalshi-Politics-0");
  mirrored.title = "Will albatross decide the politics outcome?";
  const firstStrike = candidates.find((item) => item.marketId === "kalshi-Economics-0");
  const siblingStrike = candidates.find((item) => item.marketId === "kalshi-Economics-1");
  firstStrike.diversityGroupId = "kalshi-shared-event";
  siblingStrike.diversityGroupId = "kalshi-shared-event";

  const selected = selectDiverseSourceBalancedCandidates(candidates);
  assert.equal(selected.length, 20);
  assert.equal(selected.filter((item) => item.sourcePlatform === "polymarket").length, 10);
  assert.equal(selected.filter((item) => item.sourcePlatform === "kalshi").length, 10);
  assert.equal(new Set(selected.map((item) => item.diversityGroupId)).size, 20);
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      assert.ok(titleSimilarity(selected[left].title, selected[right].title) < CURATION_CONFIG.titleSimilarityThreshold);
    }
  }
});

test("diversity anchors normalize named entities and possessives", () => {
  assert.ok(diversityAnchors("Will Trump leave office?").includes("trump"));
  assert.ok(diversityAnchors("Will Trump's Cabinet change?").includes("trump"));
  assert.ok(!diversityAnchors("Will the United States change policy?").includes("united"));
});
