import assert from "node:assert/strict";
import test from "node:test";
import {
  forecastAdmission,
  inspectKalshiMarket,
  inspectPolymarketBinaryMarket,
  inspectPolymarketCategoricalEvent,
  selectResolutionCheckRows,
} from "../lib/event-state-core.js";

test("forecast admission fails closed after the stored deadline", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  assert.deepEqual(forecastAdmission({ status: "open", close_time: "2026-08-11T11:59:59.000Z" }, now), {
    accepted: false,
    reason: "scheduled_close",
  });
  assert.equal(forecastAdmission({ status: "open", close_time: "2026-08-11T12:00:01.000Z" }, now).accepted, true);
  assert.equal(forecastAdmission({ status: "locked", close_time: "2026-08-12T12:00:00.000Z" }, now).accepted, false);
});

test("Kalshi closure locks before a result and resolves once a result appears", () => {
  assert.deepEqual(inspectKalshiMarket({ status: "closed", result: "" }), {
    closed: true,
    resolvedOutcome: null,
  });
  assert.deepEqual(inspectKalshiMarket({ status: "settled", result: "YES" }), {
    closed: true,
    resolvedOutcome: "yes",
  });
});

test("Polymarket binary closure distinguishes locked from resolved", () => {
  assert.deepEqual(
    inspectPolymarketBinaryMarket({ closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.7","0.3"]' }),
    { closed: true, resolvedOutcome: null, yesPrice: 0.7 },
  );
  assert.deepEqual(
    inspectPolymarketBinaryMarket({ closed: true, outcomes: ["Yes", "No"], outcomePrices: ["0.001", "0.999"] }),
    { closed: true, resolvedOutcome: "no", yesPrice: 0.001 },
  );
});

test("categorical events lock only when the event closes and resolve on a decisive winner", () => {
  const outcomes = [
    { outcome_key: "a", market_id: "market-a" },
    { outcome_key: "b", market_id: "market-b" },
  ];
  const partiallyClosed = inspectPolymarketCategoricalEvent({
    closed: false,
    markets: [
      { id: "market-a", closed: true, outcomes: ["Yes", "No"], outcomePrices: [0, 1] },
      { id: "market-b", closed: false, outcomes: ["Yes", "No"], outcomePrices: [0.6, 0.4] },
    ],
  }, outcomes);
  assert.deepEqual(partiallyClosed, { closed: false, resolvedOutcome: null });

  const resolved = inspectPolymarketCategoricalEvent({
    closed: true,
    markets: [
      { id: "market-a", closed: true, outcomes: ["Yes", "No"], outcomePrices: [0.001, 0.999] },
      { id: "market-b", closed: true, outcomes: ["Yes", "No"], outcomePrices: [0.999, 0.001] },
    ],
  }, outcomes);
  assert.deepEqual(resolved, { closed: true, resolvedOutcome: "b" });
});

test("hourly resolution checks always include locked and deadline-passed events within a bounded source budget", () => {
  const now = new Date("2026-08-15T14:00:00.000Z");
  const rows = [
    { id: "locked", status: "locked", close_time: "2026-08-20T00:00:00.000Z" },
    { id: "due", status: "open", close_time: "2026-08-15T13:59:00.000Z" },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `future-${index}`,
      status: "open",
      close_time: "2026-09-01T00:00:00.000Z",
    })),
  ];
  const selected = selectResolutionCheckRows(rows, now, 24);
  assert.equal(selected.length, 24);
  assert.ok(selected.some((row) => row.id === "locked"));
  assert.ok(selected.some((row) => row.id === "due"));
  const nextHour = selectResolutionCheckRows(rows, new Date("2026-08-15T15:00:00.000Z"), 24);
  assert.notDeepEqual(selected.map((row) => row.id), nextHour.map((row) => row.id));
});
