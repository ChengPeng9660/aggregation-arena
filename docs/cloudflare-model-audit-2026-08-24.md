# Cloudflare-only model API audit

Audit date: 2026-08-24

Aggrena production inference is Cloudflare-only. The Fixed Context registry contains 13 exact Cloudflare routes; 11 are currently active and two paid Workers AI routes are temporarily disabled. The two agent harnesses use Cloudflare's exact `alibaba/qwen3.7-plus` route. Production has no Poe URL, Poe model map, Poe API secret requirement, or external fallback.

## Registered Cloudflare routes

| Aggrena model ID | Cloudflare model ID | Request contract |
| --- | --- | --- |
| `gemini-3.6-flash` | `google/gemini-3.6-flash` | Chat Completions |
| `gemini-3.1-pro` | `google/gemini-3.1-pro` | Chat Completions |
| `claude-fable-5` | `anthropic/claude-fable-5` | Anthropic Messages |
| `deepseek-v4-flash` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | Workers AI chat input; temporarily disabled on the Free plan |
| `claude-opus-4.8` | `anthropic/claude-opus-4.8` | Anthropic Messages with adaptive thinking |
| `claude-sonnet-4.6` | `anthropic/claude-sonnet-4.6` | Anthropic Messages |
| `grok-4.6` | `xai/grok-4.6` | Chat Completions |
| `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | Chat Completions |
| `kimi-k3` | `moonshotai/kimi-k3` | Chat Completions |
| `grok-4.5` | `xai/grok-4.5` | Chat Completions |
| `glm-5.2` | `@cf/zai-org/glm-5.2` | Workers AI chat input; temporarily disabled on the Free plan |
| `grok-4.3` | `xai/grok-4.3` | Chat Completions |
| `minimax-m2.7` | `minimax/m2.7` | Chat Completions |
| Agent harness only | `alibaba/qwen3.7-plus` | Chat Completions |

## Removed from the active panel

| Model | Cloudflare audit result | Action |
| --- | --- | --- |
| GPT-5.6 Sol | Exact Cloudflare model exists, but authenticated medium-effort smoke requests returned `Model execution failed (Payment error)` | Retired until the exact route passes |
| GPT-5.5 | Exact Cloudflare model exists, but authenticated medium-effort smoke requests returned `Model execution failed (Payment error)` | Retired until the exact route passes |
| Qwen 3.6 Plus | No exact Cloudflare model; only Qwen 3.7 Plus is listed | Retired; no substitution |
| Inkling | Exact Cloudflare listing returned `This model is not available via unified billing. Please use BYOK.` | Retired because production does not use provider BYOK |
| Muse Spark 1.1 | No usable exact Cloudflare route | Retired; no substitution |
| Foresight V3 | No usable exact Cloudflare route | Retired; no substitution |

Historical prediction and score rows remain in D1 for auditability. Their medium participant IDs are marked inactive and do not appear in the current model comparison or new forecast queue.

## Workers AI billing smoke test

- `alibaba/qwen3.7-plus` returned `OK` through the account's Cloudflare AI REST endpoint and remains active for both agent harnesses.
- `@cf/deepseek-ai/deepseek-v4-flash-0731` returned Workers AI error `5035`: unavailable on the Workers Free plan.
- `@cf/zai-org/glm-5.2` returned the same Workers AI error `5035`.
- Both `@cf/...` models are therefore listed in `PROPHET_DISABLED_MODEL_IDS` until the account is moved to a compatible paid or Unified Workers AI billing path.

## Reasoning profile

The active panel freezes `reasoning_profile=medium` under config version `prophet-fixed-context-v2-medium`. The gateway translates this into documented provider fields when available:

- Anthropic adaptive thinking: `output_config.effort=medium`.
- xAI, DeepSeek, Kimi, and GLM routes: `reasoning_effort=medium` where the route accepts it.
- Exact models without a supported reasoning-level parameter retain provider-default reasoning; the Worker does not send fabricated fields.

The reasoning profile is written to AI Gateway metadata and each forecast run's prompt version.

## Production invariants

- `PROPHET_MODEL_GATEWAY_MODE=cloudflare-only`.
- Every active forecaster and the Qwen agent harness must have an entry in `PROPHET_CLOUDFLARE_MODEL_ID_MAP`.
- Missing routes fail closed; the code never falls back to an external provider.
- `PROPHET_DISABLED_MODEL_IDS=["deepseek-v4-flash","glm-5.2"]` keeps failed Workers AI jobs out of the live queue.
- `PROPHET_MODEL_GATEWAY_URL`, `PROPHET_MODEL_ID_MAP`, `PROPHET_RESPONSES_MODEL_IDS`, and the `PROPHET_MODEL_GATEWAY_API_KEY` secret requirement are absent from production configuration.
- Cloudflare inference uses `skipCache: true` and retains request logs for cost and failure auditing.

## Sources

- Cloudflare model catalog: https://developers.cloudflare.com/ai/models/
- GPT-5.6 Sol: https://developers.cloudflare.com/ai/models/openai/gpt-5.6-sol/
- GPT-5.5: https://developers.cloudflare.com/ai/models/openai/gpt-5.5/
- Qwen 3.7 Plus: https://developers.cloudflare.com/ai/models/alibaba/qwen3.7-plus/
- Cloudflare REST API: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- Unified Billing: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
