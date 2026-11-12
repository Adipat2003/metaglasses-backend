import { ApiError, errorResponse } from "./errors.ts";
import {
  createPlanWithModel,
  initialPlanRequest,
  TaskPlanCreationConflict,
} from "./task_plan_create.ts";
import { NvidiaPendingResponseError, resolveNvidiaResponseWithFallbacks } from "./nvidia.ts";
import { CognitoJwtVerifier } from "npm:aws-jwt-verify@5.2.1";
import { configuredCognitoClientIds } from "./cognito_clients.ts";
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
  signedBedrockRequest,
} from "./providers.ts";
import {
  parseModelJson,
  planValidatorModelId,
  refineTaskPlanWithModel,
  reviewTaskPlanForApprovalWithModel,
  TaskPlanProviderError,
  TaskPlanValidationError,
  validateTaskPlanFeedback,
  validateTaskPlanInput,
  validateTaskPlanRevisionHistory,
  validateTaskPlanWithModel,
} from "./task_plan.ts";

const pairingTtlSeconds = 3600;
const maxImageBytes = 8 * 1024 * 1024;
const signedUrlTtlSeconds = 10 * 60;
const maxTranscriptBytes = 256_000;
const defaultNvidiaBaseUrl = "https://integrate.api.nvidia.com/v1";
const defaultNvidiaModel = "meta/llama-3.2-90b-vision-instruct";
const defaultNvidiaFallbackModel = "meta/llama-3.2-11b-vision-instruct";
const finalNvidiaFallbackModel = "moonshotai/kimi-k3";
const taskObservationModelId = "us.amazon.nova-lite-v1:0";
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
  if (/^\/v1\/task-plans\/[^/]+\/(approve|refine|validate)$/.test(path)) {
    return "/v1/task-plans/:taskPlanId/:action";
  }
  if (/^\/v1\/task-runs\/[^/]+$/.test(path)) return "/v1/task-runs/:taskRunId";
  if (/^\/v1\/task-runs\/[^/]+\/(commands|stop)$/.test(path)) {
    return "/v1/task-runs/:taskRunId/:action";
  }
  if (/^\/v1\/task-runs\/[^/]+\/inference-windows$/.test(path)) {
    return "/v1/task-runs/:taskRunId/inference-windows";
  }
  return new Set([
      "/healthz",
      "/v1/state",
      "/v1/display",
      "/v1/chat",
      "/v1/images",
      "/v1/task-plans",
      "/v1/task-runs",
    ]).has(path)
    ? path
    : "unmatched";
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
      type: /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name) ? error.name : "Error",
      code: "unhandled_error",
      message: "Unexpected request failure.",
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

function providerFailureContext(
  response: Response,
): Record<string, string | number | boolean> {
  return { upstream_status: response.status };
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
export const verifier = CognitoJwtVerifier.create({
  userPoolId: requiredEnvironment("COGNITO_USER_POOL_ID"),
  clientId: configuredCognitoClientIds(
    requiredEnvironment("COGNITO_APP_CLIENT_ID"),
    Deno.env.get("COGNITO_ADDITIONAL_APP_CLIENT_IDS"),
  ),
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
        return (await database`
          select app.create_task_plan(
            ${parameters.p_task_plan_id as string},
            ${tokenHash},
            ${ownerId},
            ${parameters.p_client_request_id as string},
            ${parameters.p_title as string},
            ${database.json(parameters.p_source_steps as postgres.JSONValue)}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_get_task_plan": {
        return (await database`
          select app.task_plan_view(${parameters.p_task_plan_id as string}, ${ownerId}) as result
        `)[0].result as T;
      }
      case "edge_api_save_task_plan_validation": {
        return (await database`
          select app.save_task_plan_validation_for_version(
            ${parameters.p_task_plan_id as string},
            ${ownerId},
            ${parameters.p_expected_version as number},
            ${database.json(parameters.p_validation_result as postgres.JSONValue)}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_refine_task_plan": {
        return (await database`
          select app.refine_task_plan(
            ${parameters.p_task_plan_id as string},
            ${ownerId},
            ${parameters.p_expected_version as number},
            ${parameters.p_client_request_id as string},
            ${database.json(parameters.p_source_steps as postgres.JSONValue)},
            ${parameters.p_revision_request as string},
            ${parameters.p_revision_summary as string}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_approve_task_plan": {
        return (await database`
          select app.approve_task_plan(${parameters.p_task_plan_id as string}, ${ownerId}) as result
        `)[0].result as T;
      }
      case "edge_api_approve_task_plan_with_review": {
        return (await database`
          select app.approve_task_plan_with_review(
            ${parameters.p_task_plan_id as string},
            ${ownerId},
            ${parameters.p_expected_version as number},
            ${database.json(parameters.p_validation_result as postgres.JSONValue)}
          ) as result
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
      case "edge_api_create_task_inference_window": {
        return (await database`
          select app.create_task_inference_window(
            ${parameters.p_window_id as string},
            ${parameters.p_task_run_id as string},
            ${ownerId},
            ${parameters.p_client_request_id as string},
            ${parameters.p_sequence_number as number},
            ${parameters.p_observed_state_version as number},
            ${parameters.p_image_ids as string[]},
            ${database.json(parameters.p_captured_at as postgres.JSONValue)}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_claim_task_inference_window":
        return await database`select * from app.claim_task_inference_window()` as T;
      case "edge_api_complete_task_inference_window": {
        return (await database`
          select app.complete_task_inference_window(
            ${parameters.p_observation_id as string},
            ${parameters.p_inference_window_id as string},
            ${ownerId},
            ${parameters.p_model_id as string},
            ${database.json(parameters.p_observation as postgres.JSONValue)}
          ) as result
        `)[0].result as T;
      }
      case "edge_api_reject_task_inference_window":
        return (await database`
          select app.reject_task_inference_window(${parameters
          .p_inference_window_id as string}, ${ownerId}) as result
        `)[0].result as T;
      case "edge_api_publish_task_run_start":
        return (await database`
          select app.publish_task_run_start(${parameters
          .p_task_run_id as string}, ${ownerId}) as result
        `)[0].result as T;
      default:
        throw new Error(`Unsupported database operation: ${name}`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "Backend storage unavailable.", false, "pairing_rpc_failed", {
      operation: name,
    });
  }
}

async function authenticate(request: Request): Promise<AuthenticatedUser> {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "Missing or invalid access token.", true);
  try {
    const payload = await verifier.verify(match[1].trim());
    if (typeof payload.sub !== "string" || !cognitoSubjectPattern.test(payload.sub)) {
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
// Cognito subjects are 8-4-4-4-12 hex but do not always carry RFC 4122 version and variant bits.
const cognitoSubjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  };
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
        ...(error instanceof TaskPlanProviderError
          ? { upstream_status: error.upstreamStatus }
          : {}),
        suggested_action: "Retry shortly. If this continues, contact support with the request ID.",
      },
    );
  }
  if (response.status === 429) {
    const context = providerFailureContext(response);
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
    const context = providerFailureContext(response);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 9e15) {
    throw new ApiError(422, "expectedStateVersion must be a positive integer.");
  }
  return value;
}

interface InferenceFrame {
  imageId: string;
  capturedAt: string;
}

interface TaskInferenceClaim {
  inference_window_id: string;
  task_run_id: string;
  owner_id: string;
  token_hash: string;
  image_ids: string[];
  observed_state_version: number;
  current_step_ordinal: number;
  source_steps: Array<{ instruction?: unknown }>;
  validation_result: Record<string, unknown> | null;
}

interface TaskObservation {
  summary: string;
  proposedTransition: "remain_in_progress" | "candidate_complete" | "blocked";
  confidence: number;
  evidenceFrameIndexes: number[];
}

let inferenceWorkerRunning = false;

function base64Encode(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index < bytes.length; index += 32_768) {
    value += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(value);
}

function taskObservationText(payload: unknown): string {
  const text = (payload as {
    output?: { message?: { content?: Array<{ text?: unknown }> } };
  }).output?.message?.content?.find((content) => typeof content.text === "string")?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("Nova returned no observation.");
  return text.trim();
}

function validateTaskObservation(value: unknown, frameCount: number): TaskObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Nova returned an invalid observation.");
  }
  const candidate = value as Record<string, unknown>;
  const summary = typeof candidate.summary === "string"
    ? candidate.summary.normalize("NFKC").trim().replace(/\s+/g, " ")
    : "";
  const proposedTransition = candidate.proposedTransition;
  const confidence = candidate.confidence;
  const evidenceFrameIndexes = candidate.evidenceFrameIndexes;
  if (
    !summary || summary.length > 300 ||
    (proposedTransition !== "remain_in_progress" && proposedTransition !== "candidate_complete" &&
      proposedTransition !== "blocked") ||
    typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 ||
    confidence > 1 ||
    !Array.isArray(evidenceFrameIndexes) || evidenceFrameIndexes.length === 0 ||
    evidenceFrameIndexes.length > frameCount ||
    evidenceFrameIndexes.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= frameCount
    ) ||
    new Set(evidenceFrameIndexes).size !== evidenceFrameIndexes.length
  ) {
    throw new Error("Nova returned an invalid observation.");
  }
  return { summary, proposedTransition, confidence, evidenceFrameIndexes };
}

async function observeTaskInferenceWindow(claim: TaskInferenceClaim): Promise<TaskObservation> {
  const images = await rpc<StoredImage[]>("edge_api_get_images", {
    p_token_hash: claim.token_hash,
    p_owner_id: claim.owner_id,
    p_image_ids: claim.image_ids,
  });
  if (images.length !== claim.image_ids.length) {
    throw new Error("Inference images are unavailable.");
  }
  const imagesById = new Map(images.map((image) => [image.image_id, image]));
  const orderedImages = claim.image_ids.map((imageId) => imagesById.get(imageId));
  if (orderedImages.some((image) => !image)) throw new Error("Inference images are unavailable.");
  const bytes = await Promise.all(
    orderedImages.map(async (image) => {
      const response = await fetch(await signedImageUrl(image as StoredImage));
      if (!response.ok) throw new Error("Inference image read failed.");
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const sourceStep = claim.source_steps[claim.current_step_ordinal - 1];
  const instruction = typeof sourceStep?.instruction === "string" ? sourceStep.instruction : null;
  if (!instruction) throw new Error("Task run step is invalid.");
  const criteria = Array.isArray(claim.validation_result?.steps)
    ? (claim.validation_result.steps[claim.current_step_ordinal - 1] as
      | Record<string, unknown>
      | undefined)?.visualAcceptanceCriteria
    : [];
  const request = await signedBedrockRequest(
    {
      type: "aws-bedrock",
      ...await bedrockCredentials(),
      region: awsRegion(),
      model: taskObservationModelId,
    },
    JSON.stringify({
      system: [{
        text:
          "You observe frames for one existing task step. Return one flat JSON object and nothing else, with exactly these keys: summary (string, at most 300 characters), proposedTransition (remain_in_progress, candidate_complete, or blocked), confidence (number from 0 to 1), evidenceFrameIndexes (array with at least one zero-based frame index, even when the step is not visible). Do not repeat the input, give instructions, add steps, or claim completion.",
      }],
      messages: [{
        role: "user",
        content: [
          {
            text: JSON.stringify({
              instruction,
              visualAcceptanceCriteria: criteria,
            }),
          },
          ...orderedImages.map((image, index) => ({
            image: {
              format: image?.content_type === "image/png" ? "png" : "jpeg",
              source: { bytes: base64Encode(bytes[index]) },
            },
          })),
        ],
      }],
      inferenceConfig: { maxTokens: 320, temperature: 0 },
    }),
  );
  const response = await fetch(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new TaskPlanProviderError(response.status);
  }
  return validateTaskObservation(
    parseModelJson(taskObservationText(await response.json())),
    bytes.length,
  );
}

export function logInference(level: "info" | "error", entry: Record<string, unknown>): void {
  try {
    console[level](JSON.stringify(entry));
  } catch {
    // Logging must not change the job outcome.
  }
}

async function processTaskInferenceWindow(): Promise<void> {
  if (inferenceWorkerRunning) return;
  inferenceWorkerRunning = true;
  let claim: TaskInferenceClaim | undefined;
  try {
    const claims = await rpc<TaskInferenceClaim[]>("edge_api_claim_task_inference_window", {});
    claim = claims[0];
    if (!claim) return;
    logInference("info", {
      event: "task_inference_started",
      request_id: claim.inference_window_id,
      task_run_id: claim.task_run_id,
      inference_window_id: claim.inference_window_id,
      model: taskObservationModelId,
    });
    const observation = await observeTaskInferenceWindow(claim);
    const outcome = await rpc<string>("edge_api_complete_task_inference_window", {
      p_observation_id: crypto.randomUUID(),
      p_inference_window_id: claim.inference_window_id,
      p_owner_id: claim.owner_id,
      p_model_id: taskObservationModelId,
      p_observation: observation,
    });
    logInference("info", {
      event: "task_inference_completed",
      request_id: claim.inference_window_id,
      task_run_id: claim.task_run_id,
      inference_window_id: claim.inference_window_id,
      model: taskObservationModelId,
      outcome,
    });
  } catch (error) {
    if (claim) {
      await rpc<boolean>("edge_api_reject_task_inference_window", {
        p_inference_window_id: claim.inference_window_id,
        p_owner_id: claim.owner_id,
      }).catch(() => {
        logInference("error", {
          event: "task_inference_rejection_failed",
          request_id: claim?.inference_window_id,
          error_code: "task_inference_rejection_failed",
        });
      });
    }
    logInference("error", {
      event: "task_inference_failed",
      request_id: claim?.inference_window_id,
      inference_window_id: claim?.inference_window_id,
      model: taskObservationModelId,
      failure_type: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof TaskPlanProviderError ? { upstream_status: error.upstreamStatus } : {}),
    });
  } finally {
    inferenceWorkerRunning = false;
  }
}

function validateInferenceFrames(value: unknown): InferenceFrame[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new ApiError(422, "frames must contain one to three images.");
  }
  const now = Date.now();
  const frames = value.map((rawFrame, index) => {
    if (typeof rawFrame !== "object" || rawFrame === null || Array.isArray(rawFrame)) {
      throw new ApiError(422, `frames[${index}] must be an object.`);
    }
    const frame = rawFrame as Record<string, unknown>;
    const imageId = validateUuid(frame.imageId, `frames[${index}].imageId`);
    if (typeof frame.capturedAt !== "string") {
      throw new ApiError(422, `frames[${index}].capturedAt must be an ISO timestamp.`);
    }
    const capturedAt = new Date(frame.capturedAt);
    if (
      Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== frame.capturedAt ||
      capturedAt.getTime() < now - 30_000 || capturedAt.getTime() > now + 5_000
    ) {
      throw new ApiError(422, `frames[${index}].capturedAt is outside the allowed window.`);
    }
    return { imageId, capturedAt: frame.capturedAt };
  });
  if (new Set(frames.map((frame) => frame.imageId)).size !== frames.length) {
    throw new ApiError(422, "frames must not repeat an image.");
  }
  if (
    frames.some(
      (frame, index) => index > 0 && frame.capturedAt <= frames[index - 1].capturedAt,
    )
  ) {
    throw new ApiError(422, "frames must be ordered by capturedAt.");
  }
  return frames;
}

function validateSequenceNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 9e15) {
    throw new ApiError(422, "sequenceNumber must be a positive integer.");
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

async function taskPlanModelStage<T>(
  requestId: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let failure: unknown;
  try {
    return await action();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      const entry = {
        event: "task_plan_model_completed",
        request_id: requestId,
        operation,
        environment: requestEnvironment(),
        provider: "bedrock",
        model: planValidatorModelId,
        outcome: failure ? "failure" : "success",
        duration_ms: Math.round(performance.now() - started),
        ...(failure
          ? {
            error_code: failure instanceof TaskPlanValidationError
              ? "invalid_model_response"
              : "model_request_failed",
            failure_type: failure instanceof Error ? failure.name : "UnknownError",
            ...(failure instanceof TaskPlanValidationError
              ? { model_failure_reason: failure.reason }
              : {}),
            ...(failure instanceof TaskPlanProviderError
              ? { upstream_status: failure.upstreamStatus }
              : {}),
          }
          : {}),
      };
      if (failure) console.error(JSON.stringify(entry));
      else console.info(JSON.stringify(entry));
    } catch {
      // Logging must not change the response.
    }
  }
}

async function handleTaskPlanCreate(request: Request, requestId: string): Promise<Response> {
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
  let plan: TaskPlan;
  try {
    plan = await createPlanWithModel(planInput, clientRequestId, {
      createDraft: async () => {
        const draft = await rpc<TaskPlan | null>("edge_api_create_task_plan", {
          p_task_plan_id: crypto.randomUUID(),
          p_token_hash: await tokenHash(token),
          p_owner_id: user.id,
          p_client_request_id: clientRequestId,
          p_title: planInput.title,
          p_source_steps: planInput.steps,
        });
        if (!draft) {
          throw new ApiError(401, "Unknown or expired pairing token. Re-pair on the phone.", true);
        }
        return draft;
      },
      generate: async (input) => {
        try {
          return await taskPlanModelStage(
            requestId,
            "create",
            async () =>
              await refineTaskPlanWithModel(
                awsRegion(),
                await bedrockCredentials(),
                input,
                [],
                initialPlanRequest,
                null,
                true,
              ),
          );
        } catch (error) {
          if (error instanceof TaskPlanValidationError) {
            throw new ApiError(
              503,
              "Plan creation returned an unusable proposal.",
              false,
              "plan_creation_invalid_response",
              {
                model: planValidatorModelId,
                suggested_action: "Retry with the same clientRequestId.",
              },
            );
          }
          throw new ApiError(
            503,
            "Plan creation is temporarily unavailable.",
            false,
            "plan_creation_unavailable",
            {
              model: planValidatorModelId,
              failure_type: error instanceof Error ? error.name : "UnknownError",
              ...(error instanceof TaskPlanProviderError
                ? { upstream_status: error.upstreamStatus }
                : {}),
              suggested_action: "Retry with the same clientRequestId.",
            },
          );
        }
      },
      save: (planId, requestId, proposal) =>
        rpc<string>("edge_api_refine_task_plan", {
          p_task_plan_id: planId,
          p_owner_id: user.id,
          p_expected_version: 1,
          p_client_request_id: requestId,
          p_source_steps: proposal.steps,
          p_revision_request: initialPlanRequest,
          p_revision_summary: proposal.summary,
        }),
      read: (planId) => getTaskPlan(planId, user.id),
    });
  } catch (error) {
    if (!(error instanceof TaskPlanCreationConflict)) throw error;
    throw new ApiError(
      409,
      "The plan changed during creation. Read it and retry.",
      false,
      "task_plan_changed",
      { suggested_action: "Retry with the same clientRequestId." },
    );
  }
  if (plan.access === "forbidden") {
    throw new ApiError(403, "This pairing token belongs to another user.");
  }
  if (plan.access === "idempotency_conflict") {
    throw new ApiError(
      409,
      "clientRequestId was already used for a different plan.",
      false,
      "task_plan_idempotency_conflict",
    );
  }
  return jsonResponse(plan, 201);
}

async function handleTaskPlanValidation(
  request: Request,
  taskPlanId: string,
  requestId: string,
): Promise<Response> {
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
  if (!Array.isArray(sourceSteps) || typeof plan.currentVersion !== "number") {
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
    validation = await taskPlanModelStage(
      requestId,
      "validate",
      async () => await validateTaskPlanWithModel(awsRegion(), await bedrockCredentials(), input),
    );
  } catch (error) {
    if (error instanceof TaskPlanValidationError) {
      throw new ApiError(
        503,
        "Task plan validation returned an unusable result. Retry shortly.",
        false,
        "plan_validation_invalid_response",
        { model: planValidatorModelId, suggested_action: "Retry shortly." },
      );
    }
    throw new ApiError(
      503,
      "Task plan validation is temporarily unavailable. Retry shortly.",
      false,
      "plan_validation_unavailable",
      {
        model: planValidatorModelId,
        failure_type: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof TaskPlanProviderError
          ? { upstream_status: error.upstreamStatus }
          : {}),
        suggested_action: "Retry shortly.",
      },
    );
  }
  const saved = await rpc<string>("edge_api_save_task_plan_validation", {
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
    p_expected_version: plan.currentVersion,
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

function validateTaskPlanVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(422, "expectedVersion must be a positive integer.");
  }
  return value as number;
}

async function handleTaskPlanRefinement(
  request: Request,
  taskPlanId: string,
  requestId: string,
): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const clientRequestId = validateUuid(payload.clientRequestId, "clientRequestId");
  const expectedVersion = validateTaskPlanVersion(payload.expectedVersion);
  let feedback: string;
  try {
    feedback = validateTaskPlanFeedback(payload.message);
  } catch (error) {
    return taskPlanInputError(error);
  }

  const plan = await getTaskPlan(taskPlanId, user.id);
  let history;
  try {
    history = validateTaskPlanRevisionHistory(plan.revisionHistory);
  } catch {
    throw new ApiError(
      500,
      "Task plan revision history is invalid.",
      false,
      "task_plan_storage_invalid",
    );
  }
  const duplicate = history.find((turn) => turn.clientRequestId === clientRequestId);
  if (duplicate) {
    if (duplicate.request !== feedback) {
      throw new ApiError(
        409,
        "clientRequestId was already used for a different plan change.",
        false,
        "task_plan_idempotency_conflict",
      );
    }
    return jsonResponse(plan);
  }
  if (plan.currentVersion !== expectedVersion) {
    throw new ApiError(
      409,
      "Task plan changed. Read it again and retry.",
      false,
      "task_plan_stale",
    );
  }
  if (plan.status !== "draft" && plan.status !== "awaiting_approval") {
    throw new ApiError(
      409,
      "Only a draft or reviewed plan with no task run can be refined.",
      false,
      "task_plan_not_refinable",
    );
  }

  let input;
  try {
    if (!Array.isArray(plan.sourceSteps)) {
      throw new TaskPlanValidationError("Invalid source steps.");
    }
    input = validateTaskPlanInput({ title: plan.title, steps: plan.sourceSteps });
  } catch {
    throw new ApiError(500, "Task plan storage is invalid.", false, "task_plan_storage_invalid");
  }

  let refinement;
  try {
    refinement = await taskPlanModelStage(
      requestId,
      "refine",
      async () =>
        await refineTaskPlanWithModel(
          awsRegion(),
          await bedrockCredentials(),
          input,
          history,
          feedback,
          plan.validation,
        ),
    );
  } catch (error) {
    if (error instanceof TaskPlanValidationError) {
      throw new ApiError(
        503,
        "Plan refinement returned an unusable proposal.",
        false,
        "plan_refinement_invalid_response",
        { model: planValidatorModelId, suggested_action: "Rephrase the change and retry." },
      );
    }
    throw new ApiError(
      503,
      "Plan refinement is temporarily unavailable.",
      false,
      "plan_refinement_unavailable",
      {
        model: planValidatorModelId,
        failure_type: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof TaskPlanProviderError
          ? { upstream_status: error.upstreamStatus }
          : {}),
        suggested_action: "Retry shortly with the same clientRequestId.",
      },
    );
  }

  const result = await rpc<string>("edge_api_refine_task_plan", {
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
    p_expected_version: expectedVersion,
    p_client_request_id: clientRequestId,
    p_source_steps: refinement.steps,
    p_revision_request: feedback,
    p_revision_summary: refinement.summary,
  });
  if (result === "already_applied") return jsonResponse(await getTaskPlan(taskPlanId, user.id));
  if (result === "not_found") {
    throw new ApiError(404, "Task plan not found.", false, "task_plan_not_found");
  }
  if (result === "stale") {
    throw new ApiError(
      409,
      "Task plan changed. Read it again and retry.",
      false,
      "task_plan_stale",
    );
  }
  if (result === "not_refinable") {
    throw new ApiError(
      409,
      "This task plan can no longer be refined.",
      false,
      "task_plan_not_refinable",
    );
  }
  if (result === "has_runs") {
    throw new ApiError(
      409,
      "A task run already exists for this plan.",
      false,
      "task_plan_has_runs",
    );
  }
  if (result === "revision_limit") {
    throw new ApiError(
      409,
      "This plan reached its refinement limit.",
      false,
      "task_plan_revision_limit",
    );
  }
  if (result === "idempotency_conflict") {
    throw new ApiError(
      409,
      "clientRequestId was already used for a different plan change.",
      false,
      "task_plan_idempotency_conflict",
    );
  }
  if (result !== "saved") {
    throw new ApiError(500, "Plan refinement could not be saved.", false, "task_plan_save_failed");
  }
  return jsonResponse(await getTaskPlan(taskPlanId, user.id));
}

async function handleTaskPlanApprove(
  request: Request,
  taskPlanId: string,
  requestId: string,
): Promise<Response> {
  const user = await authenticate(request);
  const plan = await getTaskPlan(taskPlanId, user.id);
  if (plan.status === "approved") return jsonResponse(plan);
  if (plan.status !== "draft" && plan.status !== "awaiting_approval") {
    throw new ApiError(
      409,
      "This task plan cannot be approved.",
      false,
      "task_plan_not_approvable",
    );
  }
  if (!Array.isArray(plan.sourceSteps) || typeof plan.currentVersion !== "number") {
    throw new ApiError(500, "Task plan storage is invalid.", false, "task_plan_storage_invalid");
  }
  let input;
  try {
    input = validateTaskPlanInput({ title: plan.title, steps: plan.sourceSteps });
  } catch {
    throw new ApiError(500, "Task plan storage is invalid.", false, "task_plan_storage_invalid");
  }
  let review;
  try {
    review = await taskPlanModelStage(
      requestId,
      "approve",
      async () =>
        await reviewTaskPlanForApprovalWithModel(awsRegion(), await bedrockCredentials(), input),
    );
  } catch (error) {
    if (error instanceof TaskPlanValidationError) {
      throw new ApiError(
        503,
        "The approval review returned an unusable result. Retry shortly.",
        false,
        "plan_approval_review_invalid_response",
        { model: planValidatorModelId, suggested_action: "Retry shortly." },
      );
    }
    throw new ApiError(
      503,
      "The approval review is temporarily unavailable. Retry shortly.",
      false,
      "plan_approval_review_unavailable",
      {
        model: planValidatorModelId,
        failure_type: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof TaskPlanProviderError
          ? { upstream_status: error.upstreamStatus }
          : {}),
        suggested_action: "Retry shortly.",
      },
    );
  }
  const approved = await rpc<string>("edge_api_approve_task_plan_with_review", {
    p_task_plan_id: taskPlanId,
    p_owner_id: user.id,
    p_expected_version: plan.currentVersion,
    p_validation_result: review,
  });
  if (approved === "guidelines_failed") {
    throw new ApiError(
      409,
      "The plan did not pass its approval review. Resolve the blockers and try again.",
      false,
      "task_plan_guidelines_failed",
      {
        approval_blocker_count: review.approvalBlockers.length,
        suggested_action: "Read the task plan for its review, refine it, then retry approval.",
      },
    );
  }
  if (approved === "stale") {
    throw new ApiError(
      409,
      "Task plan changed during approval review. Retry.",
      false,
      "task_plan_stale",
    );
  }
  if (approved === "has_runs") {
    throw new ApiError(
      409,
      "A task run already exists for this plan.",
      false,
      "task_plan_has_runs",
    );
  }
  if (approved === "not_found") {
    throw new ApiError(404, "Task plan not found.", false, "task_plan_not_found");
  }
  if (approved === "not_approvable") {
    throw new ApiError(
      409,
      "This task plan cannot be approved.",
      false,
      "task_plan_not_approvable",
    );
  }
  if (approved !== "approved") {
    throw new ApiError(
      500,
      "Plan approval could not be saved.",
      false,
      "task_plan_approval_failed",
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
  if (typeof taskRun.taskRunId !== "string") {
    throw new ApiError(500, "Task run storage is invalid.", false, "task_run_storage_invalid");
  }
  await rpc<boolean>("edge_api_publish_task_run_start", {
    p_task_run_id: taskRun.taskRunId,
    p_owner_id: user.id,
  });
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

async function handleInferenceWindow(request: Request, taskRunId: string): Promise<Response> {
  const user = await authenticate(request);
  const payload = await requestJson(request);
  const frames = validateInferenceFrames(payload.frames);
  const result = await rpc<TaskRun>("edge_api_create_task_inference_window", {
    p_window_id: crypto.randomUUID(),
    p_task_run_id: taskRunId,
    p_owner_id: user.id,
    p_client_request_id: validateUuid(payload.clientRequestId, "clientRequestId"),
    p_sequence_number: validateSequenceNumber(payload.sequenceNumber),
    p_observed_state_version: validateStateVersion(payload.expectedStateVersion),
    p_image_ids: frames.map((frame) => frame.imageId),
    p_captured_at: frames.map((frame) => frame.capturedAt),
  });
  if (result.outcome === "not_found") {
    throw new ApiError(404, "Task run not found.", false, "task_run_not_found");
  }
  if (result.outcome === "stale") {
    throw new ApiError(409, "Task run state changed. Refresh and retry.", false, "task_run_stale", {
      state_version: typeof result.stateVersion === "number" ? result.stateVersion : 0,
    });
  }
  if (result.outcome === "out_of_order") {
    throw new ApiError(
      409,
      "Inference window sequence is out of order.",
      false,
      "window_out_of_order",
    );
  }
  if (result.outcome === "invalid_media") {
    throw new ApiError(
      422,
      "Frames must belong to this active pairing.",
      false,
      "window_media_invalid",
    );
  }
  if (result.outcome !== "accepted") {
    throw new ApiError(
      409,
      "Task run is not accepting inference windows.",
      false,
      "task_run_not_active",
    );
  }
  return jsonResponse(result, 202);
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

if (Deno.env.get("APP_ENV") === "aws") {
  void processTaskInferenceWindow();
  setInterval(() => void processTaskInferenceWindow(), 2_000);
}

export async function handleApiRequest(request: Request): Promise<Response> {
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
      response = await handleTaskPlanCreate(request, requestId);
    } else if (request.method === "POST" && path === "/v1/task-runs") {
      response = await handleTaskRunStart(request);
    } else {
      const imageDelete = path.match(/^\/v1\/images\/([^/]+)$/);
      const taskPlan = path.match(/^\/v1\/task-plans\/([^/]+)$/);
      const taskPlanAction = path.match(/^\/v1\/task-plans\/([^/]+)\/(approve|refine|validate)$/);
      const taskRun = path.match(/^\/v1\/task-runs\/([^/]+)$/);
      const taskRunAction = path.match(/^\/v1\/task-runs\/([^/]+)\/(commands|stop)$/);
      const inferenceWindow = path.match(/^\/v1\/task-runs\/([^/]+)\/inference-windows$/);
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
          requestId,
        );
      } else if (request.method === "POST" && taskPlanAction?.[2] === "refine") {
        response = await handleTaskPlanRefinement(
          request,
          validateUuid(taskPlanAction[1], "taskPlanId"),
          requestId,
        );
      } else if (request.method === "POST" && taskPlanAction?.[2] === "approve") {
        response = await handleTaskPlanApprove(
          request,
          validateUuid(taskPlanAction[1], "taskPlanId"),
          requestId,
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
      } else if (request.method === "POST" && inferenceWindow) {
        response = await handleInferenceWindow(
          request,
          validateUuid(inferenceWindow[1], "taskRunId"),
        );
      } else {
        throw new ApiError(404, "Not found.");
      }
    }
  } catch (error) {
    requestError = error;
    response = errorResponse(error, requestId, corsHeaders);
  }

  try {
    requestLog(request, path, requestId, response.status, startedAt, requestError);
  } catch {
    // Logging must not change the response.
  }
  return response.status === 101 ? response : responseWithRequestId(response, requestId);
}

if (import.meta.main) Deno.serve(handleApiRequest);
