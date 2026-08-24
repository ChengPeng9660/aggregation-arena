import {
  buildCloudflareBindingRequest,
  buildGatewayRequestForEndpoint,
  parseModelIdMap,
  resolveGatewayModelId,
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
  PROPHET_MODEL_GATEWAY_URL?: string;
  PROPHET_MODEL_GATEWAY_API_KEY?: string;
  PROPHET_MODEL_ID_MAP?: string;
  PROPHET_DISABLED_MODEL_IDS?: string;
  PROPHET_RESPONSES_MODEL_IDS?: string;
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
    const mode = modelGatewayMode(env);
    if (mode === "cloudflare-hybrid" && !env.AI) return "Cloudflare AI binding is not configured";
    if (!env.PROPHET_MODEL_GATEWAY_URL?.trim()) return "PROPHET_MODEL_GATEWAY_URL is not configured";
    if (!env.PROPHET_MODEL_GATEWAY_API_KEY?.trim()) return "PROPHET_MODEL_GATEWAY_API_KEY is not configured";
    const endpoint = new URL(env.PROPHET_MODEL_GATEWAY_URL);
    if (!["http:", "https:"].includes(endpoint.protocol)) {
      return "PROPHET_MODEL_GATEWAY_URL must use HTTP or HTTPS";
    }
    parseModelIdMap(env.PROPHET_MODEL_ID_MAP);
    parseModelIdMap(env.PROPHET_CLOUDFLARE_MODEL_ID_MAP);
    parseModelIdList(env.PROPHET_RESPONSES_MODEL_IDS, "PROPHET_RESPONSES_MODEL_IDS");
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
  if (modelGatewayMode(env) === "cloudflare-hybrid" && cloudflareModelId) {
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
      if (error instanceof ModelGatewayRequestError) throw error;
      throw new ModelGatewayRequestError(
        `Cloudflare AI request failed for ${request.modelId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  const gatewayModelId = resolveGatewayModelId(request.modelId, env.PROPHET_MODEL_ID_MAP);
  const gatewayEndpoint = resolveGatewayEndpoint(
    env.PROPHET_MODEL_GATEWAY_URL!,
    request.modelId,
    env.PROPHET_RESPONSES_MODEL_IDS,
  );
  let response: Response;
  try {
    response = await fetch(gatewayEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PROPHET_MODEL_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGatewayRequestForEndpoint(
        gatewayEndpoint,
        gatewayModelId,
        request.messages,
        request,
      )),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new ModelGatewayRequestError(
      `Model gateway request could not reach ${request.modelId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let responseText: string;
  try {
    responseText = await readLimitedResponse(response, 256_000);
  } catch (error) {
    throw new ModelGatewayRequestError(
      `Model gateway response failed for ${request.modelId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new ModelGatewayRequestError(
      `Model gateway returned non-JSON content for ${request.modelId} (HTTP ${response.status})`,
    );
  }
  const gatewayError = gatewayPayloadError(payload);
  if (!response.ok || gatewayError) {
    const detail = gatewayError || `HTTP ${response.status}`;
    throw new ModelGatewayRequestError(`Model gateway request failed for ${request.modelId}: ${detail}`);
  }
  return { payload, gatewayModelId };
}

export async function listModelGatewayModels(env: ModelGatewayEnv) {
  const gatewayProblem = modelGatewayConfigurationProblem(env);
  if (gatewayProblem) throw new ModelGatewayRequestError(gatewayProblem);
  const endpoint = new URL(env.PROPHET_MODEL_GATEWAY_URL!);
  endpoint.pathname = endpoint.pathname.replace(/\/(?:chat\/completions|responses)\/?$/, "/models");
  endpoint.search = "";
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${env.PROPHET_MODEL_GATEWAY_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ModelGatewayRequestError(`Model catalog request failed: ${errorMessage(error)}`, { cause: error });
  }
  const responseText = await readLimitedResponse(response, 1_000_000);
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new ModelGatewayRequestError(`Model catalog returned non-JSON content (HTTP ${response.status})`);
  }
  const gatewayError = gatewayPayloadError(payload);
  if (!response.ok || gatewayError) {
    throw new ModelGatewayRequestError(`Model catalog request failed: ${gatewayError || `HTTP ${response.status}`}`);
  }
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: { id?: unknown }[] }).data
    : [];
  return data.map((model) => String(model?.id || "").trim()).filter(Boolean);
}

function resolveGatewayEndpoint(endpointValue: string, modelId: string, responsesModelIds: string | undefined) {
  const endpoint = new URL(endpointValue);
  const useResponses = parseModelIdList(responsesModelIds, "PROPHET_RESPONSES_MODEL_IDS").includes(modelId);
  if (useResponses && endpoint.hostname.toLowerCase() === "api.poe.com") {
    endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, "/responses");
    endpoint.search = "";
  }
  return endpoint.toString();
}

function parseModelIdList(value: string | undefined, variableName: string) {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((modelId) => typeof modelId !== "string" || !modelId.trim())) {
    throw new Error(`${variableName} must be a JSON array of non-empty strings`);
  }
  return [...new Set(parsed.map((modelId) => modelId.trim()))];
}

function modelGatewayMode(env: ModelGatewayEnv) {
  const mode = env.PROPHET_MODEL_GATEWAY_MODE?.trim() || "external";
  if (!["external", "cloudflare-hybrid"].includes(mode)) {
    throw new Error("PROPHET_MODEL_GATEWAY_MODE must be external or cloudflare-hybrid");
  }
  return mode;
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

async function readLimitedResponse(response: Response, maximumBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response exceeded configured limit");
      throw new Error(`Model gateway response exceeded ${maximumBytes} bytes`);
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
