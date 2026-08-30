# Optional Kalshi authentication for public market data

Anonymous reads remain the default. The scheduled Worker, private pipeline sync RPC,
manual `run_pipeline_sync` admin action and rapid-round intake accept two optional
Worker secret bindings together:

- `KALSHI_API_KEY_ID`: the ID of an existing production Kalshi API key.
- `KALSHI_API_PRIVATE_KEY`: its unencrypted PKCS8 RSA PEM (`BEGIN PRIVATE KEY`).
  Real multiline PEM and literal `\n` line separators are accepted.

Configure these through the authorized deployment's secret management, never in
source, committed configuration, public environment variables or chat. Prefer an
existing key restricted to read scope. This code neither creates keys nor submits
orders; it only authenticates the existing GET market-data requests. If only one
binding is present, or the key is malformed, the Kalshi source reports a redacted
configuration error instead of silently falling back to anonymous access.

The same optional credentials cover candidate discovery and selected-market
resolution. Requests retain the existing production API host and its existing
fallback. The signer refuses any other destination, signs each attempt afresh,
and authenticated requests disable redirects. Existing request budgets, 429
cooldowns and retry policy remain in force. Adding authentication does not prove
or guarantee that a provider rate limit will disappear; verify a bounded public
GET after authorized secret configuration and respect any returned cooldown.

Signing follows the official [authenticated request guide](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests):
RSA-PSS/SHA256, 32-byte salt, milliseconds + GET + full pathname, excluding query.
No undocumented server expiry window is assumed. Tests generate ephemeral local
RSA keys and independently verify signatures, paths and fresh retry timestamps;
they do not read real credentials or make network requests.
