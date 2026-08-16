/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runMarketScheduled } from "../lib/polymarket";
import { runForecastBatch } from "../lib/forecasting";
import { runAgentHarnessBatch } from "../lib/agent-aggregation";

type ImageOutputFormat = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif" | "rgb" | "rgba";
const IMAGE_OUTPUT_FORMATS = new Set<ImageOutputFormat>([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "rgb", "rgba",
]);
const ARENA_API_FRESH_SECONDS = 45;
const ARENA_API_STALE_SECONDS = 86400;
const ARENA_API_KV_TTL_SECONDS = 7 * 86400;
const ARENA_API_WARM_URLS = [
  "https://www.aggrena.com/api/arena?track=aggregators&window=all&category=all",
  "https://www.aggrena.com/api/arena?track=forecasters&window=all&category=all",
];

type ArenaSnapshotMetadata = {
  storedAt: string;
  contentType: string;
};

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "aggrena.com" && request.headers.has("cf-ray")) {
      url.hostname = "www.aggrena.com";
      return Response.redirect(url.toString(), 301);
    }

    if (request.method === "GET" && url.pathname === "/api/arena") {
      return serveArenaApi(request, env, ctx);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const outputFormat = IMAGE_OUTPUT_FORMATS.has(format as ImageOutputFormat)
            ? format as ImageOutputFormat
            : "image/webp";
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format: outputFormat, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: { cron: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    let task: Promise<unknown>;
    if (controller.cron === "0 * * * *" || controller.cron === "10 0 * * *") {
      task = runThenRefreshArenaCache(runMarketScheduled(env, controller), env, ctx);
    } else if (controller.cron === "20 * * * *") {
      task = runThenRefreshArenaCache(runForecastBatch(env), env, ctx);
    } else if (controller.cron === "30 * * * *") {
      task = runThenRefreshArenaCache(runAgentHarnessBatch(env, { eventLimit: 3 }), env, ctx);
    } else {
      console.warn(`Ignoring unknown cron schedule: ${controller.cron}`);
      return;
    }
    ctx.waitUntil(task.catch((error) => {
      console.error(`Scheduled pipeline stage failed for ${controller.cron}`, error);
      throw error;
    }));
  },
};

async function runThenRefreshArenaCache<T>(task: Promise<T>, env: Env, ctx: ExecutionContext) {
  const outcome = await task.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await refreshArenaApiWarmSnapshots(env, ctx);
  } catch (refreshError) {
    if (outcome.ok) throw refreshError;
    console.error(JSON.stringify({
      message: "arena cache refresh also failed after a scheduled pipeline failure",
      error: refreshError instanceof Error ? refreshError.message : String(refreshError),
    }));
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function serveArenaApi(request: Request, env: Env, ctx: ExecutionContext) {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const freshKey = arenaApiCacheKey(request, "fresh");
  const staleKey = arenaApiCacheKey(request, "stale");
  const fresh = await safeCacheMatch(cache, freshKey);
  if (fresh) return cacheResponse(fresh, "hit");

  const [durable, stale] = await Promise.all([
    safeKvGet(env.ARENA_SNAPSHOT_CACHE, arenaApiKvKey(request)),
    safeCacheMatch(cache, staleKey),
  ]);
  if (durable.value) {
    ctx.waitUntil(cacheArenaSnapshotLocally(cache, request, durable.value, durable.metadata?.contentType));
    return kvResponse(durable.value, durable.metadata);
  }
  if (stale) return cacheResponse(stale, "stale");

  let response: Response;
  try {
    response = await handler.fetch(request, env, ctx);
  } catch (error) {
    console.error(JSON.stringify({
      message: "arena API failed without an available snapshot",
      error: error instanceof Error ? error.message : String(error),
    }));
    return arenaUnavailableResponse();
  }

  if (!response.ok) {
    console.error(JSON.stringify({
      message: "arena API returned a failure without an available snapshot",
      status: response.status,
    }));
    return arenaUnavailableResponse();
  }

  const body = await response.arrayBuffer();
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-aggrena-cache", "miss");
  const status = response.status;
  const statusText = response.statusText;

  ctx.waitUntil(persistArenaSnapshot(cache, env.ARENA_SNAPSHOT_CACHE, request, body.slice(0), response.headers));

  return new Response(body, { status, statusText, headers: responseHeaders });
}

async function refreshArenaApiWarmSnapshots(env: Env, ctx: ExecutionContext) {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const failures: string[] = [];
  for (const url of ARENA_API_WARM_URLS) {
    try {
      const request = new Request(url, { method: "GET" });
      const response = await handler.fetch(request, env, ctx);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.arrayBuffer();
      await persistArenaSnapshot(cache, env.ARENA_SNAPSHOT_CACHE, request, body, response.headers);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    throw new Error(`Arena cache refresh failed: ${failures.join("; ")}`);
  }
}

async function persistArenaSnapshot(
  cache: Cache,
  kv: KVNamespace,
  request: Request,
  body: ArrayBuffer,
  sourceHeaders: Headers,
) {
  await Promise.all([
    cacheArenaSnapshotLocally(cache, request, body.slice(0), sourceHeaders.get("content-type") || undefined),
    safeKvPut(kv, arenaApiKvKey(request), body.slice(0), {
      storedAt: new Date().toISOString(),
      contentType: sourceHeaders.get("content-type") || "application/json; charset=utf-8",
    }),
  ]);
}

async function cacheArenaSnapshotLocally(
  cache: Cache,
  request: Request,
  body: ArrayBuffer,
  contentType = "application/json; charset=utf-8",
) {
  const headers = new Headers({ "content-type": contentType });
  await Promise.all([
    safeCachePut(cache, arenaApiCacheKey(request, "fresh"), cachedArenaResponse(body.slice(0), headers, ARENA_API_FRESH_SECONDS, 200, "OK")),
    safeCachePut(cache, arenaApiCacheKey(request, "stale"), cachedArenaResponse(body.slice(0), headers, ARENA_API_STALE_SECONDS, 200, "OK")),
  ]);
}

function arenaApiCacheKey(request: Request, variant: "fresh" | "stale") {
  const url = new URL(request.url);
  url.protocol = "https:";
  url.hostname = "www.aggrena.com";
  url.port = "";
  url.searchParams.set("_aggrena_cache", `v4-${variant}`);
  return new Request(url.toString(), { method: "GET" });
}

function arenaApiKvKey(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("_aggrena_cache");
  url.searchParams.sort();
  return `arena-api:v4:${url.pathname}${url.search}`;
}

function cachedArenaResponse(
  body: ArrayBuffer,
  sourceHeaders: Headers,
  maxAge: number,
  status: number,
  statusText: string,
) {
  const headers = new Headers(sourceHeaders);
  headers.set("cache-control", `public, max-age=${maxAge}`);
  headers.delete("x-aggrena-cache");
  return new Response(body, { status, statusText, headers });
}

function cacheResponse(response: Response, state: "hit" | "stale") {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-aggrena-cache", state);
  if (state === "stale") headers.set("warning", '110 - "Response is stale"');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function kvResponse(body: ArrayBuffer, metadata: ArenaSnapshotMetadata | null) {
  const ageSeconds = metadata?.storedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(metadata.storedAt)) / 1000))
    : null;
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": metadata?.contentType || "application/json; charset=utf-8",
    "x-aggrena-cache": "kv-hit",
  });
  if (ageSeconds !== null && Number.isFinite(ageSeconds)) {
    headers.set("x-aggrena-snapshot-age", String(ageSeconds));
    if (ageSeconds > 300) headers.set("warning", '110 - "Response is stale"');
  }
  return new Response(body, { status: 200, headers });
}

function arenaUnavailableResponse() {
  return Response.json(
    {
      ok: false,
      error: "temporarily_unavailable",
      message: "The live benchmark is refreshing. Please retry shortly.",
    },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "10",
      },
    },
  );
}

async function safeCacheMatch(cache: Cache, key: Request) {
  try {
    return await cache.match(key);
  } catch (error) {
    console.warn("Arena API cache lookup failed", error);
    return undefined;
  }
}

async function safeCachePut(cache: Cache, key: Request, response: Response) {
  try {
    await cache.put(key, response);
  } catch (error) {
    console.warn("Arena API cache write failed", error);
  }
}

async function safeKvGet(kv: KVNamespace, key: string) {
  try {
    return await kv.getWithMetadata<ArenaSnapshotMetadata>(key, "arrayBuffer");
  } catch (error) {
    console.warn(JSON.stringify({
      message: "arena snapshot KV lookup failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return { value: null, metadata: null, cacheStatus: null };
  }
}

async function safeKvPut(kv: KVNamespace, key: string, body: ArrayBuffer, metadata: ArenaSnapshotMetadata) {
  try {
    await kv.put(key, body, { expirationTtl: ARENA_API_KV_TTL_SECONDS, metadata });
  } catch (error) {
    console.warn(JSON.stringify({
      message: "arena snapshot KV write failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export default worker;
