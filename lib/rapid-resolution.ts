import { runAgentHarnessBatch } from "@/lib/agent-aggregation";
import { runForecastBatch } from "@/lib/forecasting";
import {
  ensureCurationReady,
  selectRapidResolutionSlate,
  syncLiveMarketCandidates,
} from "@/lib/polymarket";

type RapidResolutionEnv = Parameters<typeof runForecastBatch>[0]
  & Parameters<typeof runAgentHarnessBatch>[0];

export async function runRapidResolutionRound(
  env: RapidResolutionEnv,
  options: { jobLimit?: number } = {},
) {
  const now = new Date();
  await ensureCurationReady(env.DB);
  const hour = now.toISOString().slice(0, 13).replace("T", "-");
  const runId = `rapid-${hour}00-v1`;
  const [existing, latestSync] = await Promise.all([
    env.DB.prepare("SELECT status FROM selection_runs WHERE id=?")
      .bind(runId).first<{ status: string }>(),
    env.DB.prepare("SELECT started_at FROM curation_sync_runs WHERE status='completed' ORDER BY id DESC LIMIT 1")
      .first<{ started_at: string }>(),
  ]);
  const latestSyncAgeMs = latestSync?.started_at
    ? now.getTime() - Date.parse(latestSync.started_at)
    : Number.POSITIVE_INFINITY;
  const sync = existing?.status === "completed" || latestSyncAgeMs < 90 * 60_000
    ? null
    : await syncLiveMarketCandidates(env.DB, now);
  const selection = await selectRapidResolutionSlate(env.DB, now);
  const forecast = selection.eventIds.length
    ? await runForecastBatch(env, Math.max(1, Math.min(72, Number(options.jobLimit || 16))), selection.eventIds)
    : { configured: true, processed: 0, completed: 0, outcomes: [] };
  const harness = selection.eventIds.length
    ? await runAgentHarnessBatch(env, {
        resolvedOnly: false,
        eventLimit: selection.eventIds.length,
        eventIds: selection.eventIds,
      })
    : null;
  return { runId, sync, selection, forecast, harness };
}
