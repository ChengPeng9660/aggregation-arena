/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runPolymarketScheduled } from "../lib/polymarket";
import { runForecastBatch } from "../lib/forecasting";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  TAVILY_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: { cron: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    let task: Promise<unknown>;
    if (controller.cron === "0 * * * *" || controller.cron === "10 0 * * *") {
      task = runPolymarketScheduled(env, controller);
    } else if (controller.cron === "20 * * * *") {
      task = runForecastBatch(env);
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

export default worker;
