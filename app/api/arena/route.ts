import {
  ArenaError,
  changeEventStatus,
  createEvent,
  createParticipant,
  getArenaSnapshot,
  resolveEvent,
  submitForecasts,
} from "@/lib/arena";

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
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = writeActor(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action || "");
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
    } else {
      throw new ArenaError(400, "未知操作");
    }

    return Response.json({ ok: true, result }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}

function writeActor(request: Request) {
  const url = new URL(request.url);
  const email = request.headers.get("oai-authenticated-user-email");
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!email && !isLocal) {
    throw new ArenaError(401, "请先登录后再修改 benchmark 数据");
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
