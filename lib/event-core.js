export function normalizeDistribution(values, outcomeKeys) {
  const keys = outcomeKeys.map(String);
  const parsed = Object.fromEntries(keys.map((key) => [key, Math.max(0, Number(values?.[key]) || 0)]));
  const total = Object.values(parsed).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new Error("Prediction probabilities must have a positive total");
  return Object.fromEntries(keys.map((key) => [key, parsed[key] / total]));
}

export function prophetEventBrier(probabilities, resolvedOutcome, outcomeKeys) {
  const keys = outcomeKeys.map(String);
  if (!keys.length || !keys.includes(String(resolvedOutcome))) {
    throw new Error("Resolved outcome is not part of the event");
  }
  const normalized = normalizeDistribution(probabilities, keys);
  return keys.reduce((sum, key) => {
    const observed = key === String(resolvedOutcome) ? 1 : 0;
    return sum + (normalized[key] - observed) ** 2;
  }, 0) / keys.length;
}

export function aggregateDistribution(forecasts, outcomeKeys, method, weights = []) {
  const keys = outcomeKeys.map(String);
  if (!forecasts.length) return {};
  const normalizedForecasts = forecasts.map((forecast) => normalizeDistribution(forecast, keys));
  const output = {};
  for (const key of keys) {
    const values = normalizedForecasts.map((forecast) => forecast[key]);
    const equal = mean(values);
    if (method === "median") output[key] = median(values);
    else if (method === "trimmed") output[key] = trimmedMean(values);
    else if (method === "logit") output[key] = inverseLogit(mean(values.map(logit)));
    else if (method === "extremized") output[key] = inverseLogit(logit(equal) * 1.2);
    else if (method === "weighted") output[key] = weightedMean(values, weights.map((weight) => Number(weight) || 1));
    else output[key] = equal;
  }
  return normalizeDistribution(output, keys);
}

export function parseEventPredictionResponse(raw, outcomes) {
  const text = responseText(raw);
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed = findEmbeddedPredictionJson(unfenced);
  if (!parsed) parsed = recoverPartialEventPrediction(unfenced);
  if (!parsed) throw new Error("Model response did not contain a usable prediction JSON object");
  const payload = parsed?.probabilities ?? parsed?.forecasts ?? parsed?.prediction;
  const values = {};
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const supplied = String(item?.market ?? item?.outcome ?? item?.name ?? "").trim();
      const outcome = matchOutcome(supplied, outcomes);
      if (outcome) values[outcome.key] = parseProbability(item?.probability ?? item?.value);
    }
  } else if (payload && typeof payload === "object") {
    for (const [supplied, value] of Object.entries(payload)) {
      const outcome = matchOutcome(supplied, outcomes);
      if (outcome) values[outcome.key] = parseProbability(value);
    }
  }
  if (outcomes.some((outcome) => !Number.isFinite(values[outcome.key]))) {
    throw new Error("Model response did not cover every event outcome");
  }
  return {
    probabilities: normalizeDistribution(values, outcomes.map((outcome) => outcome.key)),
    rationale: limitSentences(String(parsed?.rationale || "").trim(), 3).slice(0, 1500),
    citedSourceRanks: [...new Set(
      (Array.isArray(parsed?.citedSourceRanks) ? parsed.citedSourceRanks : [])
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0 && value <= 10),
    )],
    rawText: text,
  };
}

function findEmbeddedPredictionJson(value) {
  // Reasoning-heavy providers sometimes quote the schema with zero-value
  // placeholders before emitting their final answer. Prefer the last complete
  // prediction object so an earlier example cannot shadow the actual forecast.
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== "{") continue;
    const extracted = extractBalancedJson(value, index);
    if (!extracted) continue;
    try {
      const parsed = JSON.parse(extracted);
      if (parsed && typeof parsed === "object" && (parsed.probabilities || parsed.forecasts || parsed.prediction)) {
        return parsed;
      }
    } catch {
      // Continue until a complete prediction object is found.
    }
  }
  return null;
}

function recoverPartialEventPrediction(value) {
  const output = {};
  const rationaleMatch = value.match(/"rationale"\s*:\s*("(?:\\.|[^"\\])*")/s);
  if (rationaleMatch) {
    try {
      output.rationale = JSON.parse(rationaleMatch[1]);
    } catch {
      // The probabilities are the score-critical field; rationale is optional.
    }
  }
  for (const key of ["probabilities", "forecasts", "prediction"]) {
    const keyIndex = value.search(new RegExp(`"${key}"\\s*:`));
    if (keyIndex < 0) continue;
    const colonIndex = value.indexOf(":", keyIndex);
    const openIndex = value.slice(colonIndex + 1).search(/[\[{]/);
    if (openIndex < 0) continue;
    const absoluteOpen = colonIndex + 1 + openIndex;
    const extracted = extractBalancedJson(value, absoluteOpen);
    if (!extracted) continue;
    try {
      output[key] = JSON.parse(extracted);
      return output;
    } catch {
      // Try the next supported payload key.
    }
  }
  return null;
}

function extractBalancedJson(value, start) {
  const open = value[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function matchOutcome(value, outcomes) {
  const normalized = String(value).trim().toLowerCase();
  return outcomes.find((outcome) =>
    String(outcome.key).toLowerCase() === normalized || String(outcome.label).toLowerCase() === normalized
  );
}

function responseText(raw) {
  if (typeof raw === "string") return raw;
  if (typeof raw?.response === "string") return raw.response;
  if (raw?.response && typeof raw.response === "object") return JSON.stringify(raw.response);
  if (typeof raw?.choices?.[0]?.message?.content === "string") return raw.choices[0].message.content;
  if (typeof raw?.choices?.[0]?.message?.reasoning_content === "string") {
    return raw.choices[0].message.reasoning_content;
  }
  if (typeof raw?.output_text === "string") return raw.output_text;
  return JSON.stringify(raw ?? "");
}

function parseProbability(value) {
  if (typeof value === "string") {
    const match = value.trim().match(/-?\d+(?:\.\d+)?/);
    if (!match) return Number.NaN;
    const numeric = Number(match[0]);
    return value.includes("%") || (numeric > 1 && numeric <= 100) ? numeric / 100 : numeric;
  }
  const numeric = Number(value);
  return numeric > 1 && numeric <= 100 ? numeric / 100 : numeric;
}

function limitSentences(value, maximum) {
  if (!value) return "The model returned probabilities without a written rationale.";
  const matches = value.match(/[^.!?。！？]+[.!?。！？]?/g) || [value];
  return matches.slice(0, maximum).join(" ").trim();
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimmedMean(values) {
  if (values.length < 5) return mean(values);
  const sorted = [...values].sort((a, b) => a - b);
  return mean(sorted.slice(1, -1));
}

function weightedMean(values, weights) {
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
}

function logit(value) {
  const probability = Math.min(0.999, Math.max(0.001, value));
  return Math.log(probability / (1 - probability));
}

function inverseLogit(value) {
  return 1 / (1 + Math.exp(-value));
}
