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
      task = runMarketScheduled(env, controller);
    } else if (controller.cron === "20 * * * *") {
      task = runForecastBatch(env);
    } else if (controller.cron === "30 * * * *") {
      task = runAgentHarnessBatch(env, { eventLimit: 3 });
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
