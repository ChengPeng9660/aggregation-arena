# Cloudflare model API migration audit

Audit date: 2026-08-24

Aggrena's current Fixed Context registry contains the exact 19-model panel requested from the Prophet Arena leaderboard. Every entry has a new medium-specific participant ID. Thirteen models use exact Cloudflare routes and six use exact Poe bot aliases; no nearby model version is substituted.

## Production route matrix

| Aggrena model ID | Production route | Request contract |
| --- | --- | --- |
| `gpt-5.6-sol` | Poe `gpt-5.6-sol` | Responses |
| `gemini-3.6-flash` | Cloudflare `google/gemini-3.6-flash` | Chat Completions |
| `gemini-3.1-pro` | Cloudflare `google/gemini-3.1-pro` | Chat Completions |
| `claude-fable-5` | Cloudflare `anthropic/claude-fable-5` | Anthropic Messages |
| `gpt-5.5` | Poe `gpt-5.5` | Responses |
| `deepseek-v4-flash` | Cloudflare `@cf/deepseek-ai/deepseek-v4-flash-0731` | Workers AI chat input |
| `claude-opus-4.8` | Cloudflare `anthropic/claude-opus-4.8` | Anthropic Messages with adaptive thinking |
| `claude-sonnet-4.6` | Cloudflare `anthropic/claude-sonnet-4.6` | Anthropic Messages |
| `grok-4.6` | Cloudflare `xai/grok-4.6` | Chat Completions |
| `deepseek-v4-pro` | Cloudflare `deepseek/deepseek-v4-pro` | Chat Completions |
| `kimi-k3` | Cloudflare `moonshotai/kimi-k3` | Chat Completions |
| `grok-4.5` | Cloudflare `xai/grok-4.5` | Chat Completions |
| `glm-5.2` | Cloudflare `@cf/zai-org/glm-5.2` | Workers AI chat input |
| `qwen-3.6-plus` | Poe `qwen3.6-plus-t` | Chat Completions |
| `thinking-machines-zs-v2` | Poe `inkling` | Chat Completions |
| `muse-spark-1.1` | Poe `muse-spark-1-1` | Chat Completions |
| `grok-4.3` | Cloudflare `xai/grok-4.3` | Chat Completions |
| `foresight-v3` | Poe `foresight-v3` | Responses |
| `minimax-m2.7` | Cloudflare `minimax/m2.7` | Chat Completions |

## Exact-version policy

- Qwen 3.6 Plus remains Qwen 3.6 Plus; it is not replaced by Qwen 3.7 Plus.
- Inkling remains Inkling; it is not replaced by Inkling 256K.
- GPT-5.6 Sol and GPT-5.5 fall back to their Poe aliases because authenticated Cloudflare Responses smoke requests returned upstream payment errors.
- Muse Spark 1.1 and Foresight V3 use Poe because Cloudflare does not expose usable exact routes for them.
- Historical participant IDs remain retired so their previous high/default reasoning results cannot be silently combined with the new medium cohort.

## Reasoning profile

The panel freezes `reasoning_profile=medium` under config version `prophet-fixed-context-v2-medium`. The gateway translates this into documented provider fields when available:

- OpenAI Responses: `reasoning.effort=medium`.
- Anthropic adaptive thinking: `output_config.effort=medium`.
- xAI, DeepSeek, Kimi, and GLM routes: `reasoning_effort=medium` where the route accepts it.
- Exact models without a supported reasoning-level parameter retain provider-default reasoning; the Worker does not send fabricated fields.

The reasoning profile is also written to AI Gateway metadata and each forecast run's prompt version for auditability.

## Production decision

- `PROPHET_MODEL_GATEWAY_MODE=cloudflare-hybrid` selects Cloudflare only for the 13 IDs in `PROPHET_CLOUDFLARE_MODEL_ID_MAP`; every other registered model takes its exact Poe fallback.
- `PROPHET_DISABLED_MODEL_IDS=[]` keeps the full requested panel active.
- The Cloudflare route uses `skipCache: true` so independent forecasting runs are not served cached model output, while request logging remains enabled for cost and failure auditing.
- Model-event failures remain retryable and are recorded rather than silently replaced with another model.

## Account verification

The authenticated account showed a positive AI Gateway credit balance on 2026-08-24. Third-party Unified Billing requests succeeded. Native `@cf/...` routes require the `default` gateway's Workers AI billing choice to cover Workers AI usage; this setting is operationally separate from the source deployment.

## Sources

- Cloudflare model catalog: https://developers.cloudflare.com/ai/models/
- DeepSeek V4 Flash: https://developers.cloudflare.com/ai/models/%40cf/deepseek-ai/deepseek-v4-flash-0731/
- Grok 4.6: https://developers.cloudflare.com/ai/models/xai/grok-4.6/
- GPT-5.6 Sol: https://developers.cloudflare.com/ai/models/openai/gpt-5.6-sol/
- Workers AI binding and AI Gateway routing: https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
- REST API formats and authentication: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- Unified Billing setup: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
