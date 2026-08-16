export function forecastAdmission(event, now = new Date()) {
  const status = String(event?.status || "");
  if (status !== "open") {
    return { accepted: false, reason: status === "locked" ? "source_or_deadline_locked" : "event_not_open" };
  }

  const closeTime = event?.close_time ?? event?.closeTime;
  if (closeTime) {
    const closeTimestamp = Date.parse(String(closeTime));
    if (!Number.isFinite(closeTimestamp) || closeTimestamp <= now.getTime()) {
      return { accepted: false, reason: "scheduled_close" };
    }
  }

  return { accepted: true, reason: null };
}

export function inspectKalshiMarket(market) {
  const result = String(market?.result || "").trim().toLowerCase();
  const status = String(market?.status || "").trim().toLowerCase();
  const resolvedOutcome = result === "yes" || result === "no" ? result : null;
  const closed = resolvedOutcome !== null
    || booleanValue(market?.closed)
    || ["closed", "determined", "finalized", "settled"].includes(status);
  return { closed, resolvedOutcome };
}

export function selectResolutionCheckRows(rows, now = new Date(), limit = 24) {
  const candidates = Array.isArray(rows) ? rows : [];
  const maximum = Math.max(1, Math.floor(Number(limit) || 24));
  const urgent = candidates.filter((row) =>
    String(row?.status) === "locked" || deadlineReached(row?.close_time ?? row?.closeTime, now),
  );
  if (urgent.length >= maximum) return rotatingWindow(urgent, maximum, now);
  const urgentSet = new Set(urgent);
  const future = candidates.filter((row) => !urgentSet.has(row));
  return [...urgent, ...rotatingWindow(future, maximum - urgent.length, now)];
}

export function inspectPolymarketBinaryMarket(market) {
  const closed = booleanValue(market?.closed);
  const prices = parseList(market?.outcomePrices).map(Number);
  const outcomes = parseList(market?.outcomes).map((value) => String(value).toLowerCase());
  const yesIndex = outcomes.indexOf("yes");
  const yesPrice = prices[yesIndex >= 0 ? yesIndex : 0];
  const resolvedOutcome = closed && Number.isFinite(yesPrice)
    ? yesPrice >= 0.999
      ? "yes"
      : yesPrice <= 0.001
        ? "no"
        : null
    : null;
  return { closed, resolvedOutcome, yesPrice };
}

export function inspectPolymarketCategoricalEvent(sourceEvent, outcomes) {
  const sourceMarkets = Array.isArray(sourceEvent?.markets) ? sourceEvent.markets : [];
  const selectedOutcomes = Array.isArray(outcomes) ? outcomes : [];
  let resolvedOutcome = null;

  for (const outcome of selectedOutcomes) {
    const market = sourceMarkets.find((item) => String(item?.id) === String(outcome?.market_id ?? outcome?.marketId));
    if (!market) continue;
    const state = inspectPolymarketBinaryMarket(market);
    if (state.resolvedOutcome === "yes") {
      resolvedOutcome = String(outcome?.outcome_key ?? outcome?.outcomeKey);
      break;
    }
  }

  const everySelectedMarketClosed = selectedOutcomes.length > 0 && selectedOutcomes.every((outcome) => {
    const market = sourceMarkets.find((item) => String(item?.id) === String(outcome?.market_id ?? outcome?.marketId));
    return market ? inspectPolymarketBinaryMarket(market).closed : false;
  });
  const closed = resolvedOutcome !== null || booleanValue(sourceEvent?.closed) || everySelectedMarketClosed;
  return { closed, resolvedOutcome };
}

function booleanValue(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function deadlineReached(value, now) {
  if (!value) return false;
  const timestamp = Date.parse(String(value));
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

function rotatingWindow(rows, count, now) {
  if (!rows.length || count <= 0) return [];
  if (rows.length <= count) return [...rows];
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const offset = (hourBucket * count) % rows.length;
  return Array.from({ length: count }, (_, index) => rows[(offset + index) % rows.length]);
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
