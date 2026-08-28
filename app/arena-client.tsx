"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { HistoricalArena } from "./historical-arena";

const PROPHET_CATEGORIES = ["Politics", "Economics", "Science", "Sports", "Entertainment"] as const;
const FORECASTBENCH_CORRELATION_URL =
  "https://chengpeng9660.github.io/forecastbench-event-type-correlation/?type=finance_economics&metric=adjusted_pog&min_n=50&near_bi=1";

type Prediction = {
  id: string;
  name: string;
  kind: "forecaster" | "aggregate";
  probability: number;
  probabilities?: Record<string, number>;
  version: string;
  components: string[];
  updatedAt: string;
};

type ArenaEvent = {
  id: string;
  title: string;
  description: string;
  category: string;
  season: string;
  closeTime: string | null;
  status: "open" | "locked" | "resolved" | "invalid";
  eventType: "binary" | "categorical";
  sourceEventId: string | null;
  outcomes: { key: string; label: string; priceAtSelection?: number }[];
  resolution: number | null;
  resolvedOutcome: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  lockedAt: string | null;
  lockReason: string | null;
  forecasterCount: number;
  predictions: Prediction[];
};

type Participant = {
  id: string;
  name: string;
  organization: string;
  color: string;
  kind: string;
};

type LeaderboardRow = {
  id: string;
  rank: number | null;
  name: string;
  shortName: string;
  organization: string;
  kind: "forecaster" | "aggregate";
  color: string;
  brier: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  resolved: number;
  coverage: number;
  status: "listed" | "provisional" | "awaiting_resolution" | "awaiting_forecast";
  version: string;
  forecasted: number;
  pending: number;
  methodId?: string;
  aggregationScope?: "pair" | "adaptive-panel";
  modelPair?: { id: string; name: string; organization: string; color: string }[];
  modelCount?: number;
  pairCount?: number;
};

type Method = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
};

type CurationSnapshot = {
  config: {
    configVersion: string;
    dailyTotal: number;
    sourceQuotas: Record<"polymarket" | "kalshi", number>;
    targetPerCategory: number;
    recentDiversityDays: number;
    minimumTotalVolume: number;
    minimumVolume24h: number;
    minimumLiquidity: number;
    minimumCloseHours: number;
    maximumCloseDays: number;
    minimumYesPrice: number;
    maximumYesPrice: number;
    kalshiMinimumTotalVolume: number;
    kalshiMinimumVolume24h: number;
    kalshiMinimumCloseHours: number;
    kalshiMaximumCloseDays: number;
  };
  latestSync: null | {
    status: string;
    fetchedEvents: number;
    fetchedMarkets: number;
    eligibleMarkets: number;
    startedAt: string;
    completedAt: string | null;
  };
  automation: {
    status: "healthy" | "recovering" | "degraded";
    schedules: { intake: string; selection: string; forecast: string };
    latestAttemptStatus: string | null;
    latestAttemptAt: string | null;
    lastSuccessfulSyncAt: string | null;
    staleRuns: number;
    failed24h: number;
  };
  latestSelection: null | {
    id: string;
    status: string;
    candidateCount: number;
    eligibleCount: number;
    selectedCount: number;
    categoryCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
    completedAt: string | null;
  };
  categories: {
    category: string;
    candidates: number;
    eligible: number;
    selectedThisRun: number;
    selectedLast7d: number;
    target: number;
  }[];
  selectedMarkets: {
    marketId: string;
    eventId: string;
    sourcePlatform: "polymarket" | "kalshi";
    title: string;
    category: string;
    rank: number;
    score: number;
    yesPrice: number;
    currentYesPrice: number;
    volume24h: number;
    totalVolume: number;
    liquidity: number;
    closeTime: string | null;
    selectedAt: string;
    sourceUrl: string;
  }[];
};

type ForecastSource = {
  rank: number;
  title: string;
  url: string;
  content: string;
  publishedDate: string | null;
  score: number | null;
};

type ForecastModel = {
    participantId: string;
    participantName: string;
    organization: string;
    modelId: string;
    promptVersion: string;
    color: string;
};

type ForecastPipelineSnapshot = {
  models: ForecastModel[];
  model: ForecastModel;
  configured: { modelGateway: boolean; modelGatewayProblem: string | null; searchSecret: boolean };
  stats: { contextsReady: number; completed: number; failed: number; pending: number };
  runs: {
    id: string;
    eventId: string;
    title: string;
    category: string;
    contextId: string;
    participantId: string;
    modelId: string;
    status: "running" | "completed" | "failed";
    yesProbability: number | null;
    noProbability: number | null;
    probabilities: Record<string, number>;
    rationale: string | null;
    citedSourceRanks: number[];
    sources: ForecastSource[];
    sourceCount: number;
    provider: string;
    searchQuery: string;
    marketSnapshot: {
      sourceUrl?: string;
      outcomes?: { key: string; label: string; priceAtSelection?: number }[];
      atSelection?: { yesPrice?: number; volume24h?: number; totalVolume?: number; liquidity?: number };
      atForecast?: { yesPrice?: number; volume24h?: number; totalVolume?: number; liquidity?: number };
    };
    latencyMs: number | null;
    error: string | null;
    asOfTime: string;
    completedAt: string | null;
  }[];
};

type Snapshot = {
  generatedAt: string;
  stats: {
    openEvents: number;
    resolvedEvents: number;
    activeForecasters: number;
    totalForecasts: number;
    leaderBrier: number | null;
    leaderName: string | null;
  };
  leaderboard: LeaderboardRow[];
  events: ArenaEvent[];
  participants: Participant[];
  methods: Method[];
  seasons: string[];
  categories: string[];
  activity: {
    id: number;
    action: string;
    entityType: string;
    entityId: string;
    detail: Record<string, unknown>;
    actor: string;
    createdAt: string;
  }[];
  methodology: {
    primaryMetric: string;
    displayMetric: string;
    minimumResolved: number;
    coverageRule: string;
    weightingRule: string;
  };
  curation: CurationSnapshot;
  forecastPipeline: ForecastPipelineSnapshot;
};

type View = "pipeline" | "leaderboard" | "history" | "curation" | "forecasts" | "events" | "methods" | "activity";
type LeaderboardTrack = "aggregators" | "forecasters";
type Dialog =
  | { type: "create-event" }
  | { type: "create-participant" }
  | { type: "forecasts"; event: ArenaEvent }
  | { type: "resolve"; event: ArenaEvent }
  | { type: "event"; event: ArenaEvent }
  | null;

const ACTION_LABELS: Record<string, string> = {
  "event.created": "Event created",
  "event.resolved": "Event resolved",
  "event.reopened": "Event reopened",
  "event.invalidated": "Event invalidated",
  "forecast.batch_submitted": "Forecast batch submitted",
  "forecast.automated_completed": "Automated forecast completed",
  "forecast.pipeline_failed": "Forecast pipeline failed",
  "participant.upserted": "Forecaster updated",
  "curation.event_selected": "Market event selected",
  "curation.event_locked": "Market event locked",
  "curation.event_resolved": "Market event resolved",
  "curation.selection_incomplete": "Daily release held for source quota",
};

export function ArenaClient() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("leaderboard");
  const [leaderboardTrack, setLeaderboardTrack] = useState<LeaderboardTrack>("aggregators");
  const [windowRange, setWindowRange] = useState("all");
  const [category, setCategory] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const navigateView = (next: View) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "history") url.searchParams.set("view", "history");
    else {
      url.searchParams.delete("view");
      url.searchParams.delete("models");
    }
    window.history.replaceState({}, "", url);
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    const initialView = window.setTimeout(() => {
      if (requested === "history") setView("history");
    }, 0);
    return () => window.clearTimeout(initialView);
  }, []);

  const openForecastbenchCorrelation = () => {
    window.location.href = FORECASTBENCH_CORRELATION_URL;
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError("");
    const params = new URLSearchParams({ track: leaderboardTrack, window: windowRange, category });
    try {
      const response = await fetchWithTimeout(`/api/arena?${params}`, { cache: "no-store" }, 15000);
      const payload = await readApiResponse<Snapshot & { message?: string }>(response);
      if (!response.ok) throw new Error(payload.message || "Failed to load benchmark data");
      setSnapshot(payload);
      setError("");
    } catch (loadError) {
      if (!silent) setError(apiErrorMessage(loadError, "Failed to load benchmark data"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [leaderboardTrack, windowRange, category]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => load(true), 60000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [load]);

  const post = async (payload: Record<string, unknown>, successMessage: string) => {
    setMutating(true);
    setError("");
    try {
      const response = await fetch("/api/arena", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readApiResponse<{ ok: boolean; message?: string }>(response);
      if (!response.ok) throw new Error(result.message || "Operation failed");
      setDialog(null);
      setToast(successMessage);
      window.setTimeout(() => setToast(""), 2600);
      await load(true);
    } catch (mutationError) {
      setError(apiErrorMessage(mutationError, "Operation failed"));
    } finally {
      setMutating(false);
    }
  };

  const openEvents = useMemo(
    () => snapshot?.events.filter((event) => event.status === "open" || event.status === "locked") ?? [],
    [snapshot],
  );
  const resolvedEvents = useMemo(
    () => snapshot?.events.filter((event) => event.status === "resolved") ?? [],
    [snapshot],
  );

  return (
    <div className="arena-app public-arena">
      <header className="public-header">
        <div className="public-header-inner">
          <button className="public-brand" onClick={() => navigateView("leaderboard")} aria-label="Aggrena home">
            <span className="public-mark" aria-hidden="true"><i /><i /><i /><em /></span>
            <strong>Aggrena</strong>
          </button>
          <nav aria-label="Public benchmark navigation">
            <PublicNavButton active={view === "leaderboard"} label="Leaderboard" onClick={() => navigateView("leaderboard")} />
            <PublicNavButton active={view === "history"} label="Historical Arena" onClick={() => navigateView("history")} />
            <PublicNavButton active={view === "events"} label="Events" onClick={() => navigateView("events")} />
            <PublicNavButton active={view === "pipeline"} label="How it works" onClick={() => navigateView("pipeline")} />
            <PublicNavButton active={view === "methods"} label="Methodology" onClick={() => navigateView("methods")} />
            <PublicNavButton
              active={false}
              label="ForecastBench Correlation"
              onClick={openForecastbenchCorrelation}
            />
          </nav>
          <div className="public-live"><span />Live benchmark</div>
        </div>
      </header>

      <main className="main-surface public-surface">

        {view !== "history" && error && <div className="error-banner"><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
        {view === "history" ? <HistoricalArena /> : loading && !snapshot ? <LoadingState /> : snapshot ? (
          <>
            {view === "pipeline" && <PipelineView snapshot={snapshot} onOpenEvent={(event) => setDialog({ type: "event", event })} />}
            {view === "leaderboard" && (
              <LeaderboardView
                snapshot={snapshot}
                windowRange={windowRange}
                category={category}
                track={leaderboardTrack}
                onWindow={setWindowRange}
                onCategory={setCategory}
                onTrack={setLeaderboardTrack}
              />
            )}
            {view === "events" && (
              <EventsView
                snapshot={snapshot}
                openEvents={openEvents}
                resolvedEvents={resolvedEvents}
                onDetail={(event) => setDialog({ type: "event", event })}
              />
            )}
            {view === "curation" && <CurationView snapshot={snapshot} />}
            {view === "forecasts" && (
              <ForecastsView
                snapshot={snapshot}
                busy={mutating}
                onRun={() => post({ action: "run_forecast_batch" }, "One forecast job completed")}
              />
            )}
            {view === "methods" && <MethodsView snapshot={snapshot} />}
            {view === "activity" && <ActivityView snapshot={snapshot} />}
          </>
        ) : null}
      </main>

      <footer className="public-footer">
        <div><strong>Aggrena</strong><span>Open forecasting aggregation benchmark</span></div>
        <p>
          {view === "history"
            ? "ForecastBench history · interactive model selection · resolved Brier scoring"
            : "Polymarket + Kalshi questions · frozen research context · public Event Brier scoring"}
        </p>
      </footer>

      {dialog && (
        <DialogShell title={dialogTitle(dialog)} kicker={dialogKicker(dialog)} onClose={() => setDialog(null)}>
          {dialog.type === "create-event" && <CreateEventForm snapshot={snapshot} busy={mutating} onSubmit={(payload) => post({ action: "create_event", ...payload }, "Event created") } />}
          {dialog.type === "create-participant" && <CreateParticipantForm busy={mutating} onSubmit={(payload) => post({ action: "create_participant", ...payload }, "Forecaster saved") } />}
          {dialog.type === "forecasts" && snapshot && <ForecastForm event={dialog.event} participants={snapshot.participants} busy={mutating} onSubmit={(forecasts) => post({ action: "submit_forecasts", eventId: dialog.event.id, forecasts }, "Probabilities saved and aggregations recomputed") } />}
          {dialog.type === "resolve" && <ResolveForm event={dialog.event} busy={mutating} onSubmit={(resolvedOutcome, note) => post({
            action: "resolve_event", eventId: dialog.event.id,
            resolvedOutcome,
            resolution: resolvedOutcome === "yes" ? 1 : resolvedOutcome === "no" ? 0 : "",
            note,
          }, "Event resolved and leaderboard updated") } />}
          {dialog.type === "event" && <EventDetail event={dialog.event} />}
        </DialogShell>
      )}
      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}

function PublicNavButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{label}</button>;
}

function PipelineView({ snapshot, onOpenEvent }: { snapshot: Snapshot; onOpenEvent: (event: ArenaEvent) => void }) {
  const curation = snapshot.curation;
  const pipeline = snapshot.forecastPipeline;
  const [selectedEventId, setSelectedEventId] = useState(pipeline.runs[0]?.eventId || "");
  const run = pipeline.runs.find((item) => item.eventId === selectedEventId) || pipeline.runs[0];
  const eventRuns = run ? pipeline.runs.filter((item) => item.eventId === run.eventId) : [];
  const modelComparisons = pipeline.models.map((model) => ({
    model,
    run: eventRuns.find((item) => item.participantId === model.participantId || item.modelId === model.modelId),
  }));
  const citedSourceRanks = new Set(eventRuns.flatMap((item) => item.citedSourceRanks));
  const runEvent = run ? snapshot.events.find((event) => event.id === run.eventId) : undefined;
  const selectedMarket = run ? curation.selectedMarkets.find((market) => market.eventId === run.eventId) : curation.selectedMarkets[0];
  const fetched = curation.latestSync?.fetchedMarkets || 0;
  const eligible = curation.latestSync?.eligibleMarkets || 0;
  const selected = curation.latestSelection?.selectedCount || 0;
  const automation = curation.automation;

  return (
    <div className="page-content pipeline-story enter">
      <section className="page-heading pipeline-heading">
        <div>
          <h1>Pipeline</h1>
          <p>Live question selection, evidence, model input, and prediction output.</p>
        </div>
        <div className="updated-stamp"><span /><div><small>Snapshot generated</small><b>{formatDateTime(snapshot.generatedAt)}</b></div></div>
      </section>

      <section className={`automation-health ${automation.status}`}>
        <span aria-hidden="true" />
        <div><small>AUTOMATION</small><b>{automation.status}</b></div>
        <p>Hourly intake at :00 · daily forecast at 00:20 UTC · daily selection at 00:10 UTC</p>
        <dl><DetailTerm label="Last successful sync" value={automation.lastSuccessfulSyncAt ? formatDateTime(automation.lastSuccessfulSyncAt) : "Waiting"} /><DetailTerm label="Latest attempt" value={automation.latestAttemptStatus || "Waiting"} /></dl>
      </section>

      <nav className="story-rail" aria-label="Pipeline stages">
        {["Market intake", "Quality gates", "Balanced slate", "Evidence freeze", "Model call", "Prediction output"].map((label, index) => (
          <a key={label} href={`#pipeline-stage-${index + 1}`}><span>{String(index + 1).padStart(2, "0")}</span><b>{label}</b></a>
        ))}
      </nav>

      <section id="pipeline-stage-1" className="story-stage">
        <StageHeader number="01" eyebrow="SOURCE" title="Market intake" summary="Active Polymarket and Kalshi events are synced hourly." />
        <div className="funnel-visual">
          <FunnelBar label="Top-volume events fetched" value={curation.latestSync?.fetchedEvents || 0} max={Math.max(1, curation.latestSync?.fetchedEvents || 0)} detail="Active events ordered by 24h volume" tone="purple" />
          <FunnelBar label="Markets normalized" value={fetched} max={Math.max(1, fetched)} detail="Canonical IDs, prices, rules, volume" tone="purple" />
          <FunnelBar label="Markets passing all gates" value={eligible} max={Math.max(1, fetched)} detail={`${fetched ? ((eligible / fetched) * 100).toFixed(1) : "0.0"}% of normalized universe`} tone="gold" />
        </div>
        <div className="stage-note"><b>Input</b><span>Polymarket Gamma + Kalshi public market records</span><b>Refresh</b><span>{automation.schedules.intake}</span><b>Latest status</b><span>{automation.latestAttemptStatus || "Waiting for first sync"}</span></div>
      </section>

      <section id="pipeline-stage-2" className="story-stage">
        <StageHeader number="02" eyebrow="FILTERS" title="Quality gates" summary="Source-specific activity gates feed one shared diversity policy." />
        <div className="gate-line">
          <Gate label="Daily mix" value={`${curation.config.sourceQuotas.polymarket} + ${curation.config.sourceQuotas.kalshi}`} />
          <Gate label="Market probability" value={`${curation.config.minimumYesPrice * 100}–${curation.config.maximumYesPrice * 100}%`} />
          <Gate label="Close window" value={`Poly ${curation.config.maximumCloseDays}d · Kalshi ${curation.config.kalshiMaximumCloseDays}d`} />
          <Gate label="Repeat block" value={`${curation.config.recentDiversityDays} days`} />
        </div>
        <div className="category-flow">
          {curation.categories.map((item) => (
            <div key={item.category}>
              <span>{item.category}</span>
              <i><em style={{ width: `${item.candidates ? Math.max(3, (item.eligible / item.candidates) * 100) : 0}%` }} /></i>
              <code>{item.candidates} → {item.eligible} eligible</code>
            </div>
          ))}
        </div>
      </section>

      <section id="pipeline-stage-3" className="story-stage">
        <StageHeader number="03" eyebrow="SELECTION" title="Daily question slate" summary="Exactly 10 questions per provider and 4 per domain, with cross-market and recent-history deduplication." />
        <div className="release-summary">
          <div><small>Release ID</small><strong>{curation.latestSelection?.id || "Pending"}</strong></div>
          <div><small>Eligible candidates</small><strong>{curation.latestSelection?.eligibleCount || 0}</strong></div>
          <div><small>Selected events</small><strong>{selected}</strong></div>
          <div><small>Source mix</small><strong>{curation.latestSelection ? `${curation.latestSelection.sourceCounts.polymarket || 0} + ${curation.latestSelection.sourceCounts.kalshi || 0}` : "10 + 10"}</strong></div>
        </div>
        <div className="stage-table-wrap"><table className="stage-table"><thead><tr><th>Source</th><th>Category</th><th>Selected question</th><th>Selection score</th><th>24h volume</th><th>Market probability</th></tr></thead><tbody>
          {curation.selectedMarkets.slice(0, 8).map((market) => <tr key={market.marketId}><td>{sourceLabel(market.sourcePlatform)}</td><td>{market.category}</td><td><button onClick={() => { const event = snapshot.events.find((item) => item.id === market.eventId); if (event) onOpenEvent(event); }}>{market.title}</button></td><td>{market.score.toFixed(3)}</td><td>{formatCompactMoney(market.volume24h)}</td><td>{(market.yesPrice * 100).toFixed(1)}%</td></tr>)}
        </tbody></table></div>
      </section>

      <section id="pipeline-stage-4" className="story-stage">
        <StageHeader number="04" eyebrow="EVIDENCE" title="Research context" summary="Tavily sources and the market snapshot are frozen once per event." />
        <RunSelector runs={pipeline.runs} selected={run?.eventId || ""} onSelect={setSelectedEventId} modelCount={pipeline.models.length} />
        {run ? <div className="evidence-layout">
          <div className="query-panel"><small>SEARCH QUERY</small><code>{run.searchQuery || run.title}</code><dl><DetailTerm label="Provider" value={run.provider} /><DetailTerm label="As-of time" value={formatDateTime(run.asOfTime)} /><DetailTerm label="Frozen sources" value={String(run.sourceCount)} /><DetailTerm label="Context ID" value={run.contextId} /></dl></div>
          <div className="evidence-stack">{run.sources.slice(0, 6).map((source) => <a key={source.rank} href={source.url} target="_blank" rel="noreferrer"><span>{String(source.rank).padStart(2, "0")}</span><div><b>{source.title}</b><small>{sourceHost(source.url)}{source.publishedDate ? ` · ${formatSourceDate(source.publishedDate)}` : ""}{citedSourceRanks.has(source.rank) ? " · cited by model" : ""}</small><p>{source.content}</p></div></a>)}</div>
        </div> : <div className="empty-block">No model context has been created yet.</div>}
      </section>

      <section id="pipeline-stage-5" className="story-stage">
        <StageHeader number="05" eyebrow="INFERENCE" title="Model call" summary="Question, rules, evidence, and market data are assembled into a versioned prompt." />
        <div className="model-call-layout">
          <div className="model-registry">{modelComparisons.map(({ model, run: modelRun }) => <div className="model-identity" key={model.participantId}><span className="model-pulse" style={{ background: model.color, boxShadow: `0 0 0 7px ${model.color}1a` }} /><small>{modelRun?.status || "PENDING"}</small><h3>{model.participantName}</h3><code>{model.modelId}</code><dl><DetailTerm label="Model family" value={model.organization} /><DetailTerm label="Context" value={modelRun?.contextId || run?.contextId || "Awaiting context"} /><DetailTerm label="Prompt version" value={model.promptVersion} /></dl></div>)}</div>
          <div className="prompt-anatomy"><small>PROMPT ASSEMBLY</small>{[
            ["01", "Current time", run?.asOfTime || "Awaiting context"],
            ["02", "Forecasting question", run?.title || selectedMarket?.title || "Awaiting selected event"],
            ["03", "Resolution rules", runEvent?.description || "Exact market rules and deadline"],
            ["04", "Allowed outcomes", runEvent?.outcomes.map((outcome) => outcome.label).join(" · ") || "Yes · No"],
            ["05", "Shared evidence", `${run?.sourceCount || 0} frozen Tavily sources`],
            ["06", "Market data", selectedMarket ? `${sourceLabel(selectedMarket.sourcePlatform)} · ${(selectedMarket.yesPrice * 100).toFixed(1)}% at selection · ${formatCompactMoney(selectedMarket.volume24h)} 24h volume` : "Frozen market snapshot"],
            ["07", "Output contract", "Rationale + every outcome probability + cited source ranks"],
          ].map(([number, label, value]) => <div key={number}><span>{number}</span><b>{label}</b><p>{value}</p></div>)}</div>
        </div>
      </section>

      <section id="pipeline-stage-6" className="story-stage output-stage">
        <StageHeader number="06" eyebrow="OUTPUT" title="Model predictions" summary={`${pipeline.models.length} active models are compared on the same event and frozen context.`} />
        {run ? <div className="model-prediction-grid">{modelComparisons.map(({ model, run: modelRun }) => {
          const probabilities = predictionProbabilities(modelRun);
          return <article className={`model-prediction ${modelRun?.status || "pending"}`} key={model.participantId} style={{ borderTopColor: model.color }}>
            <header className="model-prediction-head"><div><small>{model.organization}</small><h3>{model.participantName}</h3><code>{model.modelId}</code></div><span>{modelRun?.status || "pending"}</span></header>
            {modelRun ? <>
              <div className="probability-visual"><small>PROBABILITY DISTRIBUTION</small>{Object.entries(probabilities).map(([key, probability], index) => <div key={key}><header><b>{runEvent?.outcomes.find((outcome) => outcome.key === key)?.label || key}</b><strong>{(probability * 100).toFixed(1)}%</strong></header><i><em className={index === 0 ? "gold" : "purple"} style={{ width: `${probability * 100}%` }} /></i></div>)}</div>
              <div className="prediction-explanation"><small>MODEL RATIONALE</small><blockquote>{modelRun.rationale || "The model returned a probability distribution without a written rationale."}</blockquote><dl><DetailTerm label="Latency" value={modelRun.latencyMs === null ? "—" : `${(modelRun.latencyMs / 1000).toFixed(1)} seconds`} /><DetailTerm label="Cited evidence" value={modelRun.citedSourceRanks.length ? modelRun.citedSourceRanks.map((rank) => `#${rank}`).join(", ") : "None"} /><DetailTerm label="Context ID" value={modelRun.contextId} /></dl></div>
            </> : <div className="prediction-pending"><b>Awaiting prediction</b><p>This model will reuse Context ID <code>{run.contextId}</code> in the next model-event batch. Tavily will not run again.</p></div>}
          </article>;
        })}</div> : <div className="empty-block">No model output is available yet.</div>}
        <div className="scoring-line"><span>MODEL FORECASTS</span><i>→</i><span>EIGHT DETERMINISTIC METHODS</span><i>→</i><span>EVENT RESOLUTION</span><i>→</i><span>EVENT BRIER</span><i>→</i><span>LIVE LEADERBOARD</span></div>
      </section>
    </div>
  );
}

function StageHeader({ number, eyebrow, title, summary }: { number: string; eyebrow: string; title: string; summary: string }) {
  return <header className="stage-header"><span>{number}</span><div><small>{eyebrow}</small><h2>{title}</h2></div><p>{summary}</p></header>;
}

function FunnelBar({ label, value, max, detail, tone }: { label: string; value: number; max: number; detail: string; tone: "purple" | "gold" }) {
  return <div><header><b>{label}</b><strong>{value.toLocaleString()}</strong></header><i><em className={tone} style={{ width: `${Math.max(value ? 2 : 0, (value / max) * 100)}%` }} /></i><small>{detail}</small></div>;
}

function Gate({ label, value }: { label: string; value: string }) {
  return <div><span>PASS</span><b>{label}</b><strong>{value}</strong></div>;
}

function DetailTerm({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function RunSelector({ runs, selected, onSelect, modelCount }: { runs: ForecastPipelineSnapshot["runs"]; selected: string; onSelect: (id: string) => void; modelCount: number }) {
  if (!runs.length) return null;
  const events = Array.from(new Map(runs.map((run) => [run.eventId, run])).values());
  return <label className="run-selector">Compare models on one Event<select value={selected} onChange={(event) => onSelect(event.target.value)}>{events.map((eventRun) => {
    const completedModels = new Set(runs.filter((item) => item.eventId === eventRun.eventId && item.status === "completed").map((item) => item.participantId)).size;
    return <option key={eventRun.eventId} value={eventRun.eventId}>{eventRun.title} · {completedModels}/{modelCount} models</option>;
  })}</select></label>;
}

function predictionProbabilities(run: ForecastPipelineSnapshot["runs"][number] | undefined) {
  if (!run) return {};
  if (Object.keys(run.probabilities).length) return run.probabilities;
  return run.yesProbability === null ? {} : { Yes: run.yesProbability, No: run.noProbability || 0 };
}

function LeaderboardView({
  snapshot,
  windowRange,
  category,
  track,
  onWindow,
  onCategory,
  onTrack,
}: {
  snapshot: Snapshot;
  windowRange: string;
  category: string;
  track: LeaderboardTrack;
  onWindow: (value: string) => void;
  onCategory: (value: string) => void;
  onTrack: (value: LeaderboardTrack) => void;
}) {
  const isMethods = track === "aggregators";
  const pairMetadata = snapshot.leaderboard.find((row) => row.aggregationScope === "pair");

  return (
    <div className="page-content public-leaderboard enter">
      <section className="public-leaderboard-hero">
        <div className="public-hero-copy">
          <span className="eyebrow">AGGRENA · LIVE BENCHMARK</span>
          <h1 className="public-hero-title">Forecast Aggregation Leaderboard</h1>
          <p>Aggregation methods combine independent AI forecasts on real prediction markets and are scored in public when events resolve.</p>
          <div className="public-hero-actions">
            <a
              className="submission-button"
              href="https://github.com/ChengPeng9660/aggregation-arena/issues/new?title=Aggregation%20method%20submission"
              target="_blank"
              rel="noreferrer"
            >Submit your aggregation method <span aria-hidden="true">↗</span></a>
          </div>
        </div>
      </section>

      <section className="public-stat-line" aria-label="Benchmark summary">
        <div><strong>{snapshot.methods.length}</strong><span>Ranked methods</span></div>
        <div><strong>{snapshot.stats.openEvents}</strong><span>Open events</span></div>
        <div><strong>{snapshot.stats.resolvedEvents}</strong><span>Resolved</span></div>
        <div><strong>{snapshot.stats.totalForecasts}</strong><span>Locked forecasts</span></div>
        <div className="computed-stat"><span>Last computed</span><strong>{formatTime(snapshot.generatedAt)}</strong></div>
      </section>

      <section className="public-ranking-section" id="rankings">
        <div className="public-ranking-toolbar">
          <div className="leaderboard-tabs" role="tablist" aria-label="Leaderboard type">
            <button role="tab" aria-selected={isMethods} className={isMethods ? "active" : ""} onClick={() => onTrack("aggregators")}>Aggregation Methods</button>
            <button role="tab" aria-selected={!isMethods} className={!isMethods ? "active" : ""} onClick={() => onTrack("forecasters")}>Individual Models</button>
          </div>
          <div className="select-row">
            <label>Window<select value={windowRange} onChange={(event) => onWindow(event.target.value)}><option value="all">All time</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select></label>
            <label>Category<select value={category} onChange={(event) => onCategory(event.target.value)}><option value="all">All categories</option>{snapshot.categories.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <button className="export-button" onClick={() => exportLeaderboard(snapshot)} disabled={!snapshot.leaderboard.length}>Export CSV ↓</button>
        </div>

        <section className="leaderboard-panel public-ranking-table">
          <div className="table-caption">
            <div><b>{isMethods ? "Aggregation method standings" : "Individual model standings"}</b><span>{isMethods
              ? `Best two-model combination per deterministic method · ${pairMetadata?.modelCount ?? 0} models with eligible forecasts and ${pairMetadata?.pairCount ?? 0} overlapping pairs considered · fewer than ${snapshot.methodology.minimumResolved} common resolutions are provisional`
              : `All registered models are shown · fewer than ${snapshot.methodology.minimumResolved} resolved events are provisional`
            }</span></div>
            <span className="metric-definition">Event Brier · lower is better</span>
          </div>
          <div className="table-scroll">
            <table className={isMethods ? "methods-table" : undefined}>
              {isMethods && <colgroup>
                <col className="methods-rank-column" />
                <col className="methods-name-column" />
                <col className="methods-pair-column" />
                <col className="methods-score-column" />
                <col className="methods-resolved-column" />
                <col className="methods-coverage-column" />
              </colgroup>}
              <thead><tr><th>Rank</th><th>{isMethods ? "Method" : "Model"}</th>{isMethods && <th>Model pair / panel</th>}<th>Event Brier ↓</th><th>{isMethods ? "Common resolved" : "Resolved / live"}</th><th>Coverage</th></tr></thead>
              <tbody>
                {snapshot.leaderboard.length ? snapshot.leaderboard.map((row) => <LeaderboardRowView key={row.id} row={row} showInputs={isMethods} />) : (
                  <tr><td colSpan={isMethods ? 6 : 5} className="empty-cell">No resolved scores match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>

    </div>
  );
}

function LeaderboardRowView({ row, showInputs = false }: { row: LeaderboardRow; showInputs?: boolean }) {
  const rank = row.rank;
  const brier = row.brier;
  const hasScore = rank !== null && brier !== null;
  const statusLabel = row.status === "provisional"
    ? "PROV"
    : row.status === "awaiting_resolution"
      ? "PENDING"
      : row.status === "awaiting_forecast"
        ? "QUEUED"
        : null;
  return (
    <tr className={hasScore && rank <= 3 ? "top-row" : !hasScore ? "awaiting-row" : ""}>
      <td><span className={`rank ${hasScore ? `rank-${rank}` : "rank-pending"}`}>{hasScore ? String(rank).padStart(2, "0") : "—"}</span></td>
      <td><div className="method-cell"><i style={{ background: row.color }} /><div><b>{row.name}</b></div>{statusLabel && <em>{statusLabel}</em>}</div></td>
      {showInputs && <td>{row.aggregationScope === "pair" && row.modelPair?.length === 2
        ? <div className="model-pair-cell">
            <span><i style={{ background: row.modelPair[0].color }} /><b>{row.modelPair[0].name}</b></span>
            <em aria-hidden="true">+</em>
            <span><i style={{ background: row.modelPair[1].color }} /><b>{row.modelPair[1].name}</b></span>
          </div>
        : <div className="model-panel-cell"><b>Adaptive model panel</b><small>Event-specific available forecasts</small></div>
      }</td>}
      <td>{hasScore
        ? <strong className="index-value">{brier.toFixed(4)}</strong>
        : <span className="awaiting-score">{row.status === "awaiting_resolution" ? "Awaiting outcome" : "Awaiting first forecast"}</span>
      }</td>
      <td><div className="forecast-count"><b>{row.resolved}</b>{row.kind === "forecaster" && row.pending > 0 && <small>{row.pending} live</small>}</div></td>
      <td>{hasScore
        ? <div className="coverage-cell"><span><i style={{ width: `${Math.min(100, row.coverage)}%` }} /></span><b>{row.coverage.toFixed(0)}%</b></div>
        : <span className="muted-number">—</span>
      }</td>
    </tr>
  );
}

function CurationView({ snapshot }: { snapshot: Snapshot }) {
  const curation = snapshot.curation;
  const selected = curation.latestSelection?.selectedCount || 0;
  return (
    <div className="page-content enter">
      <section className="page-heading">
        <div>
          <h1>Dual-market curation</h1>
          <p>Hourly Polymarket + Kalshi sync and one diverse 20-question daily release.</p>
        </div>
        <div className="updated-stamp"><span /><div><small>Latest sync</small><b>{curation.latestSync?.completedAt ? formatTime(curation.latestSync.completedAt) : "Waiting"}</b></div></div>
      </section>

      <section className="metric-strip">
        <Metric label="Scanned markets" value={curation.latestSync?.fetchedMarkets || 0} detail={`${curation.latestSync?.fetchedEvents || 0} source events`} />
        <Metric label="Eligible now" value={curation.latestSync?.eligibleMarkets || 0} detail="passed all hard filters" />
        <Metric label="Latest release" value={selected} detail={curation.latestSelection ? `${curation.latestSelection.sourceCounts.polymarket || 0} Polymarket · ${curation.latestSelection.sourceCounts.kalshi || 0} Kalshi` : "next daily run"} />
        <Metric label="Automation" value={curation.latestSync?.status === "completed" ? "LIVE" : "READY"} detail="hourly sync · daily release" highlight />
      </section>

      <section className="curation-rules">
        <div><small>SOURCE QUOTA</small><b>{curation.config.sourceQuotas.polymarket} + {curation.config.sourceQuotas.kalshi}</b><span>Polymarket + Kalshi, never substituted</span></div>
        <div><small>POLYMARKET ACTIVITY</small><b>{formatCompactMoney(curation.config.minimumVolume24h)} / 24h</b><span>{formatCompactMoney(curation.config.minimumTotalVolume)} total · {formatCompactMoney(curation.config.minimumLiquidity)} liquidity</span></div>
        <div><small>KALSHI ACTIVITY</small><b>{formatCompactMoney(curation.config.kalshiMinimumVolume24h)} / 24h</b><span>{formatCompactMoney(curation.config.kalshiMinimumTotalVolume)} total · open-interest depth ranking</span></div>
        <div><small>DIVERSITY</small><b>5 domains · {curation.config.recentDiversityDays}d</b><span>Event-family and semantic duplicate blocking</span></div>
      </section>

      <section className="balance-board">
        <div className="section-title"><div><span className="eyebrow">DOMAIN TARGETS</span><h2>Prophet Arena five-domain balance</h2></div><span>{curation.config.targetPerCategory} per domain required / release</span></div>
        <div className="balance-grid">
          {curation.categories.map((item) => (
            <article key={item.category}>
              <header><b>{item.category}</b><span>{item.selectedThisRun}/{item.target}</span></header>
              <i><em style={{ width: `${Math.min(100, (item.selectedThisRun / item.target) * 100)}%` }} /></i>
              <footer><span>{item.eligible} eligible</span><span>{item.selectedLast7d} selected / 7d</span></footer>
            </article>
          ))}
        </div>
      </section>

      <section className="curation-release">
        <div className="section-title"><div><span className="eyebrow">IMMUTABLE RELEASE</span><h2>{curation.latestSelection?.id || "Awaiting first release"}</h2></div><span>{selected} selected</span></div>
        {curation.selectedMarkets.length ? (
          <div className="curation-table-wrap">
            <table className="curation-table">
              <thead><tr><th>Source</th><th>Category</th><th>Market</th><th>Score</th><th>YES at selection</th><th>24h volume</th><th>Depth</th><th>Closes</th></tr></thead>
              <tbody>{curation.selectedMarkets.map((market) => (
                <tr key={market.marketId}>
                  <td><span className="category-label">{sourceLabel(market.sourcePlatform)}</span></td>
                  <td><span className="category-label">{market.category}</span></td>
                  <td><a href={market.sourceUrl} target="_blank" rel="noreferrer">{market.title}<small>View source ↗</small></a></td>
                  <td className="mono-number">{market.score.toFixed(3)}</td>
                  <td className="mono-number">{(market.yesPrice * 100).toFixed(1)}%</td>
                  <td className="mono-number">{formatCompactMoney(market.volume24h)}</td>
                  <td className="mono-number">{formatCompactMoney(market.liquidity)}</td>
                  <td className="muted-number">{market.closeTime ? formatDate(market.closeTime) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="empty-block">The first scheduled sync creates the candidate pool; an immutable release is published daily at 00:10 UTC.</div>}
      </section>
    </div>
  );
}

function EventsView({
  snapshot,
  openEvents,
  resolvedEvents,
  onDetail,
}: {
  snapshot: Snapshot;
  openEvents: ArenaEvent[];
  resolvedEvents: ArenaEvent[];
  onDetail: (event: ArenaEvent) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [eventScope, setEventScope] = useState<"live" | "resolved">("live");
  const [marketSource, setMarketSource] = useState<"all" | "polymarket" | "kalshi">("all");
  const [sort, setSort] = useState<"latest" | "closing">("latest");
  const sourceEvents = eventScope === "live" ? openEvents : resolvedEvents;
  const sourceCounts = {
    polymarket: sourceEvents.filter((event) => eventMarketSource(event) === "polymarket").length,
    kalshi: sourceEvents.filter((event) => eventMarketSource(event) === "kalshi").length,
  };
  const visibleEvents = sourceEvents
    .filter((event) => marketSource === "all" || eventMarketSource(event) === marketSource)
    .filter((event) => category === "All" || event.category === category)
    .filter((event) => `${event.title} ${event.description} ${event.sourceEventId || ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === "closing") {
        return (a.closeTime ? new Date(a.closeTime).getTime() : Number.MAX_SAFE_INTEGER) - (b.closeTime ? new Date(b.closeTime).getTime() : Number.MAX_SAFE_INTEGER);
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  const categories = ["All", ...PROPHET_CATEGORIES.filter((item) => snapshot.categories.includes(item))];

  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading">
        <div><span className="eyebrow">POLYMARKET + KALSHI · LIVE FORECAST BENCHMARK</span><h1>Events</h1><p>Currently tracking {sourceCounts.polymarket} Polymarket and {sourceCounts.kalshi} Kalshi {eventScope === "live" ? "live" : "resolved"} events, with source identity preserved on every forecast.</p></div>
      </section>
      <section className="event-source-band" aria-label="Filter events by prediction market">
        <button className={marketSource === "all" ? "active source-all" : "source-all"} aria-pressed={marketSource === "all"} onClick={() => setMarketSource("all")}>
          <span>ALL MARKETS</span><strong>{sourceEvents.length}</strong><small>{sourceCounts.polymarket} Poly · {sourceCounts.kalshi} Kalshi</small>
        </button>
        <button className={marketSource === "polymarket" ? "active source-polymarket" : "source-polymarket"} aria-pressed={marketSource === "polymarket"} onClick={() => setMarketSource("polymarket")}>
          <span><i />POLYMARKET</span><strong>{sourceCounts.polymarket}</strong><small>{eventScope === "live" ? "Open and locked questions" : "Resolved questions"}</small>
        </button>
        <button className={marketSource === "kalshi" ? "active source-kalshi" : "source-kalshi"} aria-pressed={marketSource === "kalshi"} onClick={() => setMarketSource("kalshi")}>
          <span><i />KALSHI</span><strong>{sourceCounts.kalshi}</strong><small>{eventScope === "live" ? "Open and locked questions" : "Resolved questions"}</small>
        </button>
      </section>
      <section className="event-discovery" aria-label="Find benchmark events">
        <label className="event-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events by title, category, or source ticker…" /></label>
        <div className="event-filter-row">
          <div className="event-topics" aria-label="Filter by category">
            <small>TOPIC</small>
            {categories.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}
          </div>
          <div className="event-view-controls">
            <div className="event-scope"><button className={eventScope === "live" ? "active" : ""} onClick={() => setEventScope("live")}>Live</button><button className={eventScope === "resolved" ? "active" : ""} onClick={() => setEventScope("resolved")}>Resolved</button></div>
            <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as "latest" | "closing")}><option value="latest">Latest updated</option><option value="closing">Closing soon</option></select></label>
          </div>
        </div>
      </section>

      <section className="prophet-event-board">
        <div className="section-title"><div><span className="eyebrow">{eventScope === "live" ? "LIVE" : "HISTORY"}</span><h2>{eventScope === "live" ? "Active event slate" : "Resolved events"}</h2></div><span>{visibleEvents.length} of {sourceEvents.length}</span></div>
        {visibleEvents.length ? <div className="prophet-event-grid">{visibleEvents.map((event) => (
          <ProphetEventBlock
            key={event.id}
            event={event}
            runs={snapshot.forecastPipeline.runs.filter((run) => run.eventId === event.id)}
            onDetail={() => onDetail(event)}
          />
        ))}</div> : <div className="empty-block">No events match the current search and filters.</div>}
      </section>
    </div>
  );
}

function ProphetEventBlock({
  event,
  runs,
  onDetail,
}: {
  event: ArenaEvent;
  runs: ForecastPipelineSnapshot["runs"];
  onDetail: () => void;
}) {
  const outcomes = eventBlockOutcomes(event).slice(0, 2);
  const marketSource = eventMarketSource(event);
  const sourceCount = Math.max(0, ...runs.map((run) => run.sourceCount));
  const completedModels = new Set(runs.filter((run) => run.status === "completed").map((run) => run.participantId)).size;
  const resolvedLabel = event.resolvedOutcome ? event.outcomes.find((outcome) => outcome.key === event.resolvedOutcome)?.label || event.resolvedOutcome : null;
  return <article className={`prophet-event-block ${event.status}`}>
    <header>
      <div className="event-symbol" aria-hidden="true">{initials(event.category)}</div>
      <button className="event-block-title" onClick={onDetail}>
        <span className="event-block-meta"><i className={`event-market-badge ${marketSource}`}>{sourceLabel(marketSource)}</i><em>{event.category}{event.eventType === "categorical" ? " · MULTI-OUTCOME" : " · BINARY"}</em></span>
        <h3>{event.title}</h3>
      </button>
      <button className="event-open-arrow" onClick={onDetail} aria-label={`Open ${event.title}`}>↗</button>
    </header>

    {event.status === "resolved" && resolvedLabel ? <div className="event-result"><small>RESULT</small><strong>{resolvedLabel}</strong></div> : <section className="event-consensus">
      <div className="event-consensus-label"><b>AI consensus vs. market</b><span>{completedModels || event.forecasterCount} model{(completedModels || event.forecasterCount) === 1 ? "" : "s"}</span></div>
      <div className="event-outcomes">
        {outcomes.map((outcome, index) => <div className="event-outcome" key={outcome.key}>
          <div className="event-outcome-head"><b>{outcome.label}</b><span><strong>{formatProbability(outcome.consensus)}</strong>{outcome.market === null ? "" : ` mkt ${formatProbability(outcome.market)}`}</span></div>
          <div className="event-probability-track"><i className={`${index ? "gold" : "purple"}${outcome.consensus === null ? " pending" : ""}`} style={{ width: `${outcome.consensus === null ? 0 : Math.max(2, outcome.consensus * 100)}%` }} />{outcome.market !== null && <em style={{ left: `${Math.min(100, Math.max(0, outcome.market * 100))}%` }} />}</div>
          <div className="event-model-calls">{outcome.models.length ? outcome.models.map((model) => <span key={`${outcome.key}-${model.name}`}><b>{model.name}</b><strong>{formatProbability(model.probability)}</strong></span>) : <span><b>Awaiting model forecast</b><strong>—</strong></span>}</div>
        </div>)}
      </div>
    </section>}

    <footer>
      <div className="event-evidence"><span>{sourceCount ? `${sourceCount} frozen sources` : "Context pending"}</span><small>{event.sourceEventId ? event.sourceEventId.startsWith("kalshi:") ? `Kalshi Market ${event.sourceEventId.slice(7)}` : `Polymarket Event ${event.sourceEventId}` : event.season}</small></div>
      <div className="event-timing">
        <span className={event.status === "open" ? "live" : event.status === "locked" ? "locked" : "resolved"}>
          {event.status === "open" ? "LIVE" : event.status === "locked" ? "LOCKED" : "RESOLVED"}
        </span>
        <time>{event.status === "resolved"
          ? event.resolvedAt ? `Resolved ${formatDate(event.resolvedAt)}` : "Resolved"
          : event.status === "locked"
            ? event.lockedAt ? `Locked ${formatDate(event.lockedAt)}` : "Awaiting resolution"
            : event.closeTime ? formatCloseTime(event.closeTime) : "No deadline"}</time>
      </div>
    </footer>
  </article>;
}

function eventBlockOutcomes(event: ArenaEvent) {
  const forecasters = event.predictions.filter((prediction) => prediction.kind === "forecaster");
  const yesMarket = event.outcomes.find((outcome) => outcome.key === "yes")?.priceAtSelection;
  return event.outcomes.map((outcome) => {
    const models = forecasters.map((prediction) => {
      const probability = prediction.probabilities?.[outcome.key]
        ?? (outcome.key === "yes" ? prediction.probability : outcome.key === "no" ? 1 - prediction.probability : undefined);
      return probability === undefined ? null : { name: prediction.name, probability };
    }).filter((model): model is { name: string; probability: number } => model !== null).sort((a, b) => b.probability - a.probability);
    const aggregate = event.predictions.find((prediction) => prediction.kind === "aggregate" && /equal|mean/i.test(prediction.name));
    const aggregateProbability = aggregate?.probabilities?.[outcome.key]
      ?? (aggregate ? outcome.key === "yes" ? aggregate.probability : outcome.key === "no" ? 1 - aggregate.probability : undefined : undefined);
    const consensus = aggregateProbability ?? (models.length ? models.reduce((sum, model) => sum + model.probability, 0) / models.length : null);
    const market = outcome.priceAtSelection ?? (outcome.key === "no" && yesMarket !== undefined ? 1 - yesMarket : null);
    return { ...outcome, consensus, market, models: models.slice(0, 2) };
  }).sort((a, b) => (b.consensus ?? b.market ?? 0) - (a.consensus ?? a.market ?? 0));
}

function ForecastsView({
  snapshot,
  busy,
  onRun,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onRun: () => void;
}) {
  const pipeline = snapshot.forecastPipeline;
  const ready = pipeline.configured.modelGateway && pipeline.configured.searchSecret;
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading">
        <div>
          <h1>LLM forecast pipeline</h1>
          <p>Each question uses one frozen research context.</p>
        </div>
        <button className="primary-button" disabled={busy || !ready || !pipeline.stats.pending} onClick={onRun}>
          {busy ? "Running…" : "Run next forecast"}
        </button>
      </section>

      {!ready && (
        <section className="pipeline-alert">
          <b>Pipeline configuration required</b>
          <span>
            {!pipeline.configured.searchSecret
              ? "Set TAVILY_API_KEY for the frozen research context."
              : pipeline.configured.modelGatewayProblem}
          </span>
          <code>
            npx wrangler secret put TAVILY_API_KEY<br />
            Configure the Cloudflare AI binding and exact model map in wrangler.jsonc
          </code>
        </section>
      )}

      <section className="metric-strip">
        <Metric label="Frozen contexts" value={pipeline.stats.contextsReady} detail="one search per event" />
        <Metric label="Completed" value={pipeline.stats.completed} detail={`${pipeline.models.length} model families`} />
        <Metric label="Pending" value={pipeline.stats.pending} detail="model-event runs" />
        <Metric label="Pipeline" value={ready ? "READY" : "SETUP"} detail="up to 20 model-event runs / day" highlight />
      </section>

      <section className="pipeline-flow" aria-label="Forecast pipeline">
        <div><span>01</span><b>Selected event</b><small>10 Polymarket + 10 Kalshi</small></div>
        <i>→</i>
        <div><span>02</span><b>Tavily Search</b><small>up to 10 ranked sources</small></div>
        <i>→</i>
        <div><span>03</span><b>Frozen context</b><small>same evidence for every model</small></div>
        <i>→</i>
        <div className="model-step"><span>04</span><b>{pipeline.models.length} independent models</b><small>{pipeline.models.map((model) => model.participantName).join(" · ")}</small></div>
        <i>→</i>
        <div><span>05</span><b>Agent Harnesses</b><small>blind + evidence-aware · Cloudflare AI Gateway</small></div>
        <i>→</i>
        <div><span>06</span><b>Arena score</b><small>prediction history + Brier</small></div>
      </section>

      <section className="forecast-runs">
        <div className="section-title">
          <div><h2>Recent model forecasts</h2></div>
          <span>{pipeline.models.length} models · {pipeline.model.promptVersion}</span>
        </div>
        {pipeline.runs.length ? pipeline.runs.map((run) => (
          <article key={run.id} className={`forecast-run ${run.status}`}>
            <div className="run-status"><i /><span>{run.status}</span></div>
            <div className="run-question">
              <span>{pipeline.models.find((model) => model.participantId === run.participantId)?.participantName || run.modelId} · {run.category} · {run.sourceCount} shared sources</span>
              <h3>{run.title}</h3>
              {run.rationale && <p>{run.rationale}</p>}
              {run.error && <p className="run-error">{run.error}</p>}
              {run.sources.length > 0 && (
                <section className="source-section" aria-label={`Information sources for ${run.title}`}>
                  <header>
                    <b>Information sources</b>
                    <span>{run.sources.length} frozen · {run.provider}</span>
                  </header>
                <div className="source-list">
                  {run.sources.map((source) => (
                    <a key={`${run.contextId}-${source.rank}`} href={source.url} target="_blank" rel="noreferrer">
                      <span>{String(source.rank).padStart(2, "0")}</span>
                      <div>
                        <b>{source.title}</b>
                        <small>
                          {sourceHost(source.url)}
                          {source.publishedDate ? ` · ${formatSourceDate(source.publishedDate)}` : ""}
                          {run.citedSourceRanks.includes(source.rank) ? " · cited by model" : ""}
                        </small>
                        <p>{source.content}</p>
                      </div>
                    </a>
                  ))}
                </div>
                </section>
              )}
            </div>
            <div className="run-output">
              <small>OUTCOME DISTRIBUTION</small>
              {Object.keys(run.probabilities).length
                ? Object.entries(run.probabilities).map(([key, probability]) => (
                    <strong key={key}>{key}: {(probability * 100).toFixed(1)}%</strong>
                  ))
                : <strong>{run.yesProbability === null ? "—" : `Yes: ${(run.yesProbability * 100).toFixed(1)}%`}</strong>}
              <span>{run.completedAt ? formatDateTime(run.completedAt) : "in progress"}</span>
              <code>{run.latencyMs === null ? "" : `${(run.latencyMs / 1000).toFixed(1)}s`}</code>
            </div>
          </article>
        )) : (
          <div className="empty-block">After Tavily and the model gateway are configured, the scheduled job creates shared research contexts and Prophet-panel forecasts.</div>
        )}
      </section>
    </div>
  );
}

function MethodsView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading"><div><h1>Aggregation methods</h1><p>All methods receive the same forecast panel.</p></div></section>
      <section className="method-list">
        {snapshot.methods.map((method, index) => (
          <article key={method.id}>
            <span className="method-number">{String(index + 1).padStart(2, "0")}</span>
            <i style={{ background: method.color }} />
            <div><h2>{method.name}</h2><p>{method.description}</p></div>
            <code>{method.id}</code>
          </article>
        ))}
      </section>
      <section className="methodology-band">
        <div><span>01</span><h3>Same inputs</h3><p>Every method receives exactly the same probability panel.</p></div>
        <div><span>02</span><h3>Immutable snapshot</h3><p>Every revision enters history; resolved events are locked.</p></div>
        <div><span>03</span><h3>Outcome scoring</h3><p>{snapshot.methodology.primaryMetric}, reported directly at the event level; lower is better.</p></div>
        <div><span>04</span><h3>Live ranking</h3><p>Resolution immediately refreshes ranks and confidence intervals.</p></div>
      </section>
      <section className="formula-panel">
        <div><span className="eyebrow">PRIMARY SCORE</span><h2>Prophet Event Brier</h2></div>
        <p>Squared error is averaged over all M mutually exclusive outcomes, then averaged across events. Here M is the number of outcomes—not the number of selected forecasting models. Lower is better.</p>
      </section>
    </div>
  );
}

function ActivityView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading"><div><h1>Audit log</h1><p>Question, forecast, and resolution changes with timestamps and actors.</p></div></section>
      <section className="activity-list">
        {snapshot.activity.map((item) => (
          <article key={item.id}>
            <span className="activity-mark" />
            <div><b>{ACTION_LABELS[item.action] || item.action}</b><p>{item.entityType} / {item.entityId}</p></div>
            <code>{item.actor}</code>
            <time>{formatDateTime(item.createdAt)}</time>
          </article>
        ))}
      </section>
    </div>
  );
}

function Metric({ label, value, detail, highlight = false }: { label: string; value: string | number; detail: string; highlight?: boolean }) {
  return <div className={highlight ? "metric highlight" : "metric"}><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function DialogShell({ title, kicker, onClose, children }: { title: string; kicker: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog-panel">
        <header><div><span className="eyebrow">{kicker}</span><h2>{title}</h2></div><button onClick={onClose} aria-label="Close">×</button></header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

function CreateEventForm({ snapshot, busy, onSubmit }: { snapshot: Snapshot | null; busy: boolean; onSubmit: (payload: Record<string, string | null>) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>(PROPHET_CATEGORIES[0]);
  const [season, setSeason] = useState(snapshot?.seasons[0] || "Season 1");
  const [closeTime, setCloseTime] = useState("");
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit({ title, description, category, season, closeTime: closeTime || null }); };
  return <form className="arena-form" onSubmit={submit}>
    <label className="wide">Question title<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Will … occur before …?" /></label>
    <label className="wide">Description / resolution context<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional context and precise resolution rule" /></label>
    <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{PROPHET_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label>Season<input value={season} onChange={(event) => setSeason(event.target.value)} /></label>
    <label className="wide">Forecast deadline<input type="datetime-local" value={closeTime} onChange={(event) => setCloseTime(event.target.value)} /></label>
    <div className="form-note wide"><b>Binary question</b><span>Manual events use Yes / No and enter the live Brier standings after resolution.</span></div>
    <button className="primary-button wide" disabled={busy}>{busy ? "Creating…" : "Create event"}</button>
  </form>;
}

function CreateParticipantForm({ busy, onSubmit }: { busy: boolean; onSubmit: (payload: Record<string, string>) => void }) {
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [color, setColor] = useState("#7c4dff");
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit({ name, organization, color }); };
  return <form className="arena-form" onSubmit={submit}>
    <label className="wide">Display name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Model E or Human Panel" /></label>
    <label>Organization<input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="Independent" /></label>
    <label>Color<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
    <div className="form-note wide"><b>Stable identity</b><span>A matching forecaster updates display metadata without deleting forecast history.</span></div>
    <button className="primary-button wide" disabled={busy}>{busy ? "Saving…" : "Save forecaster"}</button>
  </form>;
}

function ForecastForm({ event, participants, busy, onSubmit }: { event: ArenaEvent; participants: Participant[]; busy: boolean; onSubmit: (rows: { participantId: string; probability: number }[]) => void }) {
  const existing = new Map(event.predictions.filter((row) => row.kind === "forecaster").map((row) => [row.id, row.probability]));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(participants.map((item) => [item.id, existing.has(item.id) ? String(existing.get(item.id)) : ""])));
  const submit = (formEvent: FormEvent) => {
    formEvent.preventDefault();
    const rows = participants.filter((item) => values[item.id] !== "").map((item) => ({ participantId: item.id, probability: Number(values[item.id]) }));
    onSubmit(rows);
  };
  return <form className="forecast-form" onSubmit={submit}>
    <div className="event-context"><span>{event.category} / {event.season}</span><h3>{event.title}</h3><p>Enter decimals from 0 to 1. Resubmitting updates the current version while retaining immutable history.</p></div>
    <div className="probability-grid">
      {participants.map((participant) => {
        const numeric = Number(values[participant.id]);
        return <label key={participant.id}><i style={{ background: participant.color }} /><div><b>{participant.name}</b><small>{participant.organization}</small></div><input inputMode="decimal" min="0" max="1" step="0.01" value={values[participant.id]} onChange={(inputEvent) => setValues((current) => ({ ...current, [participant.id]: inputEvent.target.value }))} placeholder="0.50" /><span>{Number.isFinite(numeric) && values[participant.id] !== "" ? `${Math.round(numeric * 100)}%` : "—"}</span></label>;
      })}
    </div>
    <div className="form-note"><b>Automatic recompute</b><span>Equal Mean, Median, Trimmed, Logit, Extremized, and Performance Weighted update together.</span></div>
    <button className="primary-button" disabled={busy}>{busy ? "Computing…" : "Submit probabilities & recompute"}</button>
  </form>;
}

function ResolveForm({ event, busy, onSubmit }: { event: ArenaEvent; busy: boolean; onSubmit: (resolvedOutcome: string, note: string) => void }) {
  const [resolvedOutcome, setResolvedOutcome] = useState<string | null>(null);
  const [note, setNote] = useState("");
  return <form className="resolve-form" onSubmit={(formEvent) => { formEvent.preventDefault(); if (resolvedOutcome !== null) onSubmit(resolvedOutcome, note); }}>
    <div className="event-context"><span>{event.forecasterCount} locked forecasts</span><h3>{event.title}</h3><p>Resolution records the final outcome for an already frozen forecast set, then updates the leaderboard immediately.</p></div>
    <div className="outcome-picker">{event.outcomes.map((outcome) => (
      <button type="button" key={outcome.key} className={resolvedOutcome === outcome.key ? "selected yes" : ""} onClick={() => setResolvedOutcome(outcome.key)}>
        <b>{outcome.label}</b><span>{outcome.key}</span>
      </button>
    ))}</div>
    <label>Resolution note<textarea value={note} onChange={(inputEvent) => setNote(inputEvent.target.value)} placeholder="Outcome source or verification note" /></label>
    <button className="primary-button" disabled={busy || resolvedOutcome === null}>{busy ? "Resolving…" : "Resolve & update leaderboard"}</button>
  </form>;
}

function EventDetail({ event }: { event: ArenaEvent }) {
  const sorted = [...event.predictions].sort((a, b) => a.kind.localeCompare(b.kind) || b.probability - a.probability);
  return <div className="event-detail">
    <div className="event-context"><span>{event.category} / {event.season}</span><h3>{event.title}</h3><p>{event.description || "No additional description."}</p></div>
    <div className="event-meta"><div><small>Status</small><b>{event.status}</b></div><div><small>Forecasters</small><b>{event.forecasterCount}</b></div><div><small>Deadline</small><b>{event.closeTime ? formatDate(event.closeTime) : "Open"}</b></div><div><small>Outcome</small><b>{event.resolvedOutcome ? event.outcomes.find((outcome) => outcome.key === event.resolvedOutcome)?.label || event.resolvedOutcome : "—"}</b></div></div>
    <div className="prediction-panel">
      {sorted.flatMap((prediction) => {
        const values = prediction.probabilities && Object.keys(prediction.probabilities).length
          ? Object.entries(prediction.probabilities)
          : [["yes", prediction.probability] as [string, number]];
        return values.map(([key, probability], index) => <div key={`${prediction.id}-${key}`}><span className={prediction.kind === "aggregate" ? "aggregate-tag" : "forecaster-tag"}>{index ? key : prediction.kind}</span><b>{index ? event.outcomes.find((outcome) => outcome.key === key)?.label || key : prediction.name}</b><i><em style={{ width: `${probability * 100}%` }} /></i><strong>{(probability * 100).toFixed(1)}%</strong></div>);
      })}
    </div>
  </div>;
}

function LoadingState() {
  return <div className="loading-state"><span /><h2>Loading data</h2></div>;
}

function dialogTitle(dialog: NonNullable<Dialog>) {
  if (dialog.type === "create-event") return "Create benchmark event";
  if (dialog.type === "create-participant") return "Add forecaster";
  if (dialog.type === "forecasts") return "Input probability panel";
  if (dialog.type === "resolve") return "Resolve event";
  return "Event detail";
}

function dialogKicker(dialog: NonNullable<Dialog>) {
  if (dialog.type === "create-event") return "NEW QUESTION";
  if (dialog.type === "create-participant") return "PARTICIPANT REGISTRY";
  if (dialog.type === "forecasts") return "MANUAL INPUT";
  if (dialog.type === "resolve") return "OUTCOME LOCK";
  return "FORECAST SNAPSHOT";
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const body = await response.text();
  if (!contentType.includes("application/json")) {
    const status = response.status ? `HTTP ${response.status}` : "unknown status";
    throw new Error(`The server returned a web page instead of API data (${status}). Please wait a moment and try again.`);
  }
  if (!body.trim()) {
    throw new Error(`The server returned an empty API response (HTTP ${response.status}). Please try again.`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`The server returned malformed API data (HTTP ${response.status}). Please refresh and try again.`);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The data request took too long. Please retry; the page will also try again automatically.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  if (error instanceof TypeError && /fetch|network|load/i.test(error.message)) {
    return "The server is temporarily unreachable. Your existing data is safe; please try again in a moment.";
  }
  return error.message || fallback;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatProbability(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatCloseTime(value: string) {
  const close = new Date(value);
  const remaining = close.getTime() - Date.now();
  if (remaining <= 0) return `Closed ${formatDate(value)}`;
  const hours = Math.floor(remaining / 3_600_000);
  if (hours < 48) return `Closes in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `Closes in ${days}d ${hours % 24}h`;
  return `Closes ${formatDate(value)}`;
}

function formatSourceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function sourceHost(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function sourceLabel(value: string) {
  return value === "kalshi" ? "Kalshi" : "Polymarket";
}

function eventMarketSource(event: ArenaEvent): "polymarket" | "kalshi" {
  return event.sourceEventId?.startsWith("kalshi:") || event.id.includes("-kalshi-") ? "kalshi" : "polymarket";
}

function formatCompactMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function initials(value: string) {
  return value.split(/\s+/).map((item) => item[0]).join("").slice(0, 2).toUpperCase();
}

function exportLeaderboard(snapshot: Snapshot | null) {
  if (!snapshot?.leaderboard.length) return;
  const rows = [
    ["rank", "name", "method_id", "type", "aggregation_scope", "model_1", "model_2", "status", "event_brier", "ci_low", "ci_high", "resolved_events", "live_forecasts", "total_forecasted_events", "coverage_pct"],
    ...snapshot.leaderboard.map((row) => [
      row.rank ?? "",
      row.name,
      row.methodId ?? "",
      row.kind,
      row.aggregationScope ?? "",
      row.modelPair?.[0]?.name ?? "",
      row.modelPair?.[1]?.name ?? "",
      row.status,
      row.brier?.toFixed(6) ?? "",
      row.ciLow?.toFixed(6) ?? "",
      row.ciHigh?.toFixed(6) ?? "",
      row.resolved,
      row.pending,
      row.forecasted,
      row.brier === null ? "" : row.coverage.toFixed(2),
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `aggrena-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
