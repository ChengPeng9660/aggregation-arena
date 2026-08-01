export const CANONICAL_CATEGORIES = [
  "Politics",
  "Economics",
  "Science",
  "Sports",
  "Entertainment",
];

export const CURATION_CONFIG = {
  configVersion: "prophet-five-domain-slate-v4",
  taxonomyVersion: "prophet-taxonomy-v3",
  targetPerCategory: 3,
  minimumTotalVolume: 50_000,
  minimumVolume24h: 10_000,
  minimumLiquidity: 10_000,
  minimumCloseHours: 48,
  maximumCloseDays: 90,
  minimumMarketAgeHours: 6,
  minimumYesPrice: 0.05,
  maximumYesPrice: 0.95,
};

const CATEGORY_RULES = [
  ["Sports", /\b(nba|nfl|nhl|mlb|fifa|uefa|champions league|premier league|world cup|super bowl|grand slam|tennis|soccer|football|basketball|baseball|hockey|sports?|match|tournament)\b/i],
  ["Politics", /\b(election|president|prime minister|congress|senate|governor|vote|poll|cabinet|parliament|supreme court|law|policy|war|ceasefire|sanction|military|geopolitic|trump|democrat|republican)\b/i],
  ["Economics", /\b(gdp|inflation|cpi|unemployment|recession|tariff|trade deficit|jobs report|payroll|economic growth|central bank|bitcoin|btc|ethereum|eth|crypto|token|solana|xrp|stock|s&p|nasdaq|dow|etf|fed funds|interest rate|market cap|ipo|company|ceo|acquisition|merger|revenue|earnings)\b/i],
  ["Science", /\b(fda|drug|vaccine|disease|health|clinical trial|science|space|nasa|climate|temperature|research|technology|artificial intelligence|ai model|openai|anthropic|nvidia|robot|quantum)\b/i],
  ["Entertainment", /\b(oscar|grammy|emmy|movie|film|music|celebrity|award|streaming|box office|culture|pope|royal|television|tv show|album|festival)\b/i],
];

export function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

export function classifyMarket(event, market) {
  const tags = [
    ...parseList(event?.tags).map((tag) => typeof tag === "string" ? tag : tag?.label || tag?.name || tag?.slug || ""),
    ...parseList(market?.tags).map((tag) => typeof tag === "string" ? tag : tag?.label || tag?.name || tag?.slug || ""),
  ].filter(Boolean);
  const text = [event?.title, event?.question, market?.question, market?.title, tags.join(" ")].filter(Boolean).join(" ");
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return { category, confidence: tags.some((tag) => pattern.test(tag)) ? 0.95 : 0.8 };
  }
  return { category: "Entertainment", confidence: 0.45 };
}

export function normalizePolymarketMarket(event, market, now = new Date()) {
  const outcomes = parseList(market?.outcomes);
  const outcomePrices = parseList(market?.outcomePrices).map(Number);
  const yesIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "yes");
  const yesPrice = Number(market?.lastTradePrice ?? market?.bestAsk ?? outcomePrices[yesIndex >= 0 ? yesIndex : 0]);
  const categoryResult = classifyMarket(event, market);
  const title = String(market?.question || market?.title || event?.title || "").trim();
  const closeValue = market?.endDate || market?.end_date_iso || event?.endDate || event?.end_date_iso || null;
  const startValue = market?.startDate || market?.start_date_iso || event?.startDate || event?.start_date_iso || null;
  const marketId = String(market?.id || market?.conditionId || market?.condition_id || "");
  const eventId = String(event?.id || market?.eventId || market?.event_id || marketId);
  const eventSlug = String(event?.slug || "");
  const marketSlug = String(market?.slug || "");
  return {
    marketId,
    sourceEventId: eventId,
    eventTitle: String(event?.title || event?.question || title).trim(),
    eventNegRisk: event?.negRisk === true || market?.negRisk === true,
    eventNegRiskAugmented: event?.negRiskAugmented === true || event?.enableNegRisk === true && event?.negRisk === true,
    eventSlug,
    marketSlug,
    seriesId: String(event?.series?.[0]?.id || event?.seriesId || ""),
    title,
    description: String(market?.description || event?.description || "").trim(),
    rules: String(market?.resolutionSource || market?.rules || event?.resolutionSource || "").trim(),
    category: categoryResult.category,
    categoryConfidence: categoryResult.confidence,
    tags: [
      ...parseList(event?.tags).map((tag) => typeof tag === "string" ? tag : tag?.label || tag?.name || tag?.slug || ""),
      ...parseList(market?.tags).map((tag) => typeof tag === "string" ? tag : tag?.label || tag?.name || tag?.slug || ""),
    ].filter(Boolean),
    outcomes,
    closeTime: validIso(closeValue),
    startTime: validIso(startValue),
    yesPrice,
    volume24h: finiteNumber(market?.volume24hr ?? market?.volume24h ?? market?.volume_24h),
    totalVolume: finiteNumber(market?.volumeNum ?? market?.volume ?? market?.totalVolume),
    liquidity: finiteNumber(market?.liquidityNum ?? market?.liquidity),
    active: market?.active !== false && event?.active !== false,
    closed: market?.closed === true || event?.closed === true,
    acceptingOrders: market?.acceptingOrders !== false,
    sourceUrl: marketSlug
      ? `https://polymarket.com/event/${eventSlug || marketSlug}/${marketSlug}`
      : `https://polymarket.com/event/${eventSlug}`,
    fetchedAt: now.toISOString(),
    raw: {
      event: { id: event?.id, slug: event?.slug, title: event?.title, endDate: event?.endDate },
      market,
    },
  };
}

export function evaluateHardEligibility(candidate, now = new Date()) {
  const reasons = [];
  const closeMs = candidate.closeTime ? new Date(candidate.closeTime).getTime() : NaN;
  const hoursToClose = (closeMs - now.getTime()) / 3_600_000;
  const startMs = candidate.startTime ? new Date(candidate.startTime).getTime() : NaN;
  const marketAgeHours = Number.isFinite(startMs) ? (now.getTime() - startMs) / 3_600_000 : null;
  const normalizedOutcomes = candidate.outcomes.map((outcome) => String(outcome).toLowerCase()).sort();

  if (!candidate.marketId || !candidate.title) reasons.push("missing_identity");
  if (!candidate.active || candidate.closed || !candidate.acceptingOrders) reasons.push("not_open");
  if (normalizedOutcomes.length !== 2 || normalizedOutcomes[0] !== "no" || normalizedOutcomes[1] !== "yes") reasons.push("not_binary_yes_no");
  if (candidate.totalVolume < CURATION_CONFIG.minimumTotalVolume) reasons.push("low_total_volume");
  if (candidate.volume24h < CURATION_CONFIG.minimumVolume24h) reasons.push("low_24h_volume");
  if (candidate.liquidity < CURATION_CONFIG.minimumLiquidity) reasons.push("low_liquidity");
  if (!Number.isFinite(candidate.yesPrice) || candidate.yesPrice < CURATION_CONFIG.minimumYesPrice || candidate.yesPrice > CURATION_CONFIG.maximumYesPrice) reasons.push("extreme_or_missing_price");
  if (!Number.isFinite(closeMs) || hoursToClose < CURATION_CONFIG.minimumCloseHours || hoursToClose > CURATION_CONFIG.maximumCloseDays * 24) reasons.push("outside_close_window");
  if (marketAgeHours !== null && marketAgeHours < CURATION_CONFIG.minimumMarketAgeHours) reasons.push("market_too_new");
  if ((candidate.description + candidate.rules).trim().length < 20) reasons.push("insufficient_resolution_detail");

  return { eligible: reasons.length === 0, reasons, hoursToClose, marketAgeHours };
}

export function rankCandidates(candidates, now = new Date()) {
  const evaluated = candidates.map((candidate) => ({ ...candidate, ...evaluateHardEligibility(candidate, now) }));
  for (const category of CANONICAL_CATEGORIES) {
    const group = evaluated.filter((candidate) => candidate.category === category);
    addPercentile(group, "volume24h", "volume24Percentile");
    addPercentile(group, "liquidity", "liquidityPercentile");
    addPercentile(group, "totalVolume", "totalVolumePercentile");
  }
  return evaluated.map((candidate) => {
    const closeQuality = Number.isFinite(candidate.hoursToClose)
      ? Math.max(0, 1 - Math.abs(candidate.hoursToClose - 30 * 24) / (90 * 24))
      : 0;
    const selectionScore =
      0.45 * (candidate.volume24Percentile || 0) +
      0.25 * (candidate.liquidityPercentile || 0) +
      0.20 * (candidate.totalVolumePercentile || 0) +
      0.10 * closeQuality;
    return {
      ...candidate,
      selectionScore,
    };
  });
}

export function selectBalancedCandidates(candidates, options = {}) {
  const target = options.targetPerCategory || CURATION_CONFIG.targetPerCategory;
  const recentCounts = options.recentCategoryCounts || {};
  const categoryOrder = [...CANONICAL_CATEGORIES].sort((a, b) => (recentCounts[a] || 0) - (recentCounts[b] || 0));
  const selected = [];
  const seenEvents = new Set();
  const seenTitles = [];

  for (const category of categoryOrder) {
    const pool = candidates
      .filter((candidate) => candidate.eligible && !candidate.alreadySelected && candidate.category === category)
      .sort((a, b) => b.selectionScore - a.selectionScore || b.volume24h - a.volume24h);
    let categoryCount = 0;
    for (const candidate of pool) {
      if (categoryCount >= target) break;
      if (seenEvents.has(candidate.sourceEventId)) continue;
      if (seenTitles.some((title) => titleSimilarity(title, candidate.title) >= 0.8)) continue;
      selected.push({ ...candidate, categoryRank: categoryCount + 1 });
      seenEvents.add(candidate.sourceEventId);
      seenTitles.push(candidate.title);
      categoryCount += 1;
    }
  }
  return selected;
}

function addPercentile(group, field, output) {
  const sorted = [...group].sort((a, b) => Number(a[field]) - Number(b[field]));
  sorted.forEach((candidate, index) => {
    candidate[output] = sorted.length <= 1 ? 1 : index / (sorted.length - 1);
  });
}

function titleSimilarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

function tokenize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 2);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
