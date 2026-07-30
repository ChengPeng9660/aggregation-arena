"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Prediction = {
  id: string;
  name: string;
  kind: "forecaster" | "aggregate";
  probability: number;
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
  status: "open" | "resolved" | "invalid";
  resolution: number | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
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
  rank: number;
  name: string;
  shortName: string;
  organization: string;
  kind: "forecaster" | "aggregate";
  color: string;
  brier: number;
  brierIndex: number;
  ciLow: number;
  ciHigh: number;
  resolved: number;
  coverage: number;
  status: "listed" | "provisional";
  version: string;
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
    targetPerCategory: number;
    minimumTotalVolume: number;
    minimumVolume24h: number;
    minimumLiquidity: number;
    minimumCloseHours: number;
    maximumCloseDays: number;
    minimumCategoryPercentile: number;
  };
  latestSync: null | {
    status: string;
    fetchedEvents: number;
    fetchedMarkets: number;
    eligibleMarkets: number;
    startedAt: string;
    completedAt: string | null;
  };
  latestSelection: null | {
    id: string;
    status: string;
    candidateCount: number;
    eligibleCount: number;
    selectedCount: number;
    categoryCounts: Record<string, number>;
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

type ForecastPipelineSnapshot = {
  model: {
    participantId: string;
    participantName: string;
    organization: string;
    modelId: string;
    promptVersion: string;
    color: string;
  };
  configured: { aiBinding: boolean; searchSecret: boolean };
  stats: { contextsReady: number; completed: number; failed: number; pending: number };
  runs: {
    id: string;
    eventId: string;
    title: string;
    category: string;
    contextId: string;
    modelId: string;
    status: "running" | "completed" | "failed";
    yesProbability: number | null;
    noProbability: number | null;
    rationale: string | null;
    citedSourceRanks: number[];
    sources: ForecastSource[];
    sourceCount: number;
    provider: string;
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
    leaderIndex: number | null;
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

type View = "leaderboard" | "curation" | "forecasts" | "events" | "methods" | "activity";
type Dialog =
  | { type: "create-event" }
  | { type: "create-participant" }
  | { type: "forecasts"; event: ArenaEvent }
  | { type: "resolve"; event: ArenaEvent }
  | { type: "event"; event: ArenaEvent }
  | null;

const ACTION_LABELS: Record<string, string> = {
  "benchmark.seeded": "初始化演示赛季",
  "event.created": "创建题目",
  "event.resolved": "结算题目",
  "event.reopened": "重新开放题目",
  "event.invalidated": "作废题目",
  "forecast.batch_submitted": "提交一批预测",
  "forecast.automated_completed": "自动模型预测完成",
  "forecast.pipeline_failed": "自动预测流水线失败",
  "participant.upserted": "更新 forecaster",
  "curation.event_selected": "Polymarket 题目入选",
  "curation.event_resolved": "Polymarket 自动结算",
};

export function ArenaClient({ userName }: { userName: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("leaderboard");
  const [track, setTrack] = useState("aggregators");
  const [windowRange, setWindowRange] = useState("all");
  const [season, setSeason] = useState("all");
  const [category, setCategory] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    const params = new URLSearchParams({ track, window: windowRange, season, category });
    try {
      const response = await fetch(`/api/arena?${params}`, { cache: "no-store" });
      const payload = (await response.json()) as Snapshot & { message?: string };
      if (!response.ok) throw new Error(payload.message || "Benchmark 数据加载失败");
      setSnapshot(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Benchmark 数据加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [track, windowRange, season, category]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => load(true), 30000);
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
      const result = (await response.json()) as { ok: boolean; message?: string };
      if (!response.ok) throw new Error(result.message || "操作失败");
      setDialog(null);
      setToast(successMessage);
      window.setTimeout(() => setToast(""), 2600);
      await load(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "操作失败");
    } finally {
      setMutating(false);
    }
  };

  const openEvents = useMemo(
    () => snapshot?.events.filter((event) => event.status === "open") ?? [],
    [snapshot],
  );
  const resolvedEvents = useMemo(
    () => snapshot?.events.filter((event) => event.status === "resolved") ?? [],
    [snapshot],
  );

  return (
    <div className="arena-app">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-orbit" aria-hidden="true"><i /></span>
          <div>
            <strong>Aggregation Arena</strong>
            <small>Forecast benchmark</small>
          </div>
        </div>
        <nav aria-label="Benchmark navigation">
          <NavButton active={view === "leaderboard"} label="Leaderboard" meta="实时榜单" icon="01" onClick={() => setView("leaderboard")} />
          <NavButton active={view === "curation"} label="Curation" meta="动态选题" icon="02" onClick={() => setView("curation")} />
          <NavButton active={view === "forecasts"} label="Forecasts" meta="模型流水线" icon="03" onClick={() => setView("forecasts")} />
          <NavButton active={view === "events"} label="Events" meta="题目与录入" icon="04" onClick={() => setView("events")} />
          <NavButton active={view === "methods"} label="Methods" meta="聚合方法" icon="05" onClick={() => setView("methods")} />
          <NavButton active={view === "activity"} label="Audit log" meta="审计记录" icon="06" onClick={() => setView("activity")} />
        </nav>
        <div className="sidebar-status">
          <span className="status-dot" />
          <div><b>Benchmark online</b><small>每 30 秒刷新</small></div>
        </div>
        <div className="sidebar-user">
          <span>{initials(userName)}</span>
          <div><b>{userName}</b><small>Benchmark admin</small></div>
        </div>
      </aside>

      <main className="main-surface">
        <header className="topbar">
          <div>
            <span className="mobile-brand">Aggregation Arena</span>
            <p>{viewLabel(view)}</p>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" onClick={() => exportLeaderboard(snapshot)} disabled={!snapshot?.leaderboard.length}>
              Export CSV
            </button>
            <button className="primary-button" onClick={() => setDialog({ type: "create-event" })}>
              + New event
            </button>
          </div>
        </header>

        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}
        {loading && !snapshot ? <LoadingState /> : snapshot ? (
          <>
            {view === "leaderboard" && (
              <LeaderboardView
                snapshot={snapshot}
                track={track}
                windowRange={windowRange}
                season={season}
                category={category}
                onTrack={setTrack}
                onWindow={setWindowRange}
                onSeason={setSeason}
                onCategory={setCategory}
                onOpenEvent={(event) => setDialog({ type: "event", event })}
              />
            )}
            {view === "events" && (
              <EventsView
                openEvents={openEvents}
                resolvedEvents={resolvedEvents}
                onCreateParticipant={() => setDialog({ type: "create-participant" })}
                onForecasts={(event) => setDialog({ type: "forecasts", event })}
                onResolve={(event) => setDialog({ type: "resolve", event })}
                onDetail={(event) => setDialog({ type: "event", event })}
              />
            )}
            {view === "curation" && <CurationView snapshot={snapshot} />}
            {view === "forecasts" && (
              <ForecastsView
                snapshot={snapshot}
                busy={mutating}
                onRun={() => post({ action: "run_forecast_batch" }, "已运行一个预测任务")}
              />
            )}
            {view === "methods" && <MethodsView snapshot={snapshot} />}
            {view === "activity" && <ActivityView snapshot={snapshot} />}
          </>
        ) : null}
      </main>

      {dialog && (
        <DialogShell title={dialogTitle(dialog)} kicker={dialogKicker(dialog)} onClose={() => setDialog(null)}>
          {dialog.type === "create-event" && <CreateEventForm snapshot={snapshot} busy={mutating} onSubmit={(payload) => post({ action: "create_event", ...payload }, "题目已创建")} />}
          {dialog.type === "create-participant" && <CreateParticipantForm busy={mutating} onSubmit={(payload) => post({ action: "create_participant", ...payload }, "Forecaster 已保存")} />}
          {dialog.type === "forecasts" && snapshot && <ForecastForm event={dialog.event} participants={snapshot.participants} busy={mutating} onSubmit={(forecasts) => post({ action: "submit_forecasts", eventId: dialog.event.id, forecasts }, "概率已录入，aggregation 已重算")} />}
          {dialog.type === "resolve" && <ResolveForm event={dialog.event} busy={mutating} onSubmit={(resolution, note) => post({ action: "resolve_event", eventId: dialog.event.id, resolution, note }, "题目已结算，榜单已更新")} />}
          {dialog.type === "event" && <EventDetail event={dialog.event} onInput={() => setDialog({ type: "forecasts", event: dialog.event })} onResolve={() => setDialog({ type: "resolve", event: dialog.event })} />}
        </DialogShell>
      )}
      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}

function NavButton({ active, label, meta, icon, onClick }: { active: boolean; label: string; meta: string; icon: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span><div><b>{label}</b><small>{meta}</small></div></button>;
}

function LeaderboardView({
  snapshot,
  track,
  windowRange,
  season,
  category,
  onTrack,
  onWindow,
  onSeason,
  onCategory,
  onOpenEvent,
}: {
  snapshot: Snapshot;
  track: string;
  windowRange: string;
  season: string;
  category: string;
  onTrack: (value: string) => void;
  onWindow: (value: string) => void;
  onSeason: (value: string) => void;
  onCategory: (value: string) => void;
  onOpenEvent: (event: ArenaEvent) => void;
}) {
  return (
    <div className="page-content enter">
      <section className="page-heading">
        <div>
          <span className="eyebrow">LIVE / OUTCOME-BASED</span>
          <h1>Aggregation leaderboard</h1>
          <p>同一组手工概率进入所有 aggregation 方法；题目结算后即时按 Brier 表现重排。</p>
        </div>
        <div className="updated-stamp"><span /><div><small>Last computed</small><b>{formatTime(snapshot.generatedAt)}</b></div></div>
      </section>

      <section className="metric-strip">
        <Metric label="Open events" value={snapshot.stats.openEvents} detail="等待录入或结算" />
        <Metric label="Resolved" value={snapshot.stats.resolvedEvents} detail="进入当前排名" />
        <Metric label="Forecasters" value={snapshot.stats.activeForecasters} detail={`${snapshot.stats.totalForecasts} locked forecasts`} />
        <Metric label="Leader index" value={snapshot.stats.leaderIndex === null ? "—" : snapshot.stats.leaderIndex.toFixed(1)} detail={snapshot.stats.leaderName || "等待结算"} highlight />
      </section>

      <section className="filters">
        <div className="segmented">
          <button className={track === "aggregators" ? "active" : ""} onClick={() => onTrack("aggregators")}>Aggregators</button>
          <button className={track === "forecasters" ? "active" : ""} onClick={() => onTrack("forecasters")}>Forecasters</button>
          <button className={track === "all" ? "active" : ""} onClick={() => onTrack("all")}>All</button>
        </div>
        <div className="select-row">
          <label>Window<select value={windowRange} onChange={(event) => onWindow(event.target.value)}><option value="all">All time</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select></label>
          <label>Season<select value={season} onChange={(event) => onSeason(event.target.value)}><option value="all">All seasons</option>{snapshot.seasons.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Category<select value={category} onChange={(event) => onCategory(event.target.value)}><option value="all">All categories</option>{snapshot.categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
      </section>

      <section className="leaderboard-panel">
        <div className="table-caption">
          <div><b>Official standings</b><span>Higher Brier Index is better · minimum {snapshot.methodology.minimumResolved} resolved events</span></div>
          <span className="metric-definition">{snapshot.methodology.displayMetric}</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Rank</th><th>Method / Forecaster</th><th>Brier Index</th><th>95% CI</th><th>Raw Brier</th><th>N</th><th>Coverage</th></tr></thead>
            <tbody>
              {snapshot.leaderboard.length ? snapshot.leaderboard.map((row) => <LeaderboardRowView key={row.id} row={row} />) : (
                <tr><td colSpan={7} className="empty-cell">当前筛选下还没有已结算成绩。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="open-queue">
        <div className="section-title"><div><span className="eyebrow">NEXT TO RESOLVE</span><h2>Open benchmark queue</h2></div><span>{snapshot.stats.openEvents} open</span></div>
        <div className="event-rail">
          {snapshot.events.filter((event) => event.status === "open").slice(0, 4).map((event) => (
            <button key={event.id} onClick={() => onOpenEvent(event)}>
              <span>{event.category}</span><h3>{event.title}</h3>
              <div><b>{event.forecasterCount} forecasts</b><small>{event.closeTime ? formatDate(event.closeTime) : "No deadline"}</small></div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function LeaderboardRowView({ row }: { row: LeaderboardRow }) {
  return (
    <tr className={row.rank <= 3 ? "top-row" : ""}>
      <td><span className={`rank rank-${row.rank}`}>{String(row.rank).padStart(2, "0")}</span></td>
      <td><div className="method-cell"><i style={{ background: row.color }} /><div><b>{row.name}</b><small>{row.organization} · {row.version}</small></div>{row.status === "provisional" && <em>PROV</em>}</div></td>
      <td><strong className="index-value">{row.brierIndex.toFixed(1)}</strong></td>
      <td className="muted-number">{row.ciLow.toFixed(1)}–{row.ciHigh.toFixed(1)}</td>
      <td className="mono-number">{row.brier.toFixed(3)}</td>
      <td className="mono-number">{row.resolved}</td>
      <td><div className="coverage-cell"><span><i style={{ width: `${Math.min(100, row.coverage)}%` }} /></span><b>{row.coverage.toFixed(0)}%</b></div></td>
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
          <span className="eyebrow">POLYMARKET / AUTOMATED</span>
          <h1>Balanced market curation</h1>
          <p>每小时读取高成交量二元市场；通过固定质量门槛后，按七个类别每日均衡发布，不足时宁可留空。</p>
        </div>
        <div className="updated-stamp"><span /><div><small>Latest sync</small><b>{curation.latestSync?.completedAt ? formatTime(curation.latestSync.completedAt) : "Waiting"}</b></div></div>
      </section>

      <section className="metric-strip">
        <Metric label="Scanned markets" value={curation.latestSync?.fetchedMarkets || 0} detail={`${curation.latestSync?.fetchedEvents || 0} source events`} />
        <Metric label="Eligible now" value={curation.latestSync?.eligibleMarkets || 0} detail="passed all hard filters" />
        <Metric label="Latest release" value={selected} detail={curation.latestSelection?.id || "next daily run"} />
        <Metric label="Automation" value={curation.latestSync?.status === "completed" ? "LIVE" : "READY"} detail="hourly sync · daily release" highlight />
      </section>

      <section className="curation-rules">
        <div><small>24H VOLUME</small><b>≥ {formatCompactMoney(curation.config.minimumVolume24h)}</b><span>Within-category top 30%</span></div>
        <div><small>TOTAL VOLUME</small><b>≥ {formatCompactMoney(curation.config.minimumTotalVolume)}</b><span>Established markets only</span></div>
        <div><small>LIQUIDITY</small><b>≥ {formatCompactMoney(curation.config.minimumLiquidity)}</b><span>Executable probability signal</span></div>
        <div><small>CLOSE WINDOW</small><b>{curation.config.minimumCloseHours}h–{curation.config.maximumCloseDays}d</b><span>Enough time to forecast</span></div>
      </section>

      <section className="balance-board">
        <div className="section-title"><div><span className="eyebrow">CATEGORY QUOTAS</span><h2>Seven-category balance</h2></div><span>{curation.config.targetPerCategory} per category / release</span></div>
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
              <thead><tr><th>Category</th><th>Market</th><th>Score</th><th>YES at selection</th><th>24h volume</th><th>Liquidity</th><th>Closes</th></tr></thead>
              <tbody>{curation.selectedMarkets.map((market) => (
                <tr key={market.marketId}>
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
        ) : <div className="empty-block">部署定时任务后，首次同步会建立候选池；每日 00:10 UTC 发布固定批次。</div>}
      </section>
    </div>
  );
}

function EventsView({
  openEvents,
  resolvedEvents,
  onCreateParticipant,
  onForecasts,
  onResolve,
  onDetail,
}: {
  openEvents: ArenaEvent[];
  resolvedEvents: ArenaEvent[];
  onCreateParticipant: () => void;
  onForecasts: (event: ArenaEvent) => void;
  onResolve: (event: ArenaEvent) => void;
  onDetail: (event: ArenaEvent) => void;
}) {
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading">
        <div><span className="eyebrow">MANUAL OPERATIONS</span><h1>Events & data entry</h1><p>创建二元题目，批量输入概率；提交后所有 aggregation 自动重算并锁定版本。</p></div>
        <button className="ghost-button" onClick={onCreateParticipant}>+ Add forecaster</button>
      </section>
      <section className="queue-board">
        <div className="section-title"><div><span className="eyebrow">OPEN</span><h2>Active events</h2></div><span>{openEvents.length} questions</span></div>
        {openEvents.length ? openEvents.map((event) => (
          <article className="event-row" key={event.id}>
            <button className="event-main" onClick={() => onDetail(event)}>
              <span className="category-label">{event.category}</span>
              <div><h3>{event.title}</h3><p>{event.season} · {event.closeTime ? `closes ${formatDate(event.closeTime)}` : "no deadline"}</p></div>
            </button>
            <div className="event-progress"><b>{event.forecasterCount}</b><span>forecasts</span><i><em style={{ width: `${Math.min(100, event.forecasterCount * 20)}%` }} /></i></div>
            <div className="event-actions"><button onClick={() => onForecasts(event)}>Input probabilities</button><button className="gold-action" onClick={() => onResolve(event)} disabled={event.forecasterCount < 2}>Resolve</button></div>
          </article>
        )) : <div className="empty-block">没有开放题目。使用右上角 “New event” 创建第一道题。</div>}
      </section>

      <section className="resolved-board">
        <div className="section-title"><div><span className="eyebrow">RESOLVED</span><h2>Resolution history</h2></div><span>{resolvedEvents.length} outcomes</span></div>
        <div className="resolved-grid">
          {resolvedEvents.slice(0, 12).map((event) => (
            <button key={event.id} onClick={() => onDetail(event)}>
              <span className={`outcome ${event.resolution ? "yes" : "no"}`}>{event.resolution ? "YES" : "NO"}</span>
              <h3>{event.title}</h3>
              <div><small>{event.category}</small><time>{event.resolvedAt ? formatDate(event.resolvedAt) : "—"}</time></div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
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
  const ready = pipeline.configured.aiBinding && pipeline.configured.searchSecret;
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading">
        <div>
          <span className="eyebrow">PROPHET-STYLE / SHARED CONTEXT</span>
          <h1>LLM forecast pipeline</h1>
          <p>每道题只检索一次并冻结来源、市场价格和时间戳；所有模型读取完全相同的 context，再独立给出 Yes / No 概率。</p>
        </div>
        <button className="primary-button" disabled={busy || !ready || !pipeline.stats.pending} onClick={onRun}>
          {busy ? "Running…" : "Run next event"}
        </button>
      </section>

      {!ready && (
        <section className="pipeline-alert">
          <b>还差一项部署配置</b>
          <span>
            {pipeline.configured.aiBinding ? "Workers AI 已连接；请设置 TAVILY_API_KEY。" : "请连接 Workers AI binding。"}
          </span>
          <code>npx wrangler secret put TAVILY_API_KEY</code>
        </section>
      )}

      <section className="metric-strip">
        <Metric label="Frozen contexts" value={pipeline.stats.contextsReady} detail="one search per event" />
        <Metric label="Completed" value={pipeline.stats.completed} detail={pipeline.model.participantName} />
        <Metric label="Pending" value={pipeline.stats.pending} detail="open selected events" />
        <Metric label="Pipeline" value={ready ? "READY" : "SETUP"} detail="3 events / hourly run" highlight />
      </section>

      <section className="pipeline-flow" aria-label="Forecast pipeline">
        <div><span>01</span><b>Selected event</b><small>balanced Polymarket slate</small></div>
        <i>→</i>
        <div><span>02</span><b>Tavily Search</b><small>up to 10 ranked sources</small></div>
        <i>→</i>
        <div><span>03</span><b>Frozen context</b><small>same evidence for every model</small></div>
        <i>→</i>
        <div className="model-step"><span>04</span><b>{pipeline.model.participantName}</b><small>Workers AI · strict JSON validation</small></div>
        <i>→</i>
        <div><span>05</span><b>Arena score</b><small>prediction history + Brier</small></div>
      </section>

      <section className="forecast-runs">
        <div className="section-title">
          <div><span className="eyebrow">REPRODUCIBLE RUNS</span><h2>Recent model forecasts</h2></div>
          <span>{pipeline.model.promptVersion}</span>
        </div>
        {pipeline.runs.length ? pipeline.runs.map((run) => (
          <article key={run.id} className={`forecast-run ${run.status}`}>
            <div className="run-status"><i /><span>{run.status}</span></div>
            <div className="run-question">
              <span>{run.category} · {run.sourceCount} shared sources</span>
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
              <small>YES PROBABILITY</small>
              <strong>{run.yesProbability === null ? "—" : `${(run.yesProbability * 100).toFixed(1)}%`}</strong>
              <span>{run.completedAt ? formatDateTime(run.completedAt) : "in progress"}</span>
              <code>{run.latencyMs === null ? "" : `${(run.latencyMs / 1000).toFixed(1)}s`}</code>
            </div>
          </article>
        )) : (
          <div className="empty-block">设置 Tavily 密钥后，定时任务会为最新题集建立第一批共享研究 context。</div>
        )}
      </section>
    </div>
  );
}

function MethodsView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading"><div><span className="eyebrow">REPRODUCIBLE BY DESIGN</span><h1>Aggregation methods</h1><p>所有方法对同一题目使用完全相同的 forecaster panel，历史权重只读取已结算数据。</p></div></section>
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
        <div><span>01</span><h3>Same inputs</h3><p>每个方法收到完全相同的手工概率。</p></div>
        <div><span>02</span><h3>Immutable snapshot</h3><p>每次修改写入 history，结算后锁定。</p></div>
        <div><span>03</span><h3>Outcome scoring</h3><p>{snapshot.methodology.primaryMetric}，并转换为可读的 Brier Index。</p></div>
        <div><span>04</span><h3>Live ranking</h3><p>结算完成后榜单立即重排并更新置信区间。</p></div>
      </section>
      <section className="formula-panel">
        <div><span className="eyebrow">PRIMARY SCORE</span><h2>Brier Index</h2></div>
        <code>BI = (1 − √ mean[(p − y)²]) × 100</code>
        <p>100 表示完美预测，50 对应始终预测 0.5，数值越高越好。Raw Brier 同时保留，便于复核。</p>
      </section>
    </div>
  );
}

function ActivityView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="page-content enter">
      <section className="page-heading compact-heading"><div><span className="eyebrow">PROVENANCE</span><h1>Audit log</h1><p>题目、预测批次和结算操作均留下时间、操作者与实体 ID。</p></div></section>
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
  const [category, setCategory] = useState("General");
  const [season, setSeason] = useState(snapshot?.seasons[0] || "Season 1");
  const [closeTime, setCloseTime] = useState("");
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit({ title, description, category, season, closeTime: closeTime || null }); };
  return <form className="arena-form" onSubmit={submit}>
    <label className="wide">Question title<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Will … occur before …?" /></label>
    <label className="wide">Description / resolution context<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional context and precise resolution rule" /></label>
    <label>Category<input list="category-list" value={category} onChange={(event) => setCategory(event.target.value)} /><datalist id="category-list">{snapshot?.categories.map((item) => <option key={item}>{item}</option>)}</datalist></label>
    <label>Season<input value={season} onChange={(event) => setSeason(event.target.value)} /></label>
    <label className="wide">Forecast deadline<input type="datetime-local" value={closeTime} onChange={(event) => setCloseTime(event.target.value)} /></label>
    <div className="form-note wide"><b>Binary question</b><span>当前版本固定使用 Yes / No，结算后进入实时 Brier 排名。</span></div>
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
    <div className="form-note wide"><b>Stable identity</b><span>同名 forecaster 会更新显示信息，不会删除历史预测。</span></div>
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
    <div className="event-context"><span>{event.category} / {event.season}</span><h3>{event.title}</h3><p>可输入 0–1 小数或使用右侧百分比预览。再次提交会更新当前版本，同时保留历史。</p></div>
    <div className="probability-grid">
      {participants.map((participant) => {
        const numeric = Number(values[participant.id]);
        return <label key={participant.id}><i style={{ background: participant.color }} /><div><b>{participant.name}</b><small>{participant.organization}</small></div><input inputMode="decimal" min="0" max="1" step="0.01" value={values[participant.id]} onChange={(inputEvent) => setValues((current) => ({ ...current, [participant.id]: inputEvent.target.value }))} placeholder="0.50" /><span>{Number.isFinite(numeric) && values[participant.id] !== "" ? `${Math.round(numeric * 100)}%` : "—"}</span></label>;
      })}
    </div>
    <div className="form-note"><b>Automatic recompute</b><span>提交后 Equal Mean、Median、Trimmed、Logit、Extremized 和 Performance Weighted 会一起更新。</span></div>
    <button className="primary-button" disabled={busy}>{busy ? "Computing…" : "Submit probabilities & recompute"}</button>
  </form>;
}

function ResolveForm({ event, busy, onSubmit }: { event: ArenaEvent; busy: boolean; onSubmit: (resolution: number, note: string) => void }) {
  const [resolution, setResolution] = useState<number | null>(null);
  const [note, setNote] = useState("");
  return <form className="resolve-form" onSubmit={(formEvent) => { formEvent.preventDefault(); if (resolution !== null) onSubmit(resolution, note); }}>
    <div className="event-context"><span>{event.forecasterCount} locked forecasts</span><h3>{event.title}</h3><p>结算后题目和概率会锁定，并立即进入榜单。</p></div>
    <div className="outcome-picker"><button type="button" className={resolution === 1 ? "selected yes" : ""} onClick={() => setResolution(1)}><b>YES</b><span>Event occurred</span></button><button type="button" className={resolution === 0 ? "selected no" : ""} onClick={() => setResolution(0)}><b>NO</b><span>Event did not occur</span></button></div>
    <label>Resolution note<textarea value={note} onChange={(inputEvent) => setNote(inputEvent.target.value)} placeholder="Outcome source or verification note" /></label>
    <button className="primary-button" disabled={busy || resolution === null}>{busy ? "Resolving…" : "Resolve & update leaderboard"}</button>
  </form>;
}

function EventDetail({ event, onInput, onResolve }: { event: ArenaEvent; onInput: () => void; onResolve: () => void }) {
  const sorted = [...event.predictions].sort((a, b) => a.kind.localeCompare(b.kind) || b.probability - a.probability);
  return <div className="event-detail">
    <div className="event-context"><span>{event.category} / {event.season}</span><h3>{event.title}</h3><p>{event.description || "No additional description."}</p></div>
    <div className="event-meta"><div><small>Status</small><b>{event.status}</b></div><div><small>Forecasters</small><b>{event.forecasterCount}</b></div><div><small>Deadline</small><b>{event.closeTime ? formatDate(event.closeTime) : "Open"}</b></div><div><small>Outcome</small><b>{event.resolution === null ? "—" : event.resolution ? "YES" : "NO"}</b></div></div>
    <div className="prediction-panel">
      {sorted.map((prediction) => <div key={prediction.id}><span className={prediction.kind === "aggregate" ? "aggregate-tag" : "forecaster-tag"}>{prediction.kind}</span><b>{prediction.name}</b><i><em style={{ width: `${prediction.probability * 100}%` }} /></i><strong>{(prediction.probability * 100).toFixed(1)}%</strong></div>)}
    </div>
    {event.status === "open" && <div className="dialog-actions"><button className="ghost-button" onClick={onInput}>Input probabilities</button><button className="primary-button" onClick={onResolve} disabled={event.forecasterCount < 2}>Resolve event</button></div>}
  </div>;
}

function LoadingState() {
  return <div className="loading-state"><span /><h2>Preparing benchmark</h2><p>正在初始化题目、聚合方法与榜单。</p></div>;
}

function viewLabel(view: View) {
  return { leaderboard: "Leaderboard / 实时榜单", curation: "Curation / 动态选题", forecasts: "Forecasts / 模型流水线", events: "Events / 题目管理", methods: "Methods / 方法说明", activity: "Audit log / 审计记录" }[view];
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
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatSourceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function sourceHost(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
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
    ["rank", "name", "type", "brier_index", "ci_low", "ci_high", "raw_brier", "resolved", "coverage_pct"],
    ...snapshot.leaderboard.map((row) => [row.rank, row.name, row.kind, row.brierIndex.toFixed(3), row.ciLow.toFixed(3), row.ciHigh.toFixed(3), row.brier.toFixed(6), row.resolved, row.coverage.toFixed(2)]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `aggregation-arena-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
