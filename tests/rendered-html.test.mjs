import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const port = 43100 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Production server exited with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return response;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the production server");
}

test("production server renders the finished Aggregation Arena shell", async () => {
  const server = spawn(
    process.execPath,
    [
      "./node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--port",
      String(port),
      "--local",
      "--ip",
      "127.0.0.1",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-test.log",
        TAVILY_API_KEY: "test-only",
        PROPHET_MODEL_GATEWAY_URL: "https://models.example.invalid/v1/chat/completions",
        PROPHET_MODEL_GATEWAY_API_KEY: "test-only",
        PROPHET_MODEL_ID_MAP: "{}",
      },
      stdio: "ignore",
    },
  );

  try {
    const response = await waitForServer(server);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Aggregation Arena/);
    assert.match(html, /Aggregation Arena/);
    assert.match(html, /Loading data/);
    assert.doesNotMatch(html, /codex-preview/);
    assert.doesNotMatch(html, /Your site is taking shape/);
    assert.doesNotMatch(html, /react-loading-skeleton/);
  } finally {
    server.kill("SIGTERM");
  }
});
