"use client";

import { Fragment, useEffect, useMemo, useState } from "react";

type HistoricalModel = { id: string; name: string; organization: string; n: number; variants: number };
type HistoricalEvent = {
  id: string;
  date: string;
  source: string;
  category: string;
  question: string;
  outcome: 0 | 1;
  forecasts: Record<string, number>;
};
type HistoricalData = {
  meta: { dataset: string; generated: string; rawSourceRows: number; matchedForecastRows: number; events: number; models: number; providers: number; providerNames: string[]; rounds: number; firstRound: string; lastRound: string; rule: string };
  models: HistoricalModel[];
  events: HistoricalEvent[];
};

const METHODS = [
  { id: "mean", name: "Equal Mean", short: "Mean", color: "#4F207F", rule: "Arithmetic mean of every available selected forecast." },
  { id: "median", name: "Median Pool", short: "Median", color: "#EFAB02", rule: "Median probability; robust to a single extreme forecast." },
  { id: "trimmed", name: "Trimmed Mean", short: "Trimmed", color: "#168368", rule: "20% trimmed mean for K ≥ 5; equal mean fallback for smaller K." },
  { id: "logit", name: "Log-odds Pool", short: "Log-odds", color: "#C8444A", rule: "Average in log-odds space, then transform back to probability." },
  { id: "extreme", name: "Extremized Mean", short: "Extremized", color: "#5A78C7", rule: "Equal mean with its log-odds multiplied by 1.35." },
  { id: "weighted", name: "Past-performance Pool", short: "Weighted", color: "#9A5A2F", rule: "Inverse-Brier weights learned only from earlier forecast rounds." },
] as const;

type MethodId = (typeof METHODS)[number]["id"];
type ScoredEvent = { event: HistoricalEvent; k: number; values: Record<MethodId, number> };
type RankingRow = { id: MethodId; name: string; color: string; brier: number; score: number; ece: number; events: number; coverage: number; avgK: number };
type Series = { name: string; color: string; values: { x: number; y: number; label?: string }[] };

export function HistoricalArena() {
  const [data, setData] = useState<HistoricalData | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [completeCases, setCompleteCases] = useState(false);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<MethodId | null>(null);

  useEffect(() => {
    fetch("/forecastbench/history.json")
      .then((response) => {
        if (!response.ok) throw new Error("Historical dataset could not be loaded.");
        return response.json() as Promise<HistoricalData>;
      })
      .then((payload) => {
        setData(payload);
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("models")?.split(",").filter((id) => payload.models.some((model) => model.id === id));
        setSelected(requested?.length ? requested : diverseModels(payload.models, 8).map((model) => model.id));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Historical dataset could not be loaded."));
  }, []);

  useEffect(() => {
    if (!selected.length) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "history");
    url.searchParams.set("models", selected.join(","));
    window.history.replaceState({}, "", url);
  }, [selected]);

  const categories = useMemo(() => data ? Array.from(new Set(data.events.map((event) => event.category))).sort() : [], [data]);
  const filteredEvents = useMemo(() => data?.events.filter((event) => category === "all" || event.category === category) ?? [], [data, category]);
  const analysis = useMemo(() => data ? analyze(filteredEvents, selected, completeCases) : null, [data, filteredEvents, selected, completeCases]);
  const visibleModels = useMemo(() => data?.models.filter((model) => `${model.organization} ${model.name}`.toLowerCase().includes(search.toLowerCase())) ?? [], [data, search]);

  if (error) return <section className="history-page"><div className="history-error">{error}</div></section>;
  if (!data || !analysis) return <section className="history-page history-loading"><span />Loading ForecastBench history…</section>;

  const setModelCount = (requestedCount: number) => {
    const count = Math.min(data.models.length, Math.max(2, Math.round(requestedCount)));
    setSelected((current) => {
      const retained = data.models.filter((model) => current.includes(model.id)).slice(0, count).map((model) => model.id);
      if (retained.length === count) return retained;
      return [...retained, ...data.models.filter((model) => !retained.includes(model.id)).slice(0, count - retained.length).map((model) => model.id)];
    });
  };
  const setPreset = (preset: "diverse" | "top" | "all" | "openai") => {
    const count = Math.max(2, selected.length);
    const models = preset === "diverse" ? diverseModels(data.models, count)
      : preset === "top" ? data.models.slice(0, count)
      : preset === "all" ? data.models
      : data.models.filter((model) => model.organization.toLowerCase() === preset);
    setSelected(models.map((model) => model.id));
  };
  const toggleModel = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <section className="history-page enter">
      <header className="history-hero">
        <div>
          <span className="eyebrow">ForecastBench · historical backtest</span>
          <h1>Aggregation<br />Leaderboard</h1>
          <p>Choose the forecasters. Every aggregation method is rebuilt on resolved questions using the models available for each event.</p>
        </div>
        <dl className="history-meta">
          <div><dt>Resolved events</dt><dd>{data.meta.events.toLocaleString()}</dd></div>
          <div><dt>Models / providers</dt><dd>{data.meta.models} / {data.meta.providers}</dd></div>
          <div><dt>Forecast rounds</dt><dd>{data.meta.rounds}</dd></div>
          <div><dt>Coverage</dt><dd>{data.meta.firstRound.slice(0, 7)} — {data.meta.lastRound.slice(0, 7)}</dd></div>
        </dl>
      </header>

      <div className="history-workbench">
        <aside className="model-picker">
          <div className="picker-heading">
            <div><span>INPUT 01</span><h2>Base forecasters</h2></div>
            <label className="k-control" aria-label="Number of selected models">
              <span>MODEL COUNT</span>
              <span className="k-stepper">
                <button type="button" onClick={() => setModelCount(selected.length - 1)} disabled={selected.length <= 2} aria-label="Select one fewer model">−</button>
                <input type="number" min="2" max={data.models.length} value={selected.length} onChange={(event) => setModelCount(Number(event.target.value))} />
                <button type="button" onClick={() => setModelCount(selected.length + 1)} disabled={selected.length >= data.models.length} aria-label="Select one more model">+</button>
              </span>
            </label>
          </div>
          <p>Choose any K from 2 to {data.models.length}, then change individual models below. Missing forecasts are handled event by event.</p>
          <div className="model-presets">
            <button onClick={() => setPreset("diverse")}>Cross-provider</button>
            <button onClick={() => setPreset("top")}>Top by coverage</button>
            <button onClick={() => setPreset("openai")}>OpenAI</button>
            <button onClick={() => setPreset("all")}>All</button>
          </div>
          <input className="model-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models" aria-label="Search models" />
          <div className="model-options">
            {visibleModels.map((model) => (
              <label key={model.id} className={selected.includes(model.id) ? "selected" : ""}>
                <input type="checkbox" checked={selected.includes(model.id)} onChange={() => toggleModel(model.id)} />
                <span><b>{model.name}</b><small>{model.organization} · {model.n.toLocaleString()} events</small></span>
              </label>
            ))}
          </div>
          <label className="complete-toggle">
            <input type="checkbox" checked={completeCases} onChange={(event) => setCompleteCases(event.target.checked)} />
            <span><b>Complete cases only</b><small>Require every selected model on every scored event.</small></span>
          </label>
        </aside>

        <main className="history-results">
          <div className="history-controls">
            <div><span>INPUT 02</span><b>{selected.length < 2 ? "Select at least two forecasters" : `${analysis.eligible.toLocaleString()} events can be aggregated`}</b></div>
            <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>

          <section className="history-ranking" aria-label="Historical aggregation leaderboard">
            <div className="history-section-title"><span>OUTPUT 01</span><div><h2>Leaderboard</h2><p>Lower Brier is better. All methods share the same selected-model event set.</p></div></div>
            <div className="history-table-scroll">
              <table>
                <thead><tr><th>Rank</th><th>Aggregation method</th><th>1 − Brier</th><th>Brier</th><th>ECE</th><th>Events</th><th>Coverage</th><th>Avg K</th></tr></thead>
                <tbody>{analysis.ranking.length ? analysis.ranking.map((row, index) => (
                  <Fragment key={row.id}>
                    <tr className={index === 0 ? "history-winner" : ""} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      <td><span className={`history-rank rank-${index + 1}`}>{index + 1}</span></td>
                      <td><span className="history-method"><i style={{ background: row.color }} /><b>{row.name}</b></span></td>
                      <td className="history-score">{row.score.toFixed(4)}</td><td>{row.brier.toFixed(4)}</td><td>{row.ece.toFixed(4)}</td><td>{row.events.toLocaleString()}</td><td>{row.coverage.toFixed(1)}%</td><td>{row.avgK.toFixed(1)}</td>
                    </tr>
                    {expanded === row.id && <tr className="history-detail"><td colSpan={8}>{METHODS.find((method) => method.id === row.id)?.rule}</td></tr>}
                  </Fragment>
                )) : <tr><td className="history-empty-row" colSpan={8}>No events satisfy this model selection and coverage rule. Turn off complete cases or choose models with overlapping forecast rounds.</td></tr>}</tbody>
              </table>
            </div>
          </section>

          <div className="history-chart-grid">
            <ChartPanel number="OUTPUT 02" title="Cumulative performance" subtitle="1 − Brier after each ForecastBench round">
              <LineChart series={analysis.cumulative} yFormat={(value) => value.toFixed(3)} />
            </ChartPanel>
            <ChartPanel number="OUTPUT 03" title="Performance vs model count" subtitle="How each method behaves at the event-level available K">
              <LineChart series={analysis.byK} xFormat={(value) => `K${Math.round(value)}`} yFormat={(value) => value.toFixed(3)} />
            </ChartPanel>
            <ChartPanel number="OUTPUT 04" title="Rank history" subtitle="Cumulative rank as resolved rounds are added">
              <LineChart series={analysis.rankHistory} yReverse yFormat={(value) => `#${Math.round(value)}`} />
            </ChartPanel>
            <ChartPanel number="OUTPUT 05" title="Calibration" subtitle="Observed frequency against predicted probability">
              <LineChart series={analysis.calibration} xFormat={(value) => `${Math.round(value * 100)}%`} yFormat={(value) => `${Math.round(value * 100)}%`} diagonal />
            </ChartPanel>
          </div>

          <section className="history-audit">
            <div className="history-section-title"><span>EVENT AUDIT</span><div><h2>What entered the score</h2><p>Recent resolved examples make the model-to-aggregation path inspectable.</p></div></div>
            <div className="history-event-list">{representativeAudit(analysis.scored).map((item) => (
              <article key={item.event.id}>
                <div><span>{item.event.category}</span><time>{item.event.date}</time></div>
                <h3>{item.event.question}</h3>
                <footer><b>Outcome {item.event.outcome === 1 ? "YES" : "NO"}</b><span>{item.k} of {selected.length} selected models available</span><span>Mean {Math.round(item.values.mean * 100)}%</span></footer>
              </article>
            ))}</div>
          </section>

          <footer className="history-provenance">
            <div><b>Evaluation rule</b><p>Available-case aggregation is the default. An event is scored when at least two selected models forecast it. Complete-case mode is optional.</p></div>
            <div><b>Data provenance</b><p>{data.meta.matchedForecastRows.toLocaleString()} resolved marginal prediction rows · {data.meta.providers} model providers · CC BY-SA 4.0 · snapshot generated {data.meta.generated}.</p></div>
          </footer>
        </main>
      </div>
    </section>
  );
}

function analyze(events: HistoricalEvent[], selected: string[], completeCases: boolean) {
  const base = events.filter((event) => selected.some((id) => event.forecasts[id] !== undefined));
  if (selected.length < 2) return emptyAnalysis(base.length);
  const byDate = new Map<string, HistoricalEvent[]>();
  for (const event of base) byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);
  const history = new Map<string, { loss: number; n: number }>();
  const scored: ScoredEvent[] = [];

  for (const date of Array.from(byDate.keys()).sort()) {
    const round = byDate.get(date) ?? [];
    for (const event of round) {
      const available = selected.filter((id) => event.forecasts[id] !== undefined);
      if (available.length < 2 || (completeCases && available.length !== selected.length)) continue;
      const probabilities = available.map((id) => event.forecasts[id]);
      const weights = available.map((id) => {
        const prior = history.get(id);
        return prior?.n ? 1 / (0.02 + prior.loss / prior.n) : 1;
      });
      scored.push({ event, k: available.length, values: aggregate(probabilities, weights) });
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

  if (!scored.length) return emptyAnalysis(base.length);

  const ranking = makeRanking(scored, base.length);
  const dates = Array.from(new Set(scored.map((item) => item.event.date))).sort();
  const cumulative: Series[] = METHODS.map((method) => ({ name: method.short, color: method.color, values: dates.map((date, index) => {
    const rows = scored.filter((item) => item.event.date <= date);
    return { x: index, y: 1 - mean(rows.map((item) => brier(item.values[method.id], item.event.outcome))), label: date };
  }) }));
  const ks = Array.from(new Set(scored.map((item) => item.k)).values()).sort((a, b) => a - b);
  const byK: Series[] = METHODS.map((method) => ({ name: method.short, color: method.color, values: ks.map((k) => {
    const rows = scored.filter((item) => item.k === k);
    return { x: k, y: 1 - mean(rows.map((item) => brier(item.values[method.id], item.event.outcome))), label: `${rows.length.toLocaleString()} events` };
  }) }));
  const rankHistory: Series[] = METHODS.map((method) => ({ name: method.short, color: method.color, values: dates.map((date, index) => {
    const rows = scored.filter((item) => item.event.date <= date);
    const ordered = METHODS.map((candidate) => ({ id: candidate.id, loss: mean(rows.map((item) => brier(item.values[candidate.id], item.event.outcome))) })).sort((a, b) => a.loss - b.loss);
    return { x: index, y: ordered.findIndex((item) => item.id === method.id) + 1, label: date };
  }) }));
  const calibration: Series[] = ranking.slice(0, 3).map((row) => ({ name: METHODS.find((method) => method.id === row.id)?.short ?? row.name, color: row.color, values: calibrationBins(scored, row.id) }));
  return { base: base.length, eligible: scored.length, scored, ranking, cumulative, byK, rankHistory, calibration };
}

function emptyAnalysis(base: number) {
  return { base, eligible: 0, scored: [] as ScoredEvent[], ranking: [] as RankingRow[], cumulative: [] as Series[], byK: [] as Series[], rankHistory: [] as Series[], calibration: [] as Series[] };
}

function aggregate(values: number[], weights: number[]): Record<MethodId, number> {
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
  };
}

function makeRanking(rows: ScoredEvent[], baseCount: number): RankingRow[] {
  return METHODS.map((method) => {
    const losses = rows.map((row) => brier(row.values[method.id], row.event.outcome));
    const loss = mean(losses);
    return { id: method.id, name: method.name, color: method.color, brier: loss, score: 1 - loss, ece: ece(rows, method.id), events: rows.length, coverage: baseCount ? rows.length / baseCount * 100 : 0, avgK: mean(rows.map((row) => row.k)) };
  }).sort((a, b) => a.brier - b.brier);
}

function calibrationBins(rows: ScoredEvent[], method: MethodId) {
  return Array.from({ length: 10 }, (_, index) => {
    const low = index / 10, high = (index + 1) / 10;
    const bin = rows.filter((row) => row.values[method] >= low && (index === 9 ? row.values[method] <= high : row.values[method] < high));
    return bin.length ? { x: mean(bin.map((row) => row.values[method])), y: mean(bin.map((row) => row.event.outcome)), label: `${bin.length.toLocaleString()} events` } : null;
  }).filter((value): value is { x: number; y: number; label: string } => value !== null);
}

function representativeAudit(rows: ScoredEvent[]) {
  const latestByCategory = new Map<string, ScoredEvent>();
  for (const row of rows) latestByCategory.set(row.event.category, row);
  return Array.from(latestByCategory.values()).sort((a, b) => b.event.date.localeCompare(a.event.date)).slice(0, 8);
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

function ece(rows: ScoredEvent[], method: MethodId) {
  const bins = calibrationBins(rows, method);
  return bins.reduce((total, bin) => {
    const count = rows.filter((row) => Math.floor(Math.min(row.values[method], .9999) * 10) === Math.floor(Math.min(bin.x, .9999) * 10)).length;
    return total + Math.abs(bin.x - bin.y) * count / Math.max(rows.length, 1);
  }, 0);
}

function ChartPanel({ number, title, subtitle, children }: { number: string; title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="history-chart-panel"><header><span>{number}</span><h2>{title}</h2><p>{subtitle}</p></header>{children}</section>;
}

function LineChart({ series, yReverse = false, diagonal = false, xFormat, yFormat = (value) => value.toFixed(2) }: { series: Series[]; yReverse?: boolean; diagonal?: boolean; xFormat?: (value: number) => string; yFormat?: (value: number) => string }) {
  const width = 620, height = 285, left = 52, right = 18, top = 18, bottom = 42;
  const points = series.flatMap((item) => item.values);
  if (!points.length) return <div className="chart-empty">Select at least two models to calculate this chart.</div>;
  const xMin = Math.min(...points.map((point) => point.x)), xMax = Math.max(...points.map((point) => point.x));
  const rawMin = diagonal ? 0 : Math.min(...points.map((point) => point.y));
  const rawMax = diagonal ? 1 : Math.max(...points.map((point) => point.y));
  const padding = Math.max((rawMax - rawMin) * .12, .015);
  const yMin = diagonal ? 0 : yReverse ? 1 : Math.max(0, rawMin - padding);
  const yMax = diagonal ? 1 : yReverse ? series.length : rawMax + padding;
  const x = (value: number) => left + (value - xMin) / Math.max(xMax - xMin, 1) * (width - left - right);
  const y = (value: number) => top + (yReverse ? (value - yMin) : (yMax - value)) / Math.max(yMax - yMin, .0001) * (height - top - bottom);
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4);
  const xTicks = Array.from(new Set([xMin, xMin + (xMax - xMin) / 2, xMax]));
  return <div className="history-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={series.map((item) => item.name).join(", ")}>
      {yTicks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="chart-grid" /><text x={left - 9} y={y(tick) + 4} textAnchor="end">{yFormat(tick)}</text></g>)}
      {xTicks.map((tick) => {
        const nearest = points.reduce((best, point) => Math.abs(point.x - tick) < Math.abs(best.x - tick) ? point : best, points[0]);
        const label = xFormat ? xFormat(tick) : nearest.label?.slice(0, 7) ?? String(Math.round(tick));
        return <text key={tick} x={x(tick)} y={height - 13} textAnchor="middle">{label}</text>;
      })}
      {diagonal && <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="chart-diagonal" />}
      {series.map((item) => <g key={item.name}>
        <polyline points={item.values.map((point) => `${x(point.x)},${y(point.y)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        {item.values.map((point, index) => <circle key={index} cx={x(point.x)} cy={y(point.y)} r="2.6" fill="#fff" stroke={item.color} strokeWidth="1.7"><title>{item.name}: {yFormat(point.y)}{point.label ? ` · ${point.label}` : ""}</title></circle>)}
      </g>)}
    </svg>
    <div className="chart-legend">{series.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div>
  </div>;
}

function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function brier(probability: number, outcome: number) { return (probability - outcome) ** 2; }
function logit(value: number) { const clipped = Math.min(.999, Math.max(.001, value)); return Math.log(clipped / (1 - clipped)); }
function logistic(value: number) { return 1 / (1 + Math.exp(-value)); }
