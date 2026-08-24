# Cloudflare model API migration audit

Audit date: 2026-08-24

Aggrena's current Fixed Context panel contains 16 explicitly named models. Cloudflare's current catalog has a route for every entry. This panel is based on the former 18-model Prophet panel but is no longer an unchanged reproduction of it.

| Aggrena model ID | Cloudflare model ID | Request contract |
| --- | --- | --- |
| `gemini-3.6-flash` | `google/gemini-3.6-flash` | Chat Completions |
| `claude-fable-5` | `anthropic/claude-fable-5` | Anthropic Messages |
| `gemini-3.1-pro` | `google/gemini-3.1-pro` | Chat Completions |
| `gpt-5.6-sol` | `openai/gpt-5.6-sol` | Responses |
| `gpt-5.5-high` | `openai/gpt-5.5` with high reasoning effort | Responses |
| `claude-opus-4.8-thinking` | `anthropic/claude-opus-4.8` with adaptive thinking/high effort | Anthropic Messages |
| `kimi-k3` | `moonshotai/kimi-k3` | Chat Completions |
| `thinking-machines-zs-v2` | `thinkingmachines/inkling` | Anthropic Messages |
| `claude-sonnet-4.6` | `anthropic/claude-sonnet-4.6` | Anthropic Messages |
| `grok-4.5` | `xai/grok-4.5` | Chat Completions |
| `glm-5.2` | `@cf/zai-org/glm-5.2` | Workers AI chat input |
| `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | Chat Completions |
| `qwen-3.7-plus` | `alibaba/qwen3.7-plus` | Chat Completions |
| `grok-4.3` | `xai/grok-4.3` | Chat Completions |
| `inkling-256k` | `thinkingmachines/inkling-256k` | Anthropic Messages |
| `minimax-m2.7` | `minimax/m2.7` | Chat Completions |

## Explicit panel changes

| Former entry | Current action |
| --- | --- |
| Qwen 3.6 Plus | Replaced by the explicitly named Qwen 3.7 Plus model and a new participant ID. |
| Inkling Small | Replaced by the explicitly named Inkling 256K model and a new participant ID. |
| Muse Spark 1.1 | Removed from the current site because Cloudflare has no exact route. |
| Foresight V3 | Removed from the current site because Cloudflare has no exact route. |

The four former participant IDs are marked inactive. Existing D1 prediction and score records are retained for auditability, but inactive forecasters are filtered from current event cards, current forecaster rankings, and current pair rankings.

Cloudflare documents Inkling 256K as intended for low-traffic testing and internal use rather than high-throughput production. Its latency and rate behavior must therefore be checked in the live smoke matrix before activation.

## Production decision

- The Worker has a Cloudflare AI binding and an explicit 16-model map.
- `PROPHET_MODEL_GATEWAY_MODE=external` remains the safe production default until Unified Billing has funds and all 16 models pass live smoke tests.
- After validation, set the mode to `cloudflare-hybrid` and remove successfully tested entries from `PROPHET_DISABLED_MODEL_IDS`.
- The Cloudflare route uses `skipCache: true` so independent forecasting runs are not served cached model output, while request logging remains enabled for cost and failure auditing.

## Account verification

The authenticated Cloudflare account reached the REST model endpoint successfully, but the 2026-08-24 smoke request returned HTTP 402: `Insufficient balance; add money to your gateway or use BYOK`. Production activation remains blocked on loading AI Gateway credits (or configuring exact-provider BYOK keys) and rerunning the smoke matrix.

## Sources

- Cloudflare model catalog: https://developers.cloudflare.com/ai/models/
- Qwen 3.7 Plus: https://developers.cloudflare.com/ai/models/alibaba/qwen3.7-plus/
- Inkling 256K: https://developers.cloudflare.com/ai/models/thinkingmachines/inkling-256k/
- Workers AI binding and AI Gateway routing: https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
- REST API formats and authentication: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- Unified Billing setup: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
