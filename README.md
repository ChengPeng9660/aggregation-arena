# Aggregation Arena

A live, auditable benchmark for forecast aggregation methods. Polymarket supplies real-time binary questions and resolutions; independent forecasters submit locked probabilities; the Worker computes ensemble forecasts and updates the leaderboard after resolution.

## What is implemented

- Live Polymarket ingestion from the public Gamma API
- Frozen event definitions and first-seen market-price baselines
- Prophet Arena-compatible HTTP forecast payloads
- Authenticated forecast submission endpoint
- Equal mean, median, trimmed mean, logit pool, performance-weighted, and market-aware aggregation
- Binary Brier scoring and live leaderboard API
- Cloudflare D1 persistence and a five-minute scheduled sync
- GitHub Pages UI with live-backend mode and an explicit market-only preview fallback

## Architecture

```text
Polymarket -> Cloudflare Worker -> D1 events/predictions
                         |-> external forecaster endpoint(s)
                         |-> aggregation methods
                         |-> resolution + Brier score
GitHub Pages <- public markets + leaderboard APIs
```

No provider key belongs in `index.html` or `config.js`. All secrets are stored with Cloudflare.

## Deploy the API

Prerequisites: Node.js and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler d1 create aggregation-arena-db
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder ID, then run:

```bash
npm run db:migrate:remote
npx wrangler secret put AGGREGATION_API_TOKEN
npm run deploy
```

The token protects write endpoints. Use a long random value and never commit it.

After deployment, copy the Worker URL into `config.js`:

```js
window.ARENA_API_URL = "https://aggregation-arena-api.YOUR-SUBDOMAIN.workers.dev";
```

The GitHub Pages frontend will then switch automatically from market-only preview mode to the live prediction pipeline.

## Connect a Prophet-style forecaster

Add these Worker settings or secrets:

```bash
npx wrangler secret put FORECAST_ENDPOINT
npx wrangler secret put FORECAST_API_TOKEN
npx wrangler secret put FORECASTER_ID
npx wrangler secret put FORECASTER_NAME
```

Every five minutes, the Worker sends open events that the configured forecaster has not yet predicted:

```json
{
  "event_ticker": "12345",
  "market_ticker": "12345",
  "title": "Will ...?",
  "description": "...",
  "category": "Politics",
  "rules": "...",
  "close_time": "2026-10-01T00:00:00Z",
  "outcomes": ["Yes", "No"],
  "resolved_outcome": null
}
```

The forecaster may return the Prophet Arena format:

```json
{
  "probabilities": [
    { "market": "Yes", "probability": 0.68 },
    { "market": "No", "probability": 0.32 }
  ],
  "rationale": "Optional explanation",
  "model_version": "v1"
}
```

To ingest additional forecasters directly:

```bash
curl -X POST "https://YOUR-WORKER/api/predictions" \
  -H "Authorization: Bearer YOUR_AGGREGATION_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "12345",
    "participant_id": "my-forecaster",
    "participant_name": "My Forecaster",
    "probability_yes": 0.61,
    "model_version": "v1"
  }'
```

Each accepted base forecast triggers a recomputation of all aggregation methods for that event.

## Public API

- `GET /api/health` — ingestion and resolution status
- `GET /api/markets` — active normalized markets plus ensemble probabilities
- `GET /api/leaderboard` — resolved-market Brier rankings

Protected API:

- `POST /api/predictions` — submit a base forecast
- `POST /api/aggregate` — recompute one or all open events
- `POST /api/sync` — request an immediate sync

## Local checks

```bash
npm test
npm run db:migrate:local
npm run dev
```

The leaderboard intentionally remains empty until tracked markets resolve. The page labels its built-in sample standings as preview data whenever no Worker URL is configured; it no longer randomly changes scores.
