import { NvidiaPendingResponseError, resolveNvidiaResponseWithFallbacks } from "./nvidia.ts";
import { CognitoJwtVerifier } from "npm:aws-jwt-verify@5.2.1";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1149.0";
import { Signer } from "npm:@aws-sdk/rds-signer@3.1149.0";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "npm:@aws-sdk/client-secrets-manager@3.1149.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.1149.0";
import postgres from "npm:postgres@3.4.9";
import {
  ExternalProviderConfig,
  ExternalProviderError,
  generateExternalResponse,
  parseExternalProvider,
  ProviderConfigurationError,
} from "./providers.ts";
import {
  TaskPlanValidationError,
  validateTaskPlanInput,
  validateTaskPlanWithClaude,
} from "./task_plan.ts";

const pairingTtlSeconds = 3600;
const maxImageBytes = 8 * 1024 * 1024;
const signedUrlTtlSeconds = 10 * 60;
const maxTranscriptBytes = 256_000;
const defaultNvidiaBaseUrl = "https://integrate.api.nvidia.com/v1";
const defaultNvidiaModel = "meta/llama-3.2-90b-vision-instruct";
const defaultNvidiaFallbackModel = "meta/llama-3.2-11b-vision-instruct";
const finalNvidiaFallbackModel = "moonshotai/kimi-k3";
const nvidiaRequestTimeoutMilliseconds = Deno.env.get("APP_ENV") === "aws" ? 20_000 : 5 * 60_000;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "DELETE, GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-request-id",
  "Access-Control-Max-Age": "86400",
};

type PairingState = "idle" | "listening" | "thinking" | "speaking";

interface AuthenticatedUser {
  id: string;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  imageIds: string[];
}

interface StoredImage {
  image_id: string;
  object_path: string;
  content_type: string;
  byte_size: number;
  created_at: string;
}

interface ModelImageReference {
  contentType: "image/jpeg" | "image/png";
  url: string;
}

function defaultErrorCode(status: number): string {
  const codes: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    503: "service_unavailable",
  };
  return codes[status] ?? (status >= 500 ? "internal_error" : "request_failed");
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly authenticate = false,
    readonly code = defaultErrorCode(status),
    readonly context: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestLog {
  event: "api_request_completed";
  service: "api";
  environment: "local" | "aws" | "unknown";
  request_id: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  error?: {
    type: string;
    code: string;
    message: string;
    context?: Record<string, string | number | boolean>;
    stack?: string;
  };
}

function requestEnvironment(): "local" | "aws" | "unknown" {
  try {
    return environmentName();
  } catch {
    return "unknown";
  }
}

function normalizedRoute(path: string): string {
  if (/^\/v1\/images\/[^/]+$/.test(path)) return "/v1/images/:imageId";
  if (/^\/v1\/task-plans\/[^/]+$/.test(path)) return "/v1/task-plans/:taskPlanId";
  if (/^\/v1\/task-plans\/[^/]+\/(approve|validate)$/.test(path)) {
    return "/v1/task-plans/:taskPlanId/:action";
  }
  if (/^\/v1\/task-runs\/[^/]+$/.test(path)) return "/v1/task-runs/:taskRunId";
  if (/^\/v1\/task-runs\/[^/]+\/(commands|stop)$/.test(path)) {
    return "/v1/task-runs/:taskRunId/:action";
  }
  return path;
}

function redactedErrorText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /([?&](?:apikey|key|pairingToken|signature|token)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9._-]+/g, "<redacted-key>")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, "<redacted-key>")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "<redacted-key>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted-key>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted-jwt>");
}

function compactStack(error: Error): string | undefined {
  if (!error.stack) return undefined;
  return redactedErrorText(error.stack).split("\n").slice(0, 8).join("\n").slice(0, 4_000);
}

function requestLog(
  request: Request,
  path: string,
  requestId: string,
  status: number,
  startedAt: number,
  error?: unknown,
): void {
  const entry: RequestLog = {
    event: "api_request_completed",
    service: "api",
    environment: requestEnvironment(),
    request_id: requestId,
    method: request.method,
    route: normalizedRoute(path),
    status,
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
  };

  if (error instanceof ApiError) {
    entry.error = {
      type: error.name,
      code: error.code,
      message: error.message,
      ...(Object.keys(error.context).length > 0 ? { context: error.context } : {}),
    };
  } else if (error instanceof Error) {
    entry.error = {
      type: error.name,
      code: "unhandled_error",
      message: redactedErrorText(error.message).slice(0, 1_000),
      stack: compactStack(error),
    };
  } else if (error !== undefined) {
    entry.error = {
      type: "UnknownError",
      code: "unhandled_error",
      message: "A non-Error value was thrown.",
    };
  }

  const serialized = JSON.stringify(entry);
  if (status >= 500) {
    console.error(serialized);
  } else if (status >= 400) {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}

function responseWithRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function providerFailureContext(
  response: Response,
): Promise<Record<string, string | number | boolean>> {
  const context: Record<string, string | number | boolean> = {
    upstream_status: response.status,
  };
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return context;
  }

  try {
    const payload = await response.json() as Record<string, unknown>;
    const error = typeof payload.error === "object" && payload.error !== null
      ? payload.error as Record<string, unknown>
      : payload;
    const code = error.code;
    const message = error.message ?? error.detail;
    if (typeof code === "string" || typeof code === "number") {
      context.provider_error_code = redactedErrorText(String(code)).slice(0, 200);
    }
    if (typeof message === "string") {
      context.provider_error_message = redactedErrorText(message).slice(0, 500);
    }
  } catch {
    // The upstream status remains useful when the provider error body is malformed.
  }
  return context;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: corsHeaders });
}

function clientErrorContext(
  context: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const allowedKeys = new Set([
    "failure_type",
    "provider_error_code",
    "provider_error_message",
    "upstream_status",
    "provider",
    "model",
    "suggested_action",
    "maximum_inline_image_bytes",
    "prior_upstream_statuses",
    "state_version",
  ]);
  return Object.fromEntries(
    Object.entries(context).filter(([key]) => allowedKeys.has(key)),
  );
}

function errorResponse(error: ApiError, requestId: string): Response {
  const headers = {
    ...corsHeaders,
    "Content-Type": "application/json",
    ...(error.authenticate ? { "WWW-Authenticate": "Bearer" } : {}),
  };
  const context = clientErrorContext(error.context);
  return new Response(
    JSON.stringify({
      detail: error.message,
      request_id: requestId,
      status: error.status,
      error: {
        type: error.name,
        code: error.code,
        message: error.message,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      },
    }),
    {
      status: error.status,
      headers,
    },
  );
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new ApiError(503, `${name} is not configured.`);
  }
  return value;
}

function environmentName(): "local" | "aws" {
  return Deno.env.get("APP_ENV") === "local" ? "local" : "aws";
}

function imageBucket(): string {
  return requiredEnvironment("PAIRING_IMAGE_BUCKET");
}

function awsRegion(): string {
  return requiredEnvironment("AWS_REGION");
}

const s3 = new S3Client({ region: awsRegion() });
const secrets = new SecretsManagerClient({ region: awsRegion() });
const verifier = CognitoJwtVerifier.create({
  userPoolId: requiredEnvironment("COGNITO_USER_POOL_ID"),
  clientId: requiredEnvironment("COGNITO_APP_CLIENT_ID"),
  tokenUse: "access",
});
const databaseSigner = new Signer({
  hostname: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  username: "metaglasses_api",
  region: awsRegion(),
});
const database = postgres({
  host: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  database: requiredEnvironment("DATABASE_NAME"),
  username: "metaglasses_api",
  password: () => databaseSigner.getAuthToken(),
  ssl: "require",
  max: 5,
  connect_timeout: 10,
  idle_timeout: 20,
});

async function rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  try {
    const tokenHash = typeof parameters.p_token_hash === "string" ? parameters.p_token_hash : null;
    const ownerId = typeof parameters.p_owner_id === "string" ? parameters.p_owner_id : null;
    switch (name) {
      case "edge_api_set_state":
        return (await database`select app.set_state(${tokenHash}, ${ownerId}, ${parameters
          .p_state as string}, ${parameters.p_ttl_seconds as number}) as result`)[0].result as T;
      case "edge_api_pairing_access":
        return (await database`select app.pairing_access(${tokenHash}, ${ownerId}) as result`)[0]
          .result as T;
      case "edge_api_get_display":
        return await database`select * from app.get_display(${tokenHash})` as T;
      case "edge_api_get_images":
        return await database`select * from app.get_images(${tokenHash}, ${ownerId}, ${parameters
          .p_image_ids as string[]})` as T;
      case "edge_api_save_response":
        return await database`select * from app.save_response(${tokenHash}, ${ownerId}, ${parameters
          .p_response_id as string}, ${parameters.p_response_text as string}, ${parameters
          .p_ttl_seconds as number})` as T;
      case "edge_api_register_image":
        return (await database`select app.register_image(${tokenHash}, ${ownerId}, ${parameters
          .p_image_id as string}, ${parameters.p_object_path as string}, ${parameters
          .p_content_type as string}, ${parameters.p_byte_size as number}) as result`)[0]
          .result as T;
      case "edge_api_remove_image":
        return await database`select * from app.remove_image(${tokenHash}, ${ownerId}, ${parameters
          .p_image_id as string})` as T;
      case "edge_api_create_task_plan": {
        const sourceSteps = JSON.stringify(parameters.p_source_steps);
        return (await database`
          select app.create_task_plan(
            ${parameters.p_task_plan_id as string},
            ${tokenHash},
            ${ownerId},
            ${parameters.p_client_request_id as string},
            ${parameters.p_title as string},
            ${sourceSteps}::jsonb
          ) as result
        `)[0].result as T;
      }
      case "edge_api_get_task_plan": {
        return (await database`
          select app.task_plan_view(${parameters.p_task_plan_id as string}, ${ownerId}) as result
        `)[0].result as T;
      }
      case "edge_api_save_task_plan_validation": {
        const validationResult = JSON.stringify(parameters.p_validation_result);
        return (await database`
          select app.save_task_plan_validation(
            ${parameters.p_task_plan_id as string},
            ${ownerId},
            ${validationResult}::jsonb
          ) as result
        `)[0].result as T;
      }
      case "edge_api_approve_task_plan": {
        return (await database`
          select app.approve_task_plan(${parameters.p_task_plan_id as string}, ${ownerId}) as result
        `)[0].result as T;
      }
      case "edge_api_start_task_run": {
        return (await database`
          select app.start_task_run(
            ${parameters.p_task_run_id as string},
            ${parameters.p_task_plan_id as string},
            ${ownerId},
            ${parameters.p_client_request_id as string}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_get_task_run": {
        return (await database`
          select app.task_run_view(${parameters.p_task_run_id as string}, ${ownerId}) as result
        `)[0].result as T;
      }
      case "edge_api_apply_task_run_command": {
        return (await database`
          select app.apply_task_run_command(
            ${parameters.p_command_id as string},
            ${parameters.p_task_run_id as string},
            ${ownerId},
            ${parameters.p_client_request_id as string},
            ${parameters.p_command as string},
            ${parameters.p_expected_state_version as number}
          ) as result
        `)[0].result as T;
      }
      default:
        throw new Error(`Unsupported database operation: ${name}`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "Pairing storage unavailable.", false, "pairing_rpc_failed", {
      operation: name,
    });
  }
}

async function authenticate(request: Request): Promise<AuthenticatedUser> {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "Missing or invalid access token.", true);
  try {
    const payload = await verifier.verify(match[1].trim());
    if (typeof payload.sub !== "string" || !uuidPattern.test(payload.sub)) {
      throw new Error("invalid subject");
    }
    return { id: payload.sub };
  } catch (error) {
    throw new ApiError(401, "Missing or invalid access token.", true, "auth_rejected", {
      ...jwtVerificationFailureContext(error),
    });
  }
}

const tokenPattern = /^[0-9a-fA-F]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jwtVerificationErrorTypes = new Set([
  "FetchError",
  "JwksNotAvailableInCacheError",
  "JwksValidationError",
  "JwtExpiredError",
  "JwtInvalidClaimError",
  "JwtInvalidIssuerError",
  "JwtInvalidSignatureError",
  "JwtNotBeforeError",
  "JwtParseError",
  "KidNotFoundInJwksError",
]);
const pairingStates = new Set<PairingState>([
  "idle",
  "listening",
  "thinking",
  "speaking",
]);

function jwtVerificationFailureContext(error: unknown): Record<string, string> {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  const context: Record<string, string> = {
    auth_failure_type: jwtVerificationErrorTypes.has(errorType) ? errorType : "unknown",
    auth_failure_name: errorType.slice(0, 200),
  };
  if (error instanceof Error && error.message) {
    context.auth_failure_message = redactedErrorText(error.message).slice(0, 500);
  }
  return context;
}

function validateToken(value: unknown): string {
  if (typeof value !== "string" || !tokenPattern.test(value)) {
    throw new ApiError(
      422,
      "pairingToken must be a 32-character hexadecimal value.",
    );
  }
  return value;
}

function validateUuid(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(422, `${fieldName} must be a UUID.`);
  }
  return value;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const payload = await request.json();
    if (
      typeof payload !== "object" || payload === null || Array.isArray(payload)
    ) {
      throw new Error("not an object");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "Request body must be a JSON object.");
  }
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function setState(
  token: string,
  ownerId: string,
  state: PairingState,
): Promise<void> {
  const updated = await rpc<boolean>("edge_api_set_state", {
    p_token_hash: await tokenHash(token),
    p_owner_id: ownerId,
    p_state: state,
    p_ttl_seconds: pairingTtlSeconds,
  });
  if (!updated) {
    throw new ApiError(403, "This pairing token belongs to another user.");
  }
}

async function pairingAccess(token: string, ownerId: string): Promise<void> {
  const access = await rpc<"active" | "forbidden" | "not_found">(
    "edge_api_pairing_access",
    { p_token_hash: await tokenHash(token), p_owner_id: ownerId },
  );
  if (access === "forbidden") {
    throw new ApiError(403, "This pairing token belongs to another user.");
  }
  if (access !== "active") {
    throw new ApiError(
      401,
      "Unknown or expired pairing token. Re-pair on the phone.",
      true,
    );
  }
}

function validateMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(422, "messages must contain at least one item.");
  }
  return value.map((candidate) => {
    if (
      typeof candidate !== "object" || candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new ApiError(422, "Each message must be an object.");
    }
    const message = candidate as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ApiError(422, "Message role must be user or assistant.");
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new ApiError(422, "Message content must not be blank.");
    }
    const rawImageIds = message.imageIds ?? [];
    if (!Array.isArray(rawImageIds)) {
      throw new ApiError(422, "imageIds must be an array.");
    }
    const imageIds = rawImageIds.map((imageId) => validateUuid(imageId, "imageId"));
    if (message.role !== "user" && imageIds.length > 0) {
      throw new ApiError(
        422,
        "imageIds can only be attached to user messages.",
      );
    }
    return { role: message.role, content: message.content, imageIds };
  });
}

async function getImages(
  token: string,
  ownerId: string,
  imageIds: string[],
): Promise<StoredImage[]> {
  if (imageIds.length === 0) return [];
  await pairingAccess(token, ownerId);
  const rows = await rpc<StoredImage[]>("edge_api_get_images", {
    p_token_hash: await tokenHash(token),
    p_owner_id: ownerId,
    p_image_ids: imageIds,
  });
  const images = new Map(rows.map((image) => [image.image_id, image]));
  try {
    return imageIds.map((imageId) => {
      const image = images.get(imageId);
      if (!image) throw new Error("missing image");
      return image;
    });
  } catch {
    throw new ApiError(
      404,
      "One or more images do not belong to this active pairing.",
    );
  }
}

async function signedImageUrl(image: StoredImage): Promise<string> {
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: imageBucket(), Key: image.object_path }),
      { expiresIn: signedUrlTtlSeconds },
    );
  } catch {
    throw new ApiError(503, "Image storage unavailable.", false, "storage_sign_failed");
  }
}

let nvidiaApiKeyPromise: Promise<string> | undefined;

function nvidiaApiKey(): Promise<string> {
  nvidiaApiKeyPromise ??= (async () => {
    const secretArn = Deno.env.get("NVIDIA_SECRET_ARN")?.trim();
    if (!secretArn) return requiredEnvironment("NVIDIA_API_KEY");
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new ApiError(503, "NVIDIA credentials are unavailable.");
    try {
      const value = JSON.parse(response.SecretString) as { NVIDIA_API_KEY?: unknown };
      if (typeof value.NVIDIA_API_KEY === "string" && value.NVIDIA_API_KEY) {
        return value.NVIDIA_API_KEY;
      }
    } catch {
      return response.SecretString;
    }
    throw new ApiError(503, "NVIDIA credentials are unavailable.");
  })();
  return nvidiaApiKeyPromise;
}

function modelMessage(
  message: ConversationMessage,
  imageUrls: Map<string, ModelImageReference>,
): unknown {
  if (message.imageIds.length === 0) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...message.imageIds.map((imageId) => ({
        type: "image_url",
        image_url: { url: imageUrls.get(imageId)?.url },
      })),
    ],
  };
}

async function generateResponse(
  messages: ConversationMessage[],
  imageUrls: Map<string, ModelImageReference>,
  provider?: ExternalProviderConfig,
): Promise<string> {
  if (provider) {
    try {
      return await generateExternalResponse(
        provider,
        messages.map((message) => ({
          role: message.role,
          text: message.content,
          images: message.imageIds.map((imageId) => {
            const image = imageUrls.get(imageId);
            if (!image) throw new Error("missing image reference");
            return image;
          }),
        })),
      );
    } catch (error) {
      if (error instanceof ExternalProviderError) {
        throw new ApiError(error.status, error.message, false, error.code, error.context);
      }
      throw new ApiError(
        503,
        "The selected model provider request failed. Retry or select another provider.",
        false,
        "model_request_failed",
        {
          provider: provider.type,
          model: provider.model,
          failure_type: error instanceof Error ? error.name : "UnknownError",
          suggested_action: "Retry or select another provider.",
        },
      );
    }
  }
  const apiKey = await nvidiaApiKey();
  const baseUrl = (Deno.env.get("NVIDIA_BASE_URL") ?? defaultNvidiaBaseUrl)
    .replace(/\/$/, "");
  const model = Deno.env.get("NVIDIA_MODEL")?.trim() || defaultNvidiaModel;
  const models = [...new Set([model, defaultNvidiaFallbackModel, finalNvidiaFallbackModel])];
  const deadlineMilliseconds = Date.now() + nvidiaRequestTimeoutMilliseconds;
  let response: Response;
  let providerModel = model;
  let priorUpstreamStatuses: number[] = [];
  const requestModel = (requestedModel: string): Promise<Response> => {
    const remainingMilliseconds = deadlineMilliseconds - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new DOMException("NVIDIA request deadline exceeded.", "TimeoutError");
    }
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: messages.map((message) => modelMessage(message, imageUrls)),
        max_tokens: 160,
        stream: false,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(remainingMilliseconds),
    });
  };
  try {
    const result = await resolveNvidiaResponseWithFallbacks(await requestModel(models[0]), {
      apiKey,
      deadlineMilliseconds,
      fallbacks: models.slice(1).map((fallbackModel) => () => requestModel(fallbackModel)),
    });
    response = result.response;
    providerModel = models[result.fallbackCount];
    priorUpstreamStatuses = result.priorStatuses;
  } catch (error) {
    if (error instanceof NvidiaPendingResponseError) {
      throw new ApiError(
        503,
        "NVIDIA did not complete the model request. Retry shortly.",
        false,
        error.code,
        {
          ...error.context,
          provider: "nvidia",
          model: providerModel,
          suggested_action:
            "Retry shortly. If this continues, contact support with the request ID.",
        },
      );
    }
    throw new ApiError(
      503,
      "The NVIDIA request could not be completed. Retry shortly.",
      false,
      "model_request_failed",
      {
        provider: "nvidia",
        model: providerModel,
        failure_type: error instanceof Error ? error.name : "UnknownError",
        suggested_action: "Retry shortly. If this continues, contact support with the request ID.",
      },
    );
  }
  if (response.status === 429) {
    const context = await providerFailureContext(response);
    throw new ApiError(
      429,
      "NVIDIA rate-limited the request. Retry later.",
      false,
      "model_rate_limited",
      {
        ...context,
        provider: "nvidia",
        model: providerModel,
        suggested_action: "Retry later or check the NVIDIA account quota and billing.",
      },
    );
  }
  if (!response.ok) {
    const context = await providerFailureContext(response);
    context.provider = "nvidia";
    context.model = providerModel;
    context.suggested_action = response.status === 401 || response.status === 403
      ? "Update the deployment NVIDIA_API_KEY and verify its permissions."
      : response.status === 404
      ? "Verify that at least one configured NVIDIA fallback model is available."
      : "Retry shortly. If this continues, contact support with the request ID.";
    if (priorUpstreamStatuses.length > 0) {
      context.prior_upstream_statuses = priorUpstreamStatuses.join(",");
    }
    throw new ApiError(
      503,
      response.status === 401 || response.status === 403
        ? "NVIDIA rejected the deployment credentials."
        : response.status === 404
        ? "None of the configured NVIDIA models are available."
        : "NVIDIA is unavailable right now. Retry shortly.",
      false,
      "model_provider_error",
      context,
    );
  }
  try {
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("missing text");
    }
    return text.trim();
  } catch {
    throw new ApiError(
      503,
      "NVIDIA returned no usable text. Retry shortly.",
      false,
      "model_invalid_response",
      {
        upstream_status: response.status,
        provider: "nvidia",
        model: providerModel,
        suggested_action: "Retry shortly or select your own provider.",
      },
    );
  }
}

async function handleState(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const token = validateToken(payload.pairingToken);
  if (
    typeof payload.state !== "string" ||
    !pairingStates.has(payload.state as PairingState)
  ) {
    throw new ApiError(
      422,
      "state must be idle, listening, thinking, or speaking.",
    );
  }
  await setState(token, user.id, payload.state as PairingState);
  return emptyResponse(204);
}

async function handleDisplay(url: URL): Promise<Response> {
  const token = validateToken(url.searchParams.get("token"));
  const rows = await rpc<
    Array<{
      response_id: string | null;
      response_text: string | null;
      state: PairingState;
      response_created_at: string | null;
    }>
  >("edge_api_get_display", { p_token_hash: await tokenHash(token) });
  const display = rows[0];
  if (!display) {
    throw new ApiError(
      401,
      "Unknown or expired pairing token. Re-pair on the phone.",
      true,
    );
  }
  return jsonResponse({
    responseId: display.response_id,
    text: display.response_text,
    state: display.state,
    createdAt: display.response_created_at,
  });
}

async function handleChat(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const token = validateToken(payload.pairingToken);
  const messages = validateMessages(payload.messages);
  let provider: ExternalProviderConfig | undefined;
  try {
    provider = parseExternalProvider(payload.provider);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      throw new ApiError(
        422,
        error.message,
        false,
        "provider_configuration_invalid",
        { suggested_action: "Correct the provider configuration and retry." },
      );
    }
    throw error;
  }
  if (
    new TextEncoder().encode(JSON.stringify(messages)).byteLength >
      maxTranscriptBytes
  ) {
    throw new ApiError(
      413,
      "Transcript too large. Trim the oldest turns and retry.",
    );
  }
  await setState(token, user.id, "thinking");

  const imageIds = [
    ...new Set(messages.flatMap((message) => message.imageIds)),
  ];

  try {
    const images = await getImages(token, user.id, imageIds);
    const signedUrls = await Promise.all(
      images.map((image) => signedImageUrl(image)),
    );
    const imageUrls = new Map(
      images.map((image, index) => [
        image.image_id,
        {
          contentType: image.content_type as "image/jpeg" | "image/png",
          url: signedUrls[index],
        },
      ]),
    );
    const text = await generateResponse(messages, imageUrls, provider);
    const responseId = `r_${crypto.randomUUID().replaceAll("-", "")}`;
    const rows = await rpc<
      Array<{
        response_id: string;
        response_text: string;
        response_created_at: string;
      }>
    >("edge_api_save_response", {
      p_token_hash: await tokenHash(token),
      p_owner_id: user.id,
      p_response_id: responseId,
      p_response_text: text,
      p_ttl_seconds: pairingTtlSeconds,
    });
    const saved = rows[0];
    if (!saved) {
      throw new ApiError(403, "This pairing token belongs to another user.");
    }
    return jsonResponse({
      responseId: saved.response_id,
      text: saved.response_text,
      createdAt: saved.response_created_at,
    });
  } catch (error) {
    await setState(token, user.id, "idle").catch(() => undefined);
    throw error;
  }
}

function validatedImageType(
  contentType: string,
  bytes: Uint8Array,
): [string, string] {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = bytes.length >= pngSignature.length &&
    pngSignature.every((value, index) => bytes[index] === value);
  if (normalized === "image/jpeg" && jpeg) return [normalized, "jpg"];
  if (normalized === "image/png" && png) return [normalized, "png"];
  throw new ApiError(415, "Only valid JPEG and PNG images are supported.");
}

async function removeImageMetadata(
  token: string,
  ownerId: string,
  imageId: string,
): Promise<void> {
  await rpc<StoredImage[]>("edge_api_remove_image", {
    p_token_hash: await tokenHash(token),
    p_owner_id: ownerId,
    p_image_id: imageId,
  });
}

async function handleImageUpload(
  request: Request,
  url: URL,
): Promise<Response> {
  const user = await authenticate(request);
  const token = validateToken(url.searchParams.get("pairingToken"));
  await pairingAccess(token, user.id);
  const contentLength = request.headers.get("content-length");
  if (contentLength && !/^\d+$/.test(contentLength)) {
    throw new ApiError(400, "Invalid Content-Length header.");
  }
  if (contentLength && Number(contentLength) > maxImageBytes) {
    throw new ApiError(413, "Image too large.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) {
    throw new ApiError(400, "Image body must not be empty.");
  }
  if (bytes.length > maxImageBytes) throw new ApiError(413, "Image too large.");
  const [contentType, extension] = validatedImageType(
    request.headers.get("content-type") ?? "",
    bytes,
  );
  const imageId = crypto.randomUUID();
  const digest = await tokenHash(token);
  const objectPath = `${user.id}/${digest}/${imageId}.${extension}`;
  const registration = await rpc<"registered" | "forbidden" | "not_found">(
    "edge_api_register_image",
    {
      p_token_hash: digest,
      p_owner_id: user.id,
      p_image_id: imageId,
      p_object_path: objectPath,
      p_content_type: contentType,
      p_byte_size: bytes.length,
      // Retained as null for compatibility with the existing RPC signature.
      p_max_images: null,
    },
  );
  if (registration === "forbidden") {
    throw new ApiError(403, "This pairing token belongs to another user.");
  }
  if (registration !== "registered") {
    throw new ApiError(
      401,
      "Unknown or expired pairing token. Re-pair on the phone.",
      true,
    );
  }

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: imageBucket(),
        Key: objectPath,
        Body: bytes,
        ContentType: contentType,
        CacheControl: "max-age=0",
      }),
    );
  } catch {
    await removeImageMetadata(token, user.id, imageId).catch(() => undefined);
    throw new ApiError(503, "Image storage unavailable.", false, "storage_upload_failed");
  }
  return jsonResponse(
    {
      imageId,
      contentType,
      byteSize: bytes.length,
      createdAt: new Date().toISOString(),
    },
    201,
  );
}

async function handleImageDelete(
  request: Request,
  url: URL,
  imageId: string,
): Promise<Response> {
  const user = await authenticate(request);
  const token = validateToken(url.searchParams.get("pairingToken"));
  validateUuid(imageId, "imageId");
  await pairingAccess(token, user.id);
  const images = await getImages(token, user.id, [imageId]);
  const image = images[0];
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: imageBucket(), Key: image.object_path }));
  } catch {
    throw new ApiError(503, "Image storage unavailable.", false, "storage_delete_failed");
  }
  await removeImageMetadata(token, user.id, imageId);
  return emptyResponse(204);
}

type TaskPlan = Record<string, unknown>;
type TaskRun = Record<string, unknown>;
type TaskRunCommand =
  | "pause"
  | "resume"
  | "repeat"
  | "confirm"
  | "skip"
  | "back"
  | "correct"
  | "stop";

const taskRunCommands = new Set<TaskRunCommand>([
  "pause",
  "resume",
  "repeat",
  "confirm",
  "skip",
  "back",
  "correct",
  "stop",
]);

async function bedrockCredentials(): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}> {
  const credentials = await s3.config.credentials();
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new ApiError(
      503,
      "AWS model credentials are unavailable.",
      false,
      "model_credentials_unavailable",
    );
  }
  return credentials;
}

async function getTaskPlan(taskPlanId: string, ownerId: string): Promise<TaskPlan> {
  const plan = await rpc<TaskPlan | null>("edge_api_get_task_plan", {
    p_task_plan_id: taskPlanId,
    p_owner_id: ownerId,
  });
  if (!plan) throw new ApiError(404, "Task plan not found.", false, "task_plan_not_found");
  return plan;
}

async function getTaskRun(taskRunId: string, ownerId: string): Promise<TaskRun> {
  const taskRun = await rpc<TaskRun | null>("edge_api_get_task_run", {
    p_task_run_id: taskRunId,
    p_owner_id: ownerId,
  });
  if (!taskRun) throw new ApiError(404, "Task run not found.", false, "task_run_not_found");
  return taskRun;
}

function validateStateVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(422, "expectedStateVersion must be a positive integer.");
  }
  return value;
}

function validateTaskRunCommand(value: unknown): TaskRunCommand {
  if (typeof value !== "string" || !taskRunCommands.has(value as TaskRunCommand)) {
    throw new ApiError(422, "command is not supported.");
  }
  return value as TaskRunCommand;
}

function taskPlanInputError(error: unknown): never {
  if (error instanceof TaskPlanValidationError) {
    throw new ApiError(422, error.message, false, "task_plan_invalid", {
      suggested_action: "Correct the task plan and retry.",
    });
  }
  throw error;
}

async function handleTaskPlanCreate(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const token = validateToken(payload.pairingToken);
  const clientRequestId = validateUuid(payload.clientRequestId, "clientRequestId");
  let planInput;
  try {
    planInput = validateTaskPlanInput({ title: payload.title, steps: payload.steps });
  } catch (error) {
    return taskPlanInputError(error);
  }
  await pairingAccess(token, user.id);
  const plan = await rpc<TaskPlan | null>("edge_api_create_task_plan", {
    p_task_plan_id: crypto.randomUUID(),
    p_token_hash: await tokenHash(token),
    p_owner_id: user.id,
    p_client_request_id: clientRequestId,
    p_title: planInput.title,
    p_source_steps: planInput.steps,
  });
  if (!plan) {
    throw new ApiError(401, "Unknown or expired pairing token. Re-pair on the phone.", true);
  }
  if (plan.access === "forbidden") {
    throw new ApiError(403, "This pairing token belongs to another user.");
  }
  return jsonResponse(plan, 201);
}

async function handleTaskPlanValidation(request: Request, taskPlanId: string): Promise<Response> {
  const user = await authenticate(request);
  const plan = await getTaskPlan(taskPlanId, user.id);
  if (plan.status !== "draft") {
    throw new ApiError(
      409,
      "Only a draft task plan can be validated.",
      false,
      "task_plan_not_draft",
    );
  }
  const sourceSteps = plan.sourceSteps;
  if (!Array.isArray(sourceSteps)) {
    throw new ApiError(500, "Task plan storage is invalid.", false, "task_plan_storage_invalid");
  }
  let input;
  try {
    input = validateTaskPlanInput({ title: plan.title, steps: sourceSteps });
  } catch {
    throw new ApiError(500, "Task plan storage is invalid.", false, "task_plan_storage_invalid");
  }
  let validation;
  try {
    validation = await validateTaskPlanWithClaude(
      awsRegion(),
      await bedrockCredentials(),
      input,
    );
  } catch (error) {
    if (error instanceof TaskPlanValidationError) {
      throw new ApiError(
        503,
        "Task plan validation returned an unusable result. Retry shortly.",
        false,
        "plan_validation_invalid_response",
        { model: "us.anthropic.claude-haiku-5-5", suggested_action: "Retry shortly." },
      );
    }
    throw new ApiError(
      503,
      "Task plan validation is temporarily unavailable. Retry shortly.",
      false,
      "plan_validation_unavailable",
      {
        model: "us.anthropic.claude-haiku-5-5",
        failure_type: error instanceof Error ? error.name : "UnknownError",
        suggested_action: "Retry shortly.",
      },
    );
  }
  const saved = await rpc<string>("edge_api_save_task_plan_validation", {
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
    p_validation_result: validation,
  });
  if (saved !== "saved") {
    throw new ApiError(
      409,
      "Task plan changed before validation completed. Retry.",
      false,
      "task_plan_changed",
    );
  }
  return jsonResponse(await getTaskPlan(taskPlanId, user.id));
}

async function handleTaskPlanApprove(request: Request, taskPlanId: string): Promise<Response> {
  const user = await authenticate(request);
  await getTaskPlan(taskPlanId, user.id);
  const approved = await rpc<string>("edge_api_approve_task_plan", {
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
  });
  if (approved !== "approved") {
    throw new ApiError(
      409,
      "Task plan must have a review without open clarification questions before approval.",
      false,
      "task_plan_not_ready",
    );
  }
  return jsonResponse(await getTaskPlan(taskPlanId, user.id));
}

async function handleTaskRunStart(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const taskPlanId = validateUuid(payload.taskPlanId, "taskPlanId");
  const clientRequestId = validateUuid(payload.clientRequestId, "clientRequestId");
  const taskRun = await rpc<TaskPlan | null>("edge_api_start_task_run", {
    p_task_run_id: crypto.randomUUID(),
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
    p_client_request_id: clientRequestId,
  });
  if (!taskRun) {
    throw new ApiError(
      409,
      "Task plan must be approved and linked to an active pairing before starting.",
      false,
      "task_run_not_ready",
    );
  }
  return jsonResponse(taskRun, 201);
}

async function handleTaskRunCommand(
  request: Request,
  taskRunId: string,
  forcedCommand?: TaskRunCommand,
): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const command = forcedCommand ?? validateTaskRunCommand(payload.command);
  const result = await rpc<TaskRun>("edge_api_apply_task_run_command", {
    p_command_id: crypto.randomUUID(),
    p_task_run_id: taskRunId,
    p_owner_id: user.id,
    p_client_request_id: validateUuid(payload.clientRequestId, "clientRequestId"),
    p_command: command,
    p_expected_state_version: validateStateVersion(payload.expectedStateVersion),
  });
  const outcome = result.outcome;
  if (outcome === "not_found") {
    throw new ApiError(404, "Task run not found.", false, "task_run_not_found");
  }
  if (outcome === "stale") {
    throw new ApiError(409, "Task run state changed. Refresh and retry.", false, "task_run_stale", {
      state_version: typeof result.stateVersion === "number" ? result.stateVersion : 0,
    });
  }
  if (outcome === "command_limit") {
    throw new ApiError(429, "Task run command limit reached.", false, "task_run_command_limit");
  }
  if (outcome !== "applied") {
    throw new ApiError(
      409,
      "Command is not valid for the current task run state.",
      false,
      "task_run_invalid_transition",
    );
  }
  return jsonResponse(result);
}

function routePath(pathname: string): string {
  const functionPrefix = "/functions/v1/api";
  if (pathname.startsWith(functionPrefix)) {
    return pathname.slice(functionPrefix.length) || "/";
  }
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4);
  return pathname;
}

Deno.serve(async (request: Request) => {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  let path = "/";
  let response: Response;
  let requestError: unknown;

  try {
    const url = new URL(request.url);
    path = routePath(url.pathname);
    if (request.method === "OPTIONS") {
      response = emptyResponse(204);
    } else if (request.method === "GET" && path === "/healthz") {
      response = jsonResponse({
        status: "ok",
        environment: environmentName(),
        auth: "required",
      });
    } else if (request.method === "POST" && path === "/v1/state") {
      response = await handleState(request);
    } else if (request.method === "GET" && path === "/v1/display") {
      response = await handleDisplay(url);
    } else if (request.method === "POST" && path === "/v1/chat") {
      response = await handleChat(request);
    } else if (request.method === "POST" && path === "/v1/images") {
      response = await handleImageUpload(request, url);
    } else if (request.method === "POST" && path === "/v1/task-plans") {
      response = await handleTaskPlanCreate(request);
    } else if (request.method === "POST" && path === "/v1/task-runs") {
      response = await handleTaskRunStart(request);
    } else {
      const imageDelete = path.match(/^\/v1\/images\/([^/]+)$/);
      const taskPlan = path.match(/^\/v1\/task-plans\/([^/]+)$/);
      const taskPlanAction = path.match(/^\/v1\/task-plans\/([^/]+)\/(approve|validate)$/);
      const taskRun = path.match(/^\/v1\/task-runs\/([^/]+)$/);
      const taskRunAction = path.match(/^\/v1\/task-runs\/([^/]+)\/(commands|stop)$/);
      if (request.method === "DELETE" && imageDelete) {
        response = await handleImageDelete(request, url, imageDelete[1]);
      } else if (request.method === "GET" && taskPlan) {
        const user = await authenticate(request);
        response = jsonResponse(
          await getTaskPlan(validateUuid(taskPlan[1], "taskPlanId"), user.id),
        );
      } else if (request.method === "POST" && taskPlanAction?.[2] === "validate") {
        response = await handleTaskPlanValidation(
          request,
          validateUuid(taskPlanAction[1], "taskPlanId"),
        );
      } else if (request.method === "POST" && taskPlanAction?.[2] === "approve") {
        response = await handleTaskPlanApprove(
          request,
          validateUuid(taskPlanAction[1], "taskPlanId"),
        );
      } else if (request.method === "GET" && taskRun) {
        const user = await authenticate(request);
        response = jsonResponse(
          await getTaskRun(validateUuid(taskRun[1], "taskRunId"), user.id),
        );
      } else if (request.method === "POST" && taskRunAction?.[2] === "commands") {
        response = await handleTaskRunCommand(
          request,
          validateUuid(taskRunAction[1], "taskRunId"),
        );
      } else if (request.method === "POST" && taskRunAction?.[2] === "stop") {
        response = await handleTaskRunCommand(
          request,
          validateUuid(taskRunAction[1], "taskRunId"),
          "stop",
        );
      } else {
        throw new ApiError(404, "Not found.");
      }
    }
  } catch (error) {
    requestError = error;
    response = error instanceof ApiError
      ? errorResponse(error, requestId)
      : errorResponse(new ApiError(500, "Internal server error."), requestId);
  }

  requestLog(request, path, requestId, response.status, startedAt, requestError);
  return response.status === 101 ? response : responseWithRequestId(response, requestId);
});
