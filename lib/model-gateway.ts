import {
  buildCloudflareBindingRequest,
  FORECAST_REASONING_PROFILE,
  isRetryableModelGatewayError,
  modelGatewayRetryDelayMs,
  parseModelIdMap,
} from "@/lib/forecast-core.js";

type CloudflareAiBinding = {
  run(model: string, input: unknown, options: {
    gateway: {
      id: string;
      skipCache: boolean;
      collectLog: boolean;
      metadata: Record<string, string>;
    };
  }): Promise<unknown>;
};

export type ModelGatewayEnv = {
  AI?: CloudflareAiBinding;
  PROPHET_MODEL_GATEWAY_MODE?: string;
  PROPHET_AI_GATEWAY_ID?: string;
  PROPHET_CLOUDFLARE_MODEL_ID_MAP?: string;
  PROPHET_DISABLED_MODEL_IDS?: string;
};

export type ModelGatewayMessage = {
  role: string;
  content: string;
};

export class ModelGatewayRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelGatewayRequestError";
  }
}

export function modelGatewayConfigurationProblem(env: ModelGatewayEnv) {
  try {
    const mode = env.PROPHET_MODEL_GATEWAY_MODE?.trim() || "cloudflare-only";
    if (mode !== "cloudflare-only") return "PROPHET_MODEL_GATEWAY_MODE must be cloudflare-only";
    if (!env.AI) return "Cloudflare AI binding is not configured";
    const routes = parseModelIdMap(env.PROPHET_CLOUDFLARE_MODEL_ID_MAP);
    if (!Object.keys(routes).length) return "PROPHET_CLOUDFLARE_MODEL_ID_MAP is not configured";
  } catch (error) {
    return errorMessage(error);
  }
  return null;
}

export async function runModelGateway(
  env: ModelGatewayEnv,
  request: {
    modelId: string;
    messages: ModelGatewayMessage[];
    maxTokens: number;
    temperature: number;
    seed: number;
  },
) {
  const gatewayProblem = modelGatewayConfigurationProblem(env);
  if (gatewayProblem) throw new ModelGatewayRequestError(gatewayProblem);
  const cloudflareModelMap = parseModelIdMap(env.PROPHET_CLOUDFLARE_MODEL_ID_MAP);
  const cloudflareModelId = cloudflareModelMap[request.modelId];
  if (!cloudflareModelId) {
    throw new ModelGatewayRequestError(`No exact Cloudflare model route is configured for ${request.modelId}`);
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const payload = await env.AI!.run(
        cloudflareModelId,
        buildCloudflareBindingRequest(cloudflareModelId, request.messages, {
          ...request,
          panelModelId: request.modelId,
        }),
        {
          gateway: {
            id: env.PROPHET_AI_GATEWAY_ID?.trim() || "default",
            skipCache: true,
            collectLog: true,
            metadata: {
              application: "aggrena",
              panelModelId: request.modelId,
              reasoningProfile: FORECAST_REASONING_PROFILE,
            },
          },
        },
      );
      const gatewayError = gatewayPayloadError(payload);
      if (gatewayError) {
        throw new ModelGatewayRequestError(`Cloudflare AI request failed for ${request.modelId}: ${gatewayError}`);
      }
      return { payload, gatewayModelId: cloudflareModelId };
    } catch (error) {
      const wrapped = error instanceof ModelGatewayRequestError
        ? error
        : new ModelGatewayRequestError(
          `Cloudflare AI request failed for ${request.modelId}: ${errorMessage(error)}`,
          { cause: error },
        );
      if (attempt === maxAttempts - 1 || !isRetryableModelGatewayError(wrapped)) throw wrapped;
      const retryDelayMs = modelGatewayRetryDelayMs(attempt);
      console.warn(JSON.stringify({
        message: "retrying transient Cloudflare model request",
        modelId: request.modelId,
        attempt: attempt + 1,
        retryDelayMs,
        error: wrapped.message.slice(0, 500),
      }));
      await wait(retryDelayMs);
    }
  }
  throw new ModelGatewayRequestError(`Cloudflare AI request failed for ${request.modelId}`);
}

export async function listModelGatewayModels(env: ModelGatewayEnv) {
  const gatewayProblem = modelGatewayConfigurationProblem(env);
  if (gatewayProblem) throw new ModelGatewayRequestError(gatewayProblem);
  return Object.values(parseModelIdMap(env.PROPHET_CLOUDFLARE_MODEL_ID_MAP));
}

function gatewayPayloadError(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as {
    error?: { message?: unknown } | string;
    choices?: { error?: { message?: unknown } | string }[];
  };
  const error = body.error || body.choices?.[0]?.error;
  if (!error) return null;
  if (typeof error === "string") return error.slice(0, 500);
  return String(error.message || "upstream provider error").slice(0, 500);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
