"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { DEFAULT_CPTEC_WEIGHT, cptecProbability } from "@/lib/cptec-core.js";
import { piecewiseOddsProbability } from "@/lib/piecewise-odds-core.js";

type HistoricalModel = { id: string; name: string; organization: string; n: number; variants: number };
type HistoricalEvent = {
  id: string;
  date: string;
  source: string;
  sourceKey: string;
  questionType: "Dataset" | "Market";
  category: "Dataset" | "Market";
  question: string;
  outcome: 0 | 1;
  forecasts: Record<string, number>;
};
type HistoricalData = {
  meta: { dataset: string; generated: string; rawSourceRows: number; matchedForecastRows: number; events: number; models: number; providers: number; providerNames: string[]; questionTypes: Record<"Dataset" | "Market", number>; sourceCounts: Record<string, number>; rounds: number; firstRound: string; lastRound: string; rule: string; joinKey: string; officialQuestionMatches: number; missingOfficialQuestions: number };
  models: HistoricalModel[];
  events: HistoricalEvent[];
};

const BASE_METHODS = [
  { id: "mean", name: "Equal Mean", short: "Mean", color: "#4F207F", rule: "Arithmetic mean of every available selected forecast." },
  { id: "median", name: "Median Pool", short: "Median", color: "#EFAB02", rule: "Median probability; robust to a single extreme forecast." },
  { id: "trimmed", name: "Trimmed Mean", short: "Trimmed", color: "#168368", rule: "20% trimmed mean for K ≥ 5; equal mean fallback for smaller K." },
  { id: "logit", name: "Log-odds Pool", short: "Log-odds", color: "#C8444A", rule: "Average in log-odds space, then transform back to probability." },
  { id: "extreme", name: "Extremized Mean", short: "Extremized", color: "#5A78C7", rule: "Equal mean with its log-odds multiplied by 1.35." },
  { id: "weighted", name: "Past-performance Pool", short: "Weighted", color: "#9A5A2F", rule: "Inverse-Brier weights learned only from earlier forecast rounds." },
] as const;

const CPTEC_METHOD = {
  id: "cptec",
  name: "CPTEC",
  short: "CPTEC",
  color: "#302A33",
  rule: "Available only for two selected models. CPTEC computes sigmoid(w × logit(p₁) + (1 − w) × logit(p₂)); w applies to the first selected model.",
} as const;

const PIECEWISE_ODDS_METHOD = {
  id: "piecewise-odds",
  name: "Piecewise Odds Pool",
  short: "Piecewise Odds",
  color: "#7A3E9D",
  rule: "Available only for two selected models. Multiplies their odds, uses the geometric-mean odds when 1/5 ≤ T ≤ 5, and preserves more joint evidence outside that range: √5T below 1/5 and T/√5 above 5.",
} as const;

const METHODS = [...BASE_METHODS, CPTEC_METHOD, PIECEWISE_ODDS_METHOD] as const;

const HISTORY_DATA_VERSION = "2026-08-09-source-aware";

type MethodId = (typeof METHODS)[number]["id"];
type ScoredEvent = { event: HistoricalEvent; values: Record<MethodId, number> };
type RankingRow = { id: string; kind: "aggregation" | "model"; name: string; organization?: string; color: string; brier: number; score: number; ece: number; events: number };
type ModelPickerRow = HistoricalModel & { pickerScore: number | null; pickerEvents: number; unavailable: boolean };
type HistoryPoint = { x: number; date: string; score: number; rank: number; events: number };
type HistorySeries = { id: MethodId; name: string; short: string; color: string; values: HistoryPoint[] };

export function HistoricalArena() {
  const [data, setData] = useState<HistoricalData | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [questionType, setQuestionType] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [leaderboardView, setLeaderboardView] = useState<"methods" | "combined">("methods");
  const [cptecWeight, setCptecWeight] = useState(DEFAULT_CPTEC_WEIGHT);

  useEffect(() => {
    fetch(`/forecastbench/history.json?v=${HISTORY_DATA_VERSION}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Historical dataset could not be loaded.");
        return response.json() as Promise<HistoricalData>;
      })
      .then((payload) => {
        setData(payload);
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("models")?.split(",").filter((id) => payload.models.some((model) => model.id === id));
        const requestedWeightParam = params.get("cptec_w");
        const requestedWeight = requestedWeightParam === null ? Number.NaN : Number(requestedWeightParam);
        if (Number.isFinite(requestedWeight) && requestedWeight >= 0 && requestedWeight <= 1) setCptecWeight(requestedWeight);
        setSelected(requested?.length ? requested : commonCoverageModels(payload, 6).map((model) => model.id));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Historical dataset could not be loaded."));
  }, []);

  useEffect(() => {
    if (!selected.length) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "history");
    url.searchParams.set("models", selected.join(","));
    if (selected.length === 2) url.searchParams.set("cptec_w", cptecWeight.toFixed(2));
    else url.searchParams.delete("cptec_w");
    window.history.replaceState({}, "", url);
  }, [selected, cptecWeight]);

  const sources = useMemo(() => data ? Array.from(new Set(data.events
    .filter((event) => questionType === "all" || event.questionType === questionType)
    .map((event) => event.source))).sort() : [], [data, questionType]);
  const filteredEvents = useMemo(() => data?.events.filter((event) =>
    (questionType === "all" || event.questionType === questionType) && (source === "all" || event.source === source)
  ) ?? [], [data, questionType, source]);
  const analysis = useMemo(() => data ? analyze(filteredEvents, selected, data.models, cptecWeight) : null, [data, filteredEvents, selected, cptecWeight]);
  const modelPickerRows = useMemo(() => data ? makeModelPickerRows(data.models, filteredEvents, selected) : [], [data, filteredEvents, selected]);
  const visibleModels = useMemo(() => modelPickerRows.filter((model) => `${model.organization} ${model.name}`.toLowerCase().includes(search.toLowerCase())), [modelPickerRows, search]);

  if (error) return <section className="history-page"><div className="history-error">{error}</div></section>;
  if (!data || !analysis) return <section className="history-page history-loading"><span />Loading ForecastBench history…</section>;

  const setModelCount = (requestedCount: number) => {
    const count = Math.min(data.models.length, Math.max(2, Math.round(requestedCount)));
    setSelected((current) => {
      const retained = current.slice(0, count);
      if (retained.length === count) return retained;
      return extendCompatibleSelection(retained, modelPickerRows, filteredEvents, count);
    });
  };
  const setPreset = (preset: "diverse" | "top" | "all" | "openai") => {
    const count = Math.max(2, selected.length);
    const models = preset === "diverse" ? commonCoverageModels(data, count)
      : preset === "top" ? data.models.slice(0, count)
      : preset === "all" ? data.models
      : data.models.filter((model) => model.organization.toLowerCase() === preset);
    setSelected(extendCompatibleSelection([], models, filteredEvents, models.length));
  };
  const toggleModel = (id: string) => {
    const row = modelPickerRows.find((model) => model.id === id);
    if (row?.unavailable) return;
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const hasCompatibleCandidate = modelPickerRows.some((model) => !selected.includes(model.id) && !model.unavailable);
  const visibleRanking = leaderboardView === "combined" ? analysis.combinedRanking : analysis.ranking;
  const firstSelectedModel = data.models.find((model) => model.id === selected[0]);
  const secondSelectedModel = data.models.find((model) => model.id === selected[1]);
  const updateCptecWeight = (value: number) => {
    if (Number.isFinite(value)) setCptecWeight(Math.min(1, Math.max(0, value)));
  };

  return (
    <section className="history-page enter">
      <header className="history-hero">
        <div className="history-hero-copy">
          <span className="eyebrow">ForecastBench · historical backtest</span>
          <h1>Historical Aggregation Leaderboard</h1>
          <p>Choose the forecasters. Every aggregation method is rebuilt on the strict intersection of resolved questions forecast by every selected model.</p>
        </div>
      </header>

      <dl className="history-stat-line" aria-label="Historical benchmark summary">
        <div><dd>{data.meta.events.toLocaleString()}</dd><dt>Resolved events</dt></div>
        <div><dd>{data.meta.models}</dd><dt>Models</dt></div>
        <div><dd>{data.meta.providers}</dd><dt>Providers</dt></div>
        <div><dd>{data.meta.questionTypes.Dataset.toLocaleString()} / {data.meta.questionTypes.Market.toLocaleString()}</dd><dt>Dataset / market</dt></div>
        <div className="history-range-stat"><dt>Date range</dt><dd>{data.meta.firstRound.slice(0, 7)} — {data.meta.lastRound.slice(0, 7)}</dd></div>
      </dl>

      <div className="history-workbench">
        <main className="history-results">
        <section className="model-picker" aria-labelledby="base-forecasters-title">
          <div className="picker-heading">
            <span>INPUT 01</span>
            <h2 id="base-forecasters-title">Base forecasters</h2>
          </div>
          <p>Models are ordered by individual 1 − Brier within the active filters. An event enters the leaderboard only when every selected model forecast it; models with no common resolved events are shown in gray.</p>
          <div className="picker-count-control" aria-label="Number of selected models">
            <div><span>Selected models</span><b>{selected.length} {selected.length === 1 ? "forecaster" : "forecasters"}</b></div>
            <span className="k-stepper">
              <button type="button" onClick={() => setModelCount(selected.length - 1)} disabled={selected.length <= 2} aria-label="Select one fewer model">−</button>
              <input aria-label="Selected model count" type="number" min="2" max={data.models.length} value={selected.length} onChange={(event) => setModelCount(Number(event.target.value))} />
              <button type="button" onClick={() => setModelCount(selected.length + 1)} disabled={!hasCompatibleCandidate} aria-label="Select one more compatible model">+</button>
            </span>
          </div>
          <div className="model-preset-block">
            <span>Quick select</span>
            <div className="model-presets">
              <button onClick={() => setPreset("diverse")}>Cross-provider</button>
              <button onClick={() => setPreset("top")}>Top by coverage</button>
              <button onClick={() => setPreset("openai")}>OpenAI</button>
              <button onClick={() => setPreset("all")}>All models</button>
            </div>
          </div>
          <input className="model-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models" aria-label="Search models" />
          <div className="model-options">
            {visibleModels.map((model) => (
              <label
                key={model.id}
                className={`${selected.includes(model.id) ? "selected" : ""}${model.unavailable ? " unavailable" : ""}`.trim()}
                aria-disabled={model.unavailable}
                title={model.unavailable ? "No resolved events in common with every selected model under the active filters." : undefined}
              >
                <input type="checkbox" checked={selected.includes(model.id)} disabled={model.unavailable} onChange={() => toggleModel(model.id)} />
                <span><b>{model.name}</b><small>{model.organization} · {model.pickerScore === null ? "No scored events" : `1 − Brier ${model.pickerScore.toFixed(4)} · ${model.pickerEvents.toLocaleString()} events`}</small></span>
              </label>
            ))}
          </div>
        </section>

          <div className="history-controls">
            <div><span>INPUT 02</span><b>{selected.length < 2 ? "Select at least two forecasters" : `${analysis.eligible.toLocaleString()} events in the complete intersection`}</b></div>
            <div className="history-filter-row">
              {selected.length === 2 && <label className="cptec-weight-field">CPTEC w · {firstSelectedModel?.name ?? "first model"}
                <div className="cptec-weight-inputs">
                  <input type="range" min="0" max="1" step="0.01" value={cptecWeight} aria-label={`CPTEC weight for ${firstSelectedModel?.name ?? "the first selected model"}`} onChange={(event) => updateCptecWeight(Number(event.target.value))} />
                  <input type="number" min="0" max="1" step="0.01" value={cptecWeight} aria-label="CPTEC weight value" onChange={(event) => updateCptecWeight(Number(event.target.value))} />
                </div>
                <small>{secondSelectedModel?.name ?? "Second model"}: 1 − w = {(1 - cptecWeight).toFixed(2)}</small>
              </label>}
              <label>Question type<select value={questionType} onChange={(event) => { setQuestionType(event.target.value); setSource("all"); }}><option value="all">Dataset + market</option><option>Dataset</option><option>Market</option></select></label>
              <label>Official source<select key={questionType} value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((item) => <option key={item}>{item}</option>)}</select></label>
            </div>
          </div>

          <section className="history-ranking" aria-label="Historical aggregation leaderboard">
            <div className="history-section-title history-leaderboard-heading"><span>OUTPUT 01</span><div><h2>Leaderboard</h2><p>Lower Brier is better. Every entry is scored on the same complete-intersection event sample.</p></div></div>
            <div className="leaderboard-view-tabs" role="tablist" aria-label="Leaderboard entries">
              <button type="button" role="tab" aria-selected={leaderboardView === "methods"} className={leaderboardView === "methods" ? "active" : ""} onClick={() => { setLeaderboardView("methods"); setExpanded(null); }}>Aggregation methods</button>
              <button type="button" role="tab" aria-selected={leaderboardView === "combined"} className={leaderboardView === "combined" ? "active" : ""} onClick={() => { setLeaderboardView("combined"); setExpanded(null); }}>Methods + individual models</button>
            </div>
            <div className="history-table-scroll">
              <table>
                <thead><tr><th>Rank</th><th>{leaderboardView === "combined" ? "Method / model" : "Aggregation method"}</th><th>1 − Brier</th><th>Brier</th><th>ECE</th><th>Events</th></tr></thead>
                <tbody>{visibleRanking.length ? visibleRanking.map((row, index) => (
                  <Fragment key={row.id}>
                    <tr className={`${index === 0 ? "history-winner " : ""}${row.kind === "aggregation" ? "history-clickable" : ""}`} onClick={() => row.kind === "aggregation" && setExpanded(expanded === row.id ? null : row.id)}>
                      <td><span className={`history-rank rank-${index + 1}`}>{index + 1}</span></td>
                      <td><span className="history-method"><i style={{ background: row.color }} /><span><b>{row.name}</b>{leaderboardView === "combined" && <small>{row.kind === "aggregation" ? "Aggregation method" : `${row.organization} · Individual model`}</small>}</span></span></td>
                      <td className="history-score">{row.score.toFixed(4)}</td><td>{row.brier.toFixed(4)}</td><td>{row.ece.toFixed(4)}</td><td>{row.events.toLocaleString()}</td>
                    </tr>
                    {row.kind === "aggregation" && expanded === row.id && <tr className="history-detail"><td colSpan={6}>{analysis.methods.find((method) => method.id === row.id)?.rule}{row.id === "cptec" && ` Current weights: ${firstSelectedModel?.name ?? "first model"} ${cptecWeight.toFixed(2)}; ${secondSelectedModel?.name ?? "second model"} ${(1 - cptecWeight).toFixed(2)}.`}</td></tr>}
                  </Fragment>
                )) : <tr><td className="history-empty-row" colSpan={6}>No resolved events contain forecasts from every selected model. Choose models with overlapping forecast rounds.</td></tr>}</tbody>
              </table>
            </div>
          </section>

          <PerformanceHistory series={analysis.performanceHistory} ranking={analysis.ranking} />
        </main>
      </div>
    </section>
  );
}

function analyze(events: HistoricalEvent[], selected: string[], models: HistoricalModel[], cptecWeight: number) {
  if (selected.length < 2) return emptyAnalysis();
  const methods = selected.length === 2 ? METHODS : BASE_METHODS;
  const byDate = new Map<string, HistoricalEvent[]>();
  for (const event of events) byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);
  const history = new Map<string, { loss: number; n: number }>();
  const scored: ScoredEvent[] = [];

  for (const date of Array.from(byDate.keys()).sort()) {
    const round = byDate.get(date) ?? [];
    for (const event of round) {
      const available = selected.filter((id) => event.forecasts[id] !== undefined);
      if (available.length !== selected.length) continue;
      const probabilities = available.map((id) => event.forecasts[id]);
      const weights = available.map((id) => {
        const prior = history.get(id);
        return prior?.n ? 1 / (0.02 + prior.loss / prior.n) : 1;
      });
      scored.push({ event, values: aggregate(probabilities, weights, cptecWeight) });
    }
    for (const event of round) for (const id of selected) {
      const probability = event.forecasts[id];
      if (probability === undefined) continue;
      const prior = history.get(id) ?? { loss: 0, n: 0 };
      prior.loss += (probability - event.outcome) ** 2;
      prior.n += 1;
      history.set(id, prior);
    }
  }

  if (!scored.length) return emptyAnalysis();

  const ranking = makeRanking(scored, methods);
  const individualRanking = makeIndividualRanking(scored, selected, models);
  const combinedRanking = [...ranking, ...individualRanking].sort(compareRankingRows);
  const dates = Array.from(new Set(scored.map((item) => item.event.date))).sort();
  const runs = dates.map((date, index) => {
    const rows = scored.filter((item) => item.event.date <= date);
    const ordered = methods.map((method) => ({
      id: method.id,
      score: 1 - mean(rows.map((item) => brier(item.values[method.id], item.event.outcome))),
    })).sort((a, b) => b.score - a.score);
    return { date, index, events: rows.length, ordered };
  });
  const performanceHistory: HistorySeries[] = methods.map((method) => ({
    id: method.id,
    name: method.name,
    short: method.short,
    color: method.color,
    values: runs.map((run) => {
      const result = run.ordered.find((item) => item.id === method.id);
      return {
        x: run.index,
        date: run.date,
        score: result?.score ?? 0,
        rank: run.ordered.findIndex((item) => item.id === method.id) + 1,
        events: run.events,
      };
    }),
  }));
  return { eligible: scored.length, scored, ranking, individualRanking, combinedRanking, performanceHistory, methods };
}

function emptyAnalysis() {
  return { eligible: 0, scored: [] as ScoredEvent[], ranking: [] as RankingRow[], individualRanking: [] as RankingRow[], combinedRanking: [] as RankingRow[], performanceHistory: [] as HistorySeries[], methods: [] as (typeof METHODS)[number][] };
}

function aggregate(values: number[], weights: number[], cptecWeight: number): Record<MethodId, number> {
  const ordered = [...values].sort((a, b) => a - b);
  const arithmetic = mean(values);
  const trim = Math.floor(values.length * .2);
  const trimmed = values.length >= 5 ? mean(ordered.slice(trim, ordered.length - trim)) : arithmetic;
  const median = ordered.length % 2 ? ordered[(ordered.length - 1) / 2] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
  const logitPool = logistic(mean(values.map(logit)));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    mean: arithmetic,
    median,
    trimmed,
    logit: logitPool,
    extreme: logistic(logit(arithmetic) * 1.35),
    weighted: values.reduce((sum, value, index) => sum + value * weights[index], 0) / weightTotal,
    cptec: values.length === 2 ? cptecProbability(values, cptecWeight) : logitPool,
    "piecewise-odds": values.length === 2 ? piecewiseOddsProbability(values) : logitPool,
  };
}

function makeRanking(rows: ScoredEvent[], methods: readonly (typeof METHODS)[number][]): RankingRow[] {
  return methods.map((method) => {
    const losses = rows.map((row) => brier(row.values[method.id], row.event.outcome));
    const loss = mean(losses);
    return { id: method.id, kind: "aggregation" as const, name: method.name, color: method.color, brier: loss, score: 1 - loss, ece: ece(rows, (row) => row.values[method.id]), events: rows.length };
  }).sort(compareRankingRows);
}

function makeIndividualRanking(rows: ScoredEvent[], selected: string[], models: HistoricalModel[]): RankingRow[] {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  return selected.flatMap((modelId) => {
    const model = modelsById.get(modelId);
    if (!model) return [];
    const losses = rows.map((row) => brier(row.event.forecasts[modelId], row.event.outcome));
    const loss = mean(losses);
    return [{
      id: `model:${modelId}`,
      kind: "model" as const,
      name: model.name,
      organization: model.organization,
      color: "#302A33",
      brier: loss,
      score: 1 - loss,
      ece: ece(rows, (row) => row.event.forecasts[modelId]),
      events: rows.length,
    }];
  }).sort(compareRankingRows);
}

function compareRankingRows(a: RankingRow, b: RankingRow) {
  return a.brier - b.brier || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "aggregation" ? -1 : 1);
}

function makeModelPickerRows(models: HistoricalModel[], events: HistoricalEvent[], selected: string[]): ModelPickerRow[] {
  return models.map((model) => {
    const losses = events.flatMap((event) => {
      const probability = event.forecasts[model.id];
      return probability === undefined ? [] : [brier(probability, event.outcome)];
    });
    return {
      ...model,
      pickerScore: losses.length ? 1 - mean(losses) : null,
      pickerEvents: losses.length,
      unavailable: !selected.includes(model.id) && !hasCompleteIntersection(events, [...selected, model.id]),
    };
  }).sort((a, b) => {
    if (a.pickerScore === null) return b.pickerScore === null ? a.name.localeCompare(b.name) : 1;
    if (b.pickerScore === null) return -1;
    return b.pickerScore - a.pickerScore || b.pickerEvents - a.pickerEvents || a.name.localeCompare(b.name);
  });
}

function hasCompleteIntersection(events: HistoricalEvent[], modelIds: string[]) {
  return events.some((event) => modelIds.every((id) => event.forecasts[id] !== undefined));
}

function extendCompatibleSelection(
  initial: string[],
  candidates: Array<Pick<HistoricalModel, "id">>,
  events: HistoricalEvent[],
  target: number,
) {
  const next = [...initial];
  for (const model of candidates) {
    if (next.length >= target) break;
    if (next.includes(model.id) || !hasCompleteIntersection(events, [...next, model.id])) continue;
    next.push(model.id);
  }
  return next;
}

function diverseModels(models: HistoricalModel[], count: number) {
  const seen = new Set<string>();
  const diverse = models.filter((model) => {
    if (seen.has(model.organization)) return false;
    seen.add(model.organization);
    return true;
  });
  const selected = diverse.slice(0, count);
  return [...selected, ...models.filter((model) => !selected.some((item) => item.id === model.id)).slice(0, count - selected.length)];
}

function commonCoverageModels(data: HistoricalData, count: number) {
  const target = Math.min(data.models.length, Math.max(2, count));
  const candidates = new Map<string, string[]>();
  for (const event of data.events) {
    const organizations = new Set<string>();
    const ids: string[] = [];
    for (const model of data.models) {
      if (event.forecasts[model.id] === undefined || organizations.has(model.organization)) continue;
      organizations.add(model.organization);
      ids.push(model.id);
      if (ids.length === target) break;
    }
    if (ids.length === target) candidates.set(ids.join("|"), ids);
  }
  let bestIds: string[] = [];
  let bestOverlap = -1;
  for (const ids of candidates.values()) {
    const overlap = data.events.filter((event) => ids.every((id) => event.forecasts[id] !== undefined)).length;
    if (overlap > bestOverlap) {
      bestIds = ids;
      bestOverlap = overlap;
    }
  }
  const selected = bestIds.map((id) => data.models.find((model) => model.id === id)).filter((model): model is HistoricalModel => Boolean(model));
  return selected.length === target ? selected : diverseModels(data.models, target);
}

function ece(rows: ScoredEvent[], probabilityFor: (row: ScoredEvent) => number) {
  return Array.from({ length: 10 }, (_, index) => {
    const low = index / 10, high = (index + 1) / 10;
    const bin = rows.filter((row) => {
      const probability = probabilityFor(row);
      return probability >= low && (index === 9 ? probability <= high : probability < high);
    });
    if (!bin.length) return 0;
    const confidence = mean(bin.map(probabilityFor));
    const frequency = mean(bin.map((row) => row.event.outcome));
    return Math.abs(confidence - frequency) * bin.length / Math.max(rows.length, 1);
  }).reduce((total, value) => total + value, 0);
}

function PerformanceHistory({ series, ranking }: { series: HistorySeries[]; ranking: RankingRow[] }) {
  const [mode, setMode] = useState<"rank" | "values">("rank");
  const [requestedMethodCount, setRequestedMethodCount] = useState<number | null>(null);
  const [runWindow, setRunWindow] = useState<"6" | "12" | "all">("12");
  const methodCount = Math.min(series.length, requestedMethodCount ?? series.length);
  const totalRuns = series[0]?.values.length ?? 0;
  const visibleIds = new Set(ranking.slice(0, methodCount).map((row) => row.id));
  const firstRun = runWindow === "all" ? 0 : Math.max(0, totalRuns - Number(runWindow));
  const visibleSeries = series
    .filter((item) => visibleIds.has(item.id))
    .map((item) => ({ ...item, values: item.values.slice(firstRun) }));

  return <section className="performance-history" aria-labelledby="performance-history-title">
    <div className="history-section-title performance-history-title">
      <span>OUTPUT 02</span>
      <div>
        <h2 id="performance-history-title">Performance History</h2>
        <p>Where aggregation methods stood across scoring runs, and the scores behind those positions — resolved binary events only, matching the table&apos;s filters.</p>
      </div>
    </div>
    <div className="performance-toolbar">
      <div className="performance-view-tabs" role="group" aria-label="Performance history view">
        <button type="button" className={mode === "rank" ? "active" : ""} aria-pressed={mode === "rank"} onClick={() => setMode("rank")}>Rank</button>
        <button type="button" className={mode === "values" ? "active" : ""} aria-pressed={mode === "values"} onClick={() => setMode("values")}>Values</button>
      </div>
      <div className="performance-metric" aria-label="Performance metric">
        <span>{mode === "rank" ? "Rank by" : "Value"}</span>
        <b>1 − Brier</b>
      </div>
      <div className="performance-selectors">
        <label><span>Methods</span><select aria-label="Visible aggregation methods" value={methodCount} onChange={(event) => setRequestedMethodCount(Number(event.target.value))}>
          {series.map((_, index) => index + 1).filter((count) => count >= 3).map((count) => <option key={count} value={count}>{count} of {series.length} methods</option>)}
        </select></label>
        <label><span>Scoring runs</span><select aria-label="Performance history window" value={runWindow} onChange={(event) => setRunWindow(event.target.value as "6" | "12" | "all")}>
          <option value="6">Last 6 runs</option>
          <option value="12">Last 12 runs</option>
          <option value="all">All {totalRuns} runs</option>
        </select></label>
      </div>
    </div>
    <p className="performance-axis-note">{mode === "rank" ? "y: board position — #1 (top) is best" : "y: cumulative 1 − Brier — higher is better"} · x: scoring runs</p>
    <PerformanceHistoryChart series={visibleSeries} mode={mode} />
  </section>;
}

function PerformanceHistoryChart({ series, mode }: { series: HistorySeries[]; mode: "rank" | "values" }) {
  const [hovered, setHovered] = useState<{ item: HistorySeries; point: HistoryPoint } | null>(null);
  const width = 1000, height = 460, left = 72, right = 28, top = 34, bottom = 62;
  const points = series.flatMap((item) => item.values);
  if (!points.length) return <div className="chart-empty">Select at least two models to calculate performance history.</div>;
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const values = points.map((point) => mode === "rank" ? point.rank : point.score);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const rankDepth = Math.max(...points.map((point) => point.rank));
  const valuePadding = Math.max((rawMax - rawMin) * .18, .0025);
  const yMin = mode === "rank" ? 1 : Math.max(0, rawMin - valuePadding);
  const yMax = mode === "rank" ? rankDepth : Math.min(1, rawMax + valuePadding);
  const x = (value: number) => left + (value - xMin) / Math.max(xMax - xMin, 1) * (width - left - right);
  const y = (value: number) => top + (mode === "rank" ? value - yMin : yMax - value) / Math.max(yMax - yMin, .0001) * (height - top - bottom);
  const yTicks = mode === "rank"
    ? Array.from({ length: rankDepth }, (_, index) => index + 1)
    : Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4);
  const runPoints = series[0]?.values ?? [];
  const tickCount = Math.min(6, runPoints.length);
  const xTicks = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => runPoints[Math.round(index * (runPoints.length - 1) / Math.max(tickCount - 1, 1))])));
  const yValue = (point: HistoryPoint) => mode === "rank" ? point.rank : point.score;
  const yLabel = (value: number) => mode === "rank" ? `#${Math.round(value)}` : value.toFixed(3);
  const hoverX = hovered ? x(hovered.point.x) : 0;
  const hoverY = hovered ? y(yValue(hovered.point)) : 0;
  const tooltipX = hoverX > width - 230 ? hoverX - 202 : hoverX + 12;
  const tooltipY = Math.max(8, Math.min(height - bottom - 82, hoverY - 38));

  return <div className="history-chart performance-history-chart" onMouseLeave={() => setHovered(null)}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${mode === "rank" ? "Rank" : "1 minus Brier"} history for ${series.map((item) => item.name).join(", ")}`}>
      {yTicks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="chart-grid" /><text x={left - 10} y={y(tick) + 4} textAnchor="end">{yLabel(tick)}</text></g>)}
      {xTicks.map((point, index) => <text key={`${point.date}-${index}`} x={x(point.x)} y={height - 17} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{formatRunDate(point.date)}</text>)}
      {hovered && <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} className="performance-hover-line" />}
      {series.map((item) => <g key={item.id}>
        <polyline points={item.values.map((point) => `${x(point.x)},${y(yValue(point))}`).join(" ")} fill="none" stroke={item.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {item.values.map((point) => <circle
          key={point.date}
          cx={x(point.x)}
          cy={y(yValue(point))}
          r={hovered?.item.id === item.id && hovered.point.date === point.date ? 6 : 3.5}
          fill="#fff"
          stroke={item.color}
          strokeWidth="2.2"
          tabIndex={0}
          role="img"
          aria-label={`${item.name}, ${point.date}, rank ${point.rank}, 1 minus Brier ${point.score.toFixed(4)}`}
          onMouseEnter={() => setHovered({ item, point })}
          onFocus={() => setHovered({ item, point })}
          onBlur={() => setHovered(null)}
        />)}
      </g>)}
      {hovered && <g className="performance-tooltip" pointerEvents="none">
        <rect x={tooltipX} y={tooltipY} width="190" height="72" rx="7" />
        <circle cx={tooltipX + 14} cy={tooltipY + 17} r="4" fill={hovered.item.color} />
        <text x={tooltipX + 25} y={tooltipY + 21} className="performance-tooltip-title">{hovered.item.name}</text>
        <text x={tooltipX + 14} y={tooltipY + 41}>{formatRunDate(hovered.point.date)} · #{hovered.point.rank}</text>
        <text x={tooltipX + 14} y={tooltipY + 60}>1 − Brier {hovered.point.score.toFixed(4)} · {hovered.point.events.toLocaleString()} events</text>
      </g>}
    </svg>
    <div className="performance-legend">{series.map((item) => {
      const latest = item.values[item.values.length - 1];
      return <span key={item.id}><i style={{ background: item.color }} /><b>{item.name}</b><small>{mode === "rank" ? `#${latest?.rank ?? "—"}` : latest?.score.toFixed(4) ?? "—"}</small></span>;
    })}</div>
  </div>;
}

function formatRunDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function brier(probability: number, outcome: number) { return (probability - outcome) ** 2; }
function logit(value: number) { const clipped = Math.min(.999, Math.max(.001, value)); return Math.log(clipped / (1 - clipped)); }
function logistic(value: number) { return 1 / (1 + Math.exp(-value)); }
