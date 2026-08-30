import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

function getLocalBindingConfig(isDev: boolean) {
  return {
    main: "./worker/index.ts",
    // Wrangler already declares nodejs_compat. The Vite plugin appends
    // overrides, so repeating it here prevents Miniflare from starting.
    compatibility_flags: [],
    d1_databases:
      isDev && d1
        ? [
            {
              binding: d1,
              database_name: "site-creator-d1",
              database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
            },
          ]
        : [],
    r2_buckets:
      isDev && r2
        ? [
            {
              binding: r2,
              bucket_name: "site-creator-r2",
            },
          ]
        : [],
  };
}

export default defineConfig(async ({ command }) => {
  // Only inject the local placeholder D1/R2 bindings during development.
  // Production deploys use the bindings declared in wrangler.jsonc.
  const localBindingConfig = getLocalBindingConfig(command === "serve");
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
