import {
  buildGatewayRequest,
  parseModelIdMap,
  resolveGatewayModelId,
} from "@/lib/forecast-core.js";

export type ModelGatewayEnv = {
  PROPHET_MODEL_GATEWAY_URL?: string;
  PROPHET_MODEL_GATEWAY_API_KEY?: string;
  PROPHET_MODEL_ID_MAP?: string;
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
  if (!env.PROPHET_MODEL_GATEWAY_URL?.trim()) return "PROPHET_MODEL_GATEWAY_URL is not configured";
  if (!env.PROPHET_MODEL_GATEWAY_API_KEY?.trim()) return "PROPHET_MODEL_GATEWAY_API_KEY is not configured";
  try {
    const endpoint = new URL(env.PROPHET_MODEL_GATEWAY_URL);
    if (!["http:", "https:"].includes(endpoint.protocol)) {
      return "PROPHET_MODEL_GATEWAY_URL must use HTTP or HTTPS";
    }
    parseModelIdMap(env.PROPHET_MODEL_ID_MAP);
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
  const gatewayModelId = resolveGatewayModelId(request.modelId, env.PROPHET_MODEL_ID_MAP);
  let response: Response;
  try {
    response = await fetch(env.PROPHET_MODEL_GATEWAY_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PROPHET_MODEL_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGatewayRequest(gatewayModelId, request.messages, request)),
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
