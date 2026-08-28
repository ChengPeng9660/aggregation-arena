export const CANONICAL_CATEGORIES = [
  "Politics",
  "Economics",
  "Science",
  "Sports",
  "Entertainment",
];

export const CURATION_CONFIG = {
  configVersion: "dual-market-20-v2-strict-balance",
  taxonomyVersion: "prophet-taxonomy-v3",
  dailyTotal: 20,
  sourceQuotas: {
    polymarket: 10,
    kalshi: 10,
  },
  targetPerCategory: 4,
  sourceTargetPerCategory: 2,
  titleSimilarityThreshold: 0.72,
  recentDiversityDays: 7,
  minimumTotalVolume: 35_000,
  minimumVolume24h: 7_500,
  minimumLiquidity: 7_500,
  minimumCloseHours: 48,
  maximumCloseDays: 90,
  minimumMarketAgeHours: 6,
  minimumYesPrice: 0.05,
  maximumYesPrice: 0.95,
  kalshiMinimumTotalVolume: 250,
  kalshiMinimumVolume24h: 25,
  kalshiMinimumCloseHours: 48,
  kalshiMaximumCloseDays: 180,
};

const CATEGORY_RULES = [
  ["Sports", /\b(nba|nfl|nhl|mlb|fifa|uefa|champions league|premier league|world cup|super bowl|grand slam|tennis|soccer|football|basketball|baseball|hockey|sports?|match|tournament)\b/i],
  ["Economics", /\b(gdp|inflation|cpi|unemployment|recession|tariff|trade deficit|jobs report|payroll|economic growth|central bank|federal reserve|fed|bitcoin|btc|ethereum|eth|crypto|token|solana|xrp|stock|s&p|nasdaq|dow|etf|fed funds|interest rates?|oil|crude|wti|brent|commodity|market cap|ipo|company|ceo|acquisition|merger|revenue|earnings)\b/i],
  ["Science", /\b(fda|drug|vaccine|disease|health|clinical trial|science|space|nasa|climate|temperature|research|technology|artificial intelligence|ai model|language model|model release|gemini|openai|anthropic|nvidia|robot|quantum|rocket|spacecraft)\b/i],
  ["Politics", /\b(election|president|prime minister|congress|senate|governor|vote|poll|cabinet|parliament|supreme court|law|policy|government|territory|war|ceasefire|sanction|military|geopolitic|diplomatic|negotiation|strait of hormuz|nato|iran|russia|ukraine|israel|trump|democrat|republican)\b/i],
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
  const text = [market?.question, market?.title, event?.title, event?.question].filter(Boolean).join(" ");
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return { category, confidence: 0.85 };
  }
  const tagText = tags.join(" ");
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(tagText)) return { category, confidence: 0.75 };
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
    sourcePlatform: "polymarket",
    marketId,
    sourceEventId: eventId,
    diversityGroupId: `polymarket-event:${eventId}`,
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

const KALSHI_CATEGORY_MAP = new Map([
  ["elections", "Politics"],
  ["politics", "Politics"],
  ["world", "Politics"],
  ["economics", "Economics"],
  ["financials", "Economics"],
  ["companies", "Economics"],
  ["science and technology", "Science"],
  ["health", "Science"],
  ["climate and weather", "Science"],
  ["transportation", "Science"],
  ["sports", "Sports"],
  ["entertainment", "Entertainment"],
  ["social", "Entertainment"],
]);

export function normalizeKalshiMarket(event, market, now = new Date()) {
  const ticker = String(market?.ticker || market?.ticker_name || "").trim();
  const eventTicker = String(market?.event_ticker || event?.event_ticker || ticker).trim();
  const seriesTicker = String(event?.series_ticker || market?.series_ticker || "").trim();
  const baseTitle = String(market?.title || event?.title || "").trim();
  const strikeSubtitle = String(market?.yes_sub_title || market?.subtitle || "").trim();
  const strikeDateTokens = strikeSubtitle.toLowerCase().match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b20\d{2}\b/g) || [];
  const subtitleRepresented = baseTitle.toLowerCase().includes(strikeSubtitle.toLowerCase()) ||
    strikeDateTokens.length > 0 && strikeDateTokens.every((token) =>
      baseTitle.toLowerCase().includes(/^\d/.test(token) ? token : token.slice(0, 3)),
    );
  const title = strikeSubtitle && !subtitleRepresented
    ? `${baseTitle} (${strikeSubtitle})`
    : baseTitle || strikeSubtitle;
  const categoryName = String(event?.category || "").trim().toLowerCase();
  const category = KALSHI_CATEGORY_MAP.get(categoryName) || classifyMarket(event, market).category;
  const lastPrice = finiteNumberOrNull(market?.last_price_dollars ?? market?.last_price);
  const yesBid = finiteNumberOrNull(market?.yes_bid_dollars ?? market?.yes_bid);
  const yesAsk = finiteNumberOrNull(market?.yes_ask_dollars ?? market?.yes_ask);
  const yesPrice = lastPrice !== null && lastPrice > 0
    ? lastPrice
    : yesBid !== null && yesAsk !== null && yesAsk >= yesBid
      ? (yesBid + yesAsk) / 2
      : yesBid ?? yesAsk ?? 0;
  const status = String(market?.status || "").toLowerCase();
  const rules = [market?.rules_primary, market?.rules_secondary].filter(Boolean).join("\n\n").trim();
  const description = [event?.title, event?.sub_title, market?.subtitle].filter(Boolean).join(" — ").trim();
  const eventPath = String(seriesTicker || eventTicker).toLowerCase();

  return {
    sourcePlatform: "kalshi",
    marketId: `kalshi:${ticker}`,
    // Kalshi events commonly contain several strikes or dates. Each market is
    // a binary question, while diversityGroupId prevents selecting siblings.
    sourceEventId: `kalshi:${ticker}`,
    diversityGroupId: `kalshi-event:${eventTicker}`,
    eventTitle: title,
    eventNegRisk: false,
    eventNegRiskAugmented: false,
    eventSlug: eventTicker.toLowerCase(),
    marketSlug: ticker.toLowerCase(),
    seriesId: seriesTicker,
    title,
    description,
    rules,
    category,
    categoryConfidence: KALSHI_CATEGORY_MAP.has(categoryName) ? 1 : 0.7,
    tags: [event?.category, seriesTicker].filter(Boolean),
    outcomes: ["Yes", "No"],
    // Kalshi's close_time can be a far-future fallback for markets that close
    // as soon as the underlying event is determined. Prefer the expected
    // expiration/occurrence timestamp so forecasts freeze before the event,
    // while the hourly resolver still observes an earlier source-side close.
    closeTime: earliestIso(
      market?.expected_expiration_time,
      market?.expected_expiration_date,
      market?.event_occurrence_time,
      market?.event_occurrence_datetime,
      market?.close_time,
      market?.close_date,
    ),
    startTime: validIso(market?.open_time ?? market?.open_date),
    yesPrice,
    volume24h: finiteNumber(market?.volume_24h_fp ?? market?.volume_24h),
    totalVolume: finiteNumber(market?.volume_fp ?? market?.volume),
    // Kalshi frequently reports zero display liquidity. Open interest and
    // quoted size are a more stable activity-depth proxy for source ranking.
    liquidity: Math.max(
      finiteNumber(market?.open_interest_fp ?? market?.open_interest),
      finiteNumber(market?.yes_bid_size_fp ?? market?.yes_bid_size) +
        finiteNumber(market?.yes_ask_size_fp ?? market?.yes_ask_size),
    ),
    active: status === "active" || status === "open",
    closed: ["closed", "settled", "finalized"].includes(status),
    acceptingOrders: status === "active" || status === "open",
    sourceUrl: eventPath ? `https://kalshi.com/markets/${eventPath}` : "https://kalshi.com/markets",
    fetchedAt: now.toISOString(),
    raw: {
      event: {
        event_ticker: eventTicker,
        series_ticker: seriesTicker,
        category: event?.category,
        title: event?.title,
      },
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
  const isKalshi = candidate.sourcePlatform === "kalshi";
  const minimumTotalVolume = isKalshi ? CURATION_CONFIG.kalshiMinimumTotalVolume : CURATION_CONFIG.minimumTotalVolume;
  const minimumVolume24h = isKalshi ? CURATION_CONFIG.kalshiMinimumVolume24h : CURATION_CONFIG.minimumVolume24h;
  const minimumCloseHours = isKalshi ? CURATION_CONFIG.kalshiMinimumCloseHours : CURATION_CONFIG.minimumCloseHours;
  const maximumCloseDays = isKalshi ? CURATION_CONFIG.kalshiMaximumCloseDays : CURATION_CONFIG.maximumCloseDays;
  if (candidate.totalVolume < minimumTotalVolume) reasons.push("low_total_volume");
  if (candidate.volume24h < minimumVolume24h) reasons.push("low_24h_volume");
  if (!isKalshi && candidate.liquidity < CURATION_CONFIG.minimumLiquidity) reasons.push("low_liquidity");
  if (!Number.isFinite(candidate.yesPrice) || candidate.yesPrice < CURATION_CONFIG.minimumYesPrice || candidate.yesPrice > CURATION_CONFIG.maximumYesPrice) reasons.push("extreme_or_missing_price");
  if (!Number.isFinite(closeMs) || hoursToClose < minimumCloseHours || hoursToClose > maximumCloseDays * 24) reasons.push("outside_close_window");
  if (marketAgeHours !== null && marketAgeHours < CURATION_CONFIG.minimumMarketAgeHours) reasons.push("market_too_new");
  if ((candidate.description + candidate.rules).trim().length < 20) reasons.push("insufficient_resolution_detail");

  return { eligible: reasons.length === 0, reasons, hoursToClose, marketAgeHours };
}

export function rankCandidates(candidates, now = new Date()) {
  const evaluated = candidates.map((candidate) => ({ ...candidate, ...evaluateHardEligibility(candidate, now) }));
  for (const sourcePlatform of ["polymarket", "kalshi"]) {
    for (const category of CANONICAL_CATEGORIES) {
      const group = evaluated.filter((candidate) =>
        (candidate.sourcePlatform || "polymarket") === sourcePlatform && candidate.category === category,
      );
      addPercentile(group, "volume24h", "volume24Percentile");
      addPercentile(group, "liquidity", "liquidityPercentile");
      addPercentile(group, "totalVolume", "totalVolumePercentile");
    }
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

// Persist only markets that belong to an event with at least one eligible
// representative. Ranking still considers the complete fetched universe, but
// the hourly D1 write is bounded to the events that can actually reach the
// daily slate. Keeping every market in each eligible event preserves all
// categorical outcomes.
export function selectPersistenceCandidates(candidates) {
  const eligibleEventIds = new Set(
    candidates
      .filter((candidate) => candidate.eligible)
      .map((candidate) => candidate.sourceEventId),
  );
  return candidates.filter((candidate) => eligibleEventIds.has(candidate.sourceEventId));
}

export function selectRapidResolutionCandidates(candidates, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const horizonHours = Math.max(0.25, Number(options.horizonHours || 3));
  const minimumLeadMinutes = Math.max(0, Number(options.minimumLeadMinutes ?? 30));
  const limit = Math.max(1, Number(options.limit || 3));
  const maxPerDiversityGroup = Math.max(1, Number(options.maxPerDiversityGroup || 1));
  const allowedReasons = new Set(options.allowedReasons || ["outside_close_window"]);
  const minimumPolymarketLiquidity = Math.max(0, Number(options.minimumPolymarketLiquidity || 0));
  const minimumYesPrice = Math.max(0, Number(options.minimumYesPrice ?? 0));
  const maximumYesPrice = Math.min(1, Number(options.maximumYesPrice ?? 1));
  const earliestClose = now.getTime() + minimumLeadMinutes * 60_000;
  const latestClose = now.getTime() + horizonHours * 3_600_000;
  const selected = [];
  const groupCounts = new Map();

  const pool = candidates
    .filter((candidate) => {
      const closeTime = Date.parse(candidate.closeTime || "");
      const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
      return !candidate.alreadySelected
        && Number.isFinite(closeTime)
        && closeTime >= earliestClose
        && closeTime <= latestClose
        && reasons.includes("outside_close_window")
        && reasons.every((reason) => allowedReasons.has(reason))
        && Number.isFinite(candidate.yesPrice)
        && candidate.yesPrice >= minimumYesPrice
        && candidate.yesPrice <= maximumYesPrice
        && ((candidate.sourcePlatform || "polymarket") === "kalshi"
          || candidate.liquidity >= minimumPolymarketLiquidity);
    })
    .sort((left, right) =>
      right.selectionScore - left.selectionScore
      || right.volume24h - left.volume24h
      || Date.parse(left.closeTime) - Date.parse(right.closeTime)
      || left.title.localeCompare(right.title));

  for (const candidate of pool) {
    const group = candidate.diversityGroupId || candidate.sourceEventId;
    const groupCount = groupCounts.get(group) || 0;
    if (groupCount >= maxPerDiversityGroup) continue;
    selected.push({ ...candidate, categoryRank: selected.length + 1 });
    groupCounts.set(group, groupCount + 1);
    if (selected.length >= limit) break;
  }
  return selected;
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

export function selectDiverseSourceBalancedCandidates(candidates, options = {}) {
  const quotas = options.sourceQuotas || CURATION_CONFIG.sourceQuotas;
  const perCategoryTarget = options.sourceTargetPerCategory || CURATION_CONFIG.sourceTargetPerCategory;
  const similarityThreshold = options.titleSimilarityThreshold || CURATION_CONFIG.titleSimilarityThreshold;
  const recentCounts = options.recentCategoryCounts || {};
  const sources = Object.keys(quotas);
  const categoryOrder = [...CANONICAL_CATEGORIES].sort((a, b) =>
    (recentCounts[a] || 0) - (recentCounts[b] || 0) || CANONICAL_CATEGORIES.indexOf(a) - CANONICAL_CATEGORIES.indexOf(b),
  );
  const pools = new Map();
  const selected = [];
  const selectedBySource = Object.fromEntries(sources.map((source) => [source, 0]));
  const categoryCounts = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [category, 0]));
  const sourceCategoryCounts = Object.fromEntries(
    sources.map((source) => [source, Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [category, 0]))]),
  );
  const seenGroups = new Set(options.blockedDiversityGroupIds || []);
  const seenTitles = [...(options.recentTitles || [])];

  for (const source of sources) {
    pools.set(source, candidates
      .filter((candidate) =>
        candidate.eligible &&
        !candidate.alreadySelected &&
        (candidate.sourcePlatform || "polymarket") === source,
      )
      .sort((a, b) => b.selectionScore - a.selectionScore || b.volume24h - a.volume24h || a.title.localeCompare(b.title)));
  }

  const canSelect = (candidate) => {
    const diversityGroupId = candidate.diversityGroupId || candidate.sourceEventId;
    if (seenGroups.has(diversityGroupId)) return false;
    return !seenTitles.some((title) => titlesConflict(title, candidate.title, similarityThreshold));
  };

  const addCandidate = (candidate, source) => {
    const diversityGroupId = candidate.diversityGroupId || candidate.sourceEventId;
    selected.push({ ...candidate, categoryRank: categoryCounts[candidate.category] + 1 });
    selectedBySource[source] += 1;
    categoryCounts[candidate.category] += 1;
    sourceCategoryCounts[source][candidate.category] += 1;
    seenGroups.add(diversityGroupId);
    seenTitles.push(candidate.title);
  };

  // First pass: reserve two slots per domain for each provider whenever the
  // eligible universe permits it.
  for (const [categoryIndex, category] of categoryOrder.entries()) {
    const sourceOrder = categoryIndex % 2 ? [...sources].reverse() : sources;
    for (const source of sourceOrder) {
      while (
        selectedBySource[source] < quotas[source] &&
        sourceCategoryCounts[source][category] < perCategoryTarget
      ) {
        const next = pools.get(source).find((candidate) => candidate.category === category && canSelect(candidate));
        if (!next) break;
        addCandidate(next, source);
      }
    }
  }

  // Second pass: fill a provider's remaining quota from its strongest valid
  // candidates, preferring domains that are underrepresented globally and
  // within that provider. Diversity constraints are never relaxed.
  for (const source of sources) {
    while (selectedBySource[source] < quotas[source]) {
      const next = pools.get(source)
        .filter(canSelect)
        .sort((a, b) =>
          sourceCategoryCounts[source][a.category] - sourceCategoryCounts[source][b.category] ||
          categoryCounts[a.category] - categoryCounts[b.category] ||
          b.selectionScore - a.selectionScore ||
          b.volume24h - a.volume24h,
        )[0];
      if (!next) break;
      addCandidate(next, source);
    }
  }

  return selected;
}

export function validateDailySlate(selected, options = {}) {
  const dailyTotal = options.dailyTotal || CURATION_CONFIG.dailyTotal;
  const sourceQuotas = options.sourceQuotas || CURATION_CONFIG.sourceQuotas;
  const targetPerCategory = options.targetPerCategory || CURATION_CONFIG.targetPerCategory;
  const similarityThreshold = options.titleSimilarityThreshold || CURATION_CONFIG.titleSimilarityThreshold;
  const sourceCounts = Object.fromEntries(Object.keys(sourceQuotas).map((source) => [source, 0]));
  const categoryCounts = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [category, 0]));
  let categoriesKnown = true;

  for (const candidate of selected) {
    const source = candidate.sourcePlatform || "polymarket";
    if (source in sourceCounts) sourceCounts[source] += 1;
    else categoriesKnown = false;
    if (candidate.category in categoryCounts) categoryCounts[candidate.category] += 1;
    else categoriesKnown = false;
  }

  const diversityGroups = selected.map((candidate) => candidate.diversityGroupId || candidate.sourceEventId);
  const uniqueDiversityGroups = diversityGroups.every(Boolean) && new Set(diversityGroups).size === selected.length;
  let uniqueTitles = true;
  for (let left = 0; left < selected.length && uniqueTitles; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (titlesConflict(selected[left].title, selected[right].title, similarityThreshold)) {
        uniqueTitles = false;
        break;
      }
    }
  }

  const dailyTotalMet = selected.length === dailyTotal;
  const sourceQuotasMet = Object.entries(sourceQuotas).every(([source, quota]) => sourceCounts[source] === quota);
  const categoryQuotasMet = categoriesKnown && CANONICAL_CATEGORIES.every(
    (category) => categoryCounts[category] === targetPerCategory,
  );
  return {
    valid: dailyTotalMet && sourceQuotasMet && categoryQuotasMet && uniqueDiversityGroups && uniqueTitles,
    dailyTotalMet,
    sourceQuotasMet,
    categoryQuotasMet,
    uniqueDiversityGroups,
    uniqueTitles,
    sourceCounts,
    categoryCounts,
  };
}

function addPercentile(group, field, output) {
  const sorted = [...group].sort((a, b) => Number(a[field]) - Number(b[field]));
  sorted.forEach((candidate, index) => {
    candidate[output] = sorted.length <= 1 ? 1 : index / (sorted.length - 1);
  });
}

export function titleSimilarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

export function diversityAnchors(value) {
  const ignored = new Set([
    "will", "would", "could", "should", "what", "when", "where", "which", "before", "after",
    "during", "the", "this", "that", "yes", "no", "any", "president", "prime", "minister",
    "us", "usa", "united", "states", "kingdom", "health", "effective",
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
  ]);
  const tokens = String(value).match(/[A-Za-z][A-Za-z0-9.'’-]*/g) || [];
  return [...new Set(tokens.filter((token) => {
    const normalized = token.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9]/g, "");
    if (!normalized || ignored.has(normalized)) return false;
    return (/^[A-Z0-9]{2,}$/.test(token) && normalized.length >= 2) ||
      (/^[A-Z]/.test(token) && normalized.length >= 4);
  }).map((token) => token.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9]/g, "")))];
}

function titlesConflict(a, b, similarityThreshold) {
  if (titleSimilarity(a, b) >= similarityThreshold) return true;
  const left = new Set(diversityAnchors(a));
  return diversityAnchors(b).some((anchor) => left.has(anchor));
}

function tokenize(value) {
  const stopwords = new Set([
    "will", "would", "could", "should", "what", "when", "where", "which", "that", "this",
    "before", "after", "during", "from", "with", "without", "than", "have", "has", "been",
    "market", "question", "happen", "occur", "probability", "above", "below", "reach", "between",
  ]);
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function earliestIso(...values) {
  const parsed = values
    .map((value) => validIso(value))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return parsed[0] || null;
}
