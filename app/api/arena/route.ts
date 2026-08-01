import {
  ArenaError,
  changeEventStatus,
  createEvent,
  createParticipant,
  getArenaSnapshot,
  resolveEvent,
  submitForecasts,
} from "@/lib/arena";
import { getForecastPipelineSnapshot, runForecastBatch } from "@/lib/forecasting";
import { selectDailyBalancedSlate } from "@/lib/polymarket";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const track = url.searchParams.get("track");
    const window = url.searchParams.get("window");
    const snapshot = await getArenaSnapshot({
      track: ["aggregators", "forecasters", "all"].includes(String(track))
        ? (track as "aggregators" | "forecasters" | "all")
        : "aggregators",
      window: ["all", "30d", "90d"].includes(String(window))
        ? (window as "all" | "30d" | "90d")
        : "all",
      season: url.searchParams.get("season") || "all",
      category: url.searchParams.get("category") || "all",
    });
    const forecastPipeline = await getForecastPipelineSnapshot(
      undefined,
      env as unknown as { AI?: unknown; TAVILY_API_KEY?: string },
    );
    return Response.json({ ...snapshot, forecastPipeline }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action || "");
    const actor = action === "run_daily_forecast_batch"
      ? pipelineActor(request)
      : writeActor(request);
    let result: unknown;

    if (action === "create_participant") {
      result = await createParticipant(payload, actor);
    } else if (action === "create_event") {
      result = await createEvent(
        {
          title: String(payload.title || ""),
          description: String(payload.description || ""),
          category: String(payload.category || ""),
          season: String(payload.season || ""),
          closeTime: payload.closeTime ? String(payload.closeTime) : null,
        },
        actor,
      );
    } else if (action === "submit_forecasts") {
      result = await submitForecasts(
        {
          eventId: String(payload.eventId || ""),
          forecasts: Array.isArray(payload.forecasts)
            ? (payload.forecasts as { participantId?: string; probability?: number | string; rationale?: string }[])
            : [],
        },
        actor,
      );
    } else if (action === "resolve_event") {
      result = await resolveEvent(
        {
          eventId: String(payload.eventId || ""),
          resolution: String(payload.resolution ?? ""),
          resolvedOutcome: String(payload.resolvedOutcome ?? ""),
          note: String(payload.note || ""),
        },
        actor,
      );
    } else if (action === "invalidate_event" || action === "reopen_event") {
      result = await changeEventStatus(
        {
          eventId: String(payload.eventId || ""),
          status: action === "invalidate_event" ? "invalid" : "open",
        },
        actor,
      );
    } else if (action === "run_forecast_batch") {
      result = await runForecastBatch(env as unknown as Parameters<typeof runForecastBatch>[0], 1);
    } else if (action === "run_daily_forecast_batch") {
      const runtime = env as unknown as Parameters<typeof runForecastBatch>[0];
      const selection = await selectDailyBalancedSlate(runtime.DB);
      const forecast = await runForecastBatch(runtime, 3);
      result = { selection, forecast };
    } else {
      throw new ArenaError(400, "Unknown operation");
    }

    return Response.json({ ok: true, result }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}

function pipelineActor(request: Request) {
  const configured = (env as unknown as { PIPELINE_ADMIN_TOKEN?: string }).PIPELINE_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!configured || !supplied || supplied !== configured) {
    throw new ArenaError(401, "Not authorized to run the production forecast pipeline");
  }
  return "pipeline-admin";
}

function writeActor(request: Request) {
  const url = new URL(request.url);
  const email = request.headers.get("oai-authenticated-user-email");
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!email && !isLocal) {
    throw new ArenaError(401, "Sign in before changing benchmark data");
  }
  return email || "local-admin";
}

function routeError(error: unknown) {
  const status = error instanceof ArenaError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(error);
  return Response.json(
    { ok: false, error: status === 500 ? "internal_error" : "request_error", message },
    { status },
  );
}
