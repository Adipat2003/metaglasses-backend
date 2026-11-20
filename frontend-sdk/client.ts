import type { operations, paths } from "./api-types.js";

type ApiPath = keyof paths;
type ApiMethod<P extends ApiPath> = Uppercase<Extract<keyof paths[P], "get" | "post" | "delete">>;
type OperationAt<P extends ApiPath, M extends ApiMethod<P>> =
  paths[P][Lowercase<M> & keyof paths[P]];

type JsonContent<T> = T extends { content: { "application/json": infer S } } ? S : never;
type InputOf<T> = T extends { requestBody?: infer B } ? JsonContent<B> : never;
type OutputOf<T> = T extends { responses: infer R } ? {
    [S in keyof R]: S extends string | number
      ? `${S}` extends `2${string}`
        ? JsonContent<R[S]> extends never ? undefined : JsonContent<R[S]>
      : never
      : never;
  }[keyof R]
  : never;

export type HealthResponse = OutputOf<operations["getHealth"]>;
export type PairingStateInput = InputOf<operations["setPairingState"]>;
export type DisplayResponse = OutputOf<operations["getDisplay"]>;
export type ChatInput = InputOf<operations["createChatResponse"]>;
export type ChatResponse = OutputOf<operations["createChatResponse"]>;
export type ImageUploadResponse = OutputOf<operations["uploadPairingImage"]>;
export type TaskPlanPage = OutputOf<operations["listTaskPlans"]>;
export type CreateTaskPlanInput = InputOf<operations["createTaskPlan"]>;
export type TaskPlan = OutputOf<operations["createTaskPlan"]>;
export type RefineTaskPlanInput = InputOf<operations["refineTaskPlan"]>;
export type ApproveTaskPlanInput = InputOf<operations["approveTaskPlan"]>;
export type TaskRun = OutputOf<operations["startTaskRun"]>;
export type TaskRunPage = OutputOf<operations["listUnfinishedTaskRuns"]>;
export type TaskRunCommandInput = InputOf<operations["commandTaskRun"]>;
export type TaskRunCommandResult = OutputOf<operations["commandTaskRun"]>;
export type StopTaskRunInput = InputOf<operations["stopTaskRun"]>;
export type InferenceWindowInput = InputOf<operations["submitInferenceWindow"]>;
export type InferenceWindowResponse = OutputOf<operations["submitInferenceWindow"]>;
export type InferenceWindow = OutputOf<operations["getInferenceWindow"]>;
export type TaskPlanStatus = NonNullable<
  operations["listTaskPlans"]["parameters"]["query"]
>["status"];
export type TaskRunCommand = NonNullable<TaskRunCommandInput>["command"];
type CoveredOperations =
  | "getHealth"
  | "setPairingState"
  | "getDisplay"
  | "createChatResponse"
  | "uploadPairingImage"
  | "deletePairingImage"
  | "listTaskPlans"
  | "createTaskPlan"
  | "getTaskPlan"
  | "refineTaskPlan"
  | "validateTaskPlan"
  | "approveTaskPlan"
  | "startTaskRun"
  | "listUnfinishedTaskRuns"
  | "getTaskRun"
  | "commandTaskRun"
  | "stopTaskRun"
  | "submitInferenceWindow"
  | "getInferenceWindow";
type UnimplementedOperation = Exclude<keyof operations, CoveredOperations>;
const allOperationsImplemented: UnimplementedOperation extends never ? true : never = true;
void allOperationsImplemented;

export interface ClientOptions {
  /** Absolute API origin or base path, supplied by the consuming application. */
  baseUrl: string;
  /** Cognito access token. Required for protected calls; never persisted by this client. */
  accessToken?: string;
  /** Inject a fetch implementation for application networking or deterministic checks. */
  fetch?: typeof fetch;
  /** @deprecated Frame freshness and replay are decided by the server. */
  now?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ImageScopeOptions extends CallOptions {
  /** Omit for owner-only Talk media. */
  taskRunId?: string;
}

export interface ImageUploadOptions extends ImageScopeOptions {
  clientImageId?: string;
}

export type ApprovalOptions =
  & CallOptions
  & (
    | ApproveTaskPlanInput
    | { expectedVersion?: never; clientRequestId?: never }
  );

export class SdkValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "SdkValidationError";
  }
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
    readonly context: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ApiTransportError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "ApiTransportError";
  }
}

export class ApiTimeoutError extends Error {
  constructor() {
    super("The API request timed out.");
    this.name = "ApiTimeoutError";
  }
}

export class ApiProtocolError extends Error {
  constructor(readonly status: number, readonly requestId: string | null) {
    super("The API returned a successful response with an invalid body.");
    this.name = "ApiProtocolError";
  }
}

export interface MetaGlassesClient {
  /** Public process health check. It does not require authentication or check dependencies. */
  getHealth(options?: CallOptions): Promise<HealthResponse>;
  /** Requires the caller's Cognito token and a valid pairing token. Refreshes its one-hour lifetime. */
  setPairingState(input: PairingStateInput, options?: CallOptions): Promise<void>;
  /** Requires a live pairing token. Polling reads only the latest display and does not refresh the pairing. */
  getDisplay(pairingToken: string, options?: CallOptions): Promise<DisplayResponse>;
  /** Phone Talk uses a stable clientRequestId. Legacy paired chat uses pairingToken and publishes to the lens. */
  createChatResponse(input: ChatInput, options?: CallOptions): Promise<ChatResponse>;
  /** Requires an active pairing owned by the caller and a valid JPEG or PNG Blob up to 8 MiB. */
  uploadPairingImage(
    pairingToken: string,
    image: Blob,
    options?: CallOptions & { clientImageId?: string },
  ): Promise<ImageUploadResponse>;
  /** Requires an active pairing owned by the caller and an image uploaded to that pairing. */
  deletePairingImage(
    imageId: string,
    pairingToken: string,
    options?: CallOptions,
  ): Promise<void>;
  /** Upload a Talk image (8 MiB) or run frame (2 MiB). Reuse clientImageId for the same bytes. */
  uploadImage(image: Blob, options?: ImageUploadOptions): Promise<ImageUploadResponse>;
  /** Delete a Talk image or run frame using its original scope. */
  deleteImage(imageId: string, options?: ImageScopeOptions): Promise<void>;
  /** Requires a Cognito token. Approved plans are shared; unapproved plans are only visible to their owner. */
  listTaskPlans(
    input?: { status?: TaskPlanStatus; limit?: number; offset?: number },
    options?: CallOptions,
  ): Promise<TaskPlanPage>;
  /** Requires a Cognito token. A pairing is optional; generated drafts expire two hours after creation until approved. */
  createTaskPlan(input: CreateTaskPlanInput, options?: CallOptions): Promise<TaskPlan>;
  /** Requires a Cognito token and a plan owned by the caller or one that is approved. */
  getTaskPlan(taskPlanId: string, options?: CallOptions): Promise<TaskPlan>;
  /** Requires a Cognito token and the caller's draft plan. Retries must reuse the same request ID and message. */
  refineTaskPlan(
    taskPlanId: string,
    input: RefineTaskPlanInput,
    options?: CallOptions,
  ): Promise<TaskPlan>;
  /** Requires the caller's draft plan. The review can call the configured model and is saved only if the version is unchanged. */
  validateTaskPlan(taskPlanId: string, options?: CallOptions): Promise<TaskPlan>;
  /** Requires the caller's draft plan and explicit user consent. Approval is blocked until strict review passes. */
  approveTaskPlan(taskPlanId: string, options?: ApprovalOptions): Promise<TaskPlan>;
  /** Phone runs use expectedPlanVersion. Paired runs use pairingToken. Reuse the request ID and payload for retries. */
  startTaskRun(input: CreateRunInput, options?: CallOptions): Promise<TaskRun>;
  /** Lists the caller's active and paused runs. */
  listUnfinishedTaskRuns(options?: CallOptions): Promise<TaskRunPage>;
  /** Requires a task run owned by the caller. */
  getTaskRun(taskRunId: string, options?: CallOptions): Promise<TaskRun>;
  /** Requires an active or paused run. Use its latest state version; command validity depends on the current run state. */
  commandTaskRun(
    taskRunId: string,
    input: TaskRunCommandInput,
    options?: CallOptions,
  ): Promise<TaskRunCommandResult>;
  /** Requires an active or paused run. Use its latest state version and reuse the request ID for retries. */
  stopTaskRun(
    taskRunId: string,
    input: StopTaskRunInput,
    options?: CallOptions,
  ): Promise<TaskRunCommandResult>;
  /** Queue one to three images of at most 2 MiB each for an active run. */
  submitInferenceWindow(
    taskRunId: string,
    input: InferenceWindowInput,
    options?: CallOptions,
  ): Promise<InferenceWindowResponse>;
  /** Read the current status and eventual observation of the caller's window. */
  getInferenceWindow(
    taskRunId: string,
    windowId: string,
    options?: CallOptions,
  ): Promise<InferenceWindow>;
}

export type CreateRunInput = InputOf<operations["startTaskRun"]>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pairingTokenPattern = /^[0-9a-f]{32}$/i;
const taskPlanStatuses = ["draft", "awaiting_approval", "approved", "abandoned"];
const taskRunCommands = ["pause", "resume", "repeat", "confirm", "skip", "back", "correct", "stop"];
const apiKeyProviders = [
  "openai",
  "anthropic",
  "google",
  "nvidia",
  "openrouter",
  "groq",
  "mistral",
  "xai",
  "together",
  "fireworks",
  "deepseek",
  "perplexity",
  "cerebras",
];

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SdkValidationError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new SdkValidationError(`${field}.${key}`, "is not supported");
  }
}

function string(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new SdkValidationError(field, `must contain ${min} to ${max} characters`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const result = string(value, field, 1, 36);
  if (!uuidPattern.test(result)) throw new SdkValidationError(field, "must be a UUID");
  return result;
}

function pairingToken(value: unknown, field = "pairingToken"): string {
  const result = string(value, field, 32, 32);
  if (!pairingTokenPattern.test(result)) {
    throw new SdkValidationError(field, "must be a 32-character hexadecimal pairing token");
  }
  return result;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new SdkValidationError(field, `must be an integer from 1 to ${max}`);
  }
  return value;
}

function requiredAccessToken(value?: string): string {
  if (!value?.trim()) throw new SdkValidationError("accessToken", "is required for this operation");
  return value;
}

function normalizeText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new SdkValidationError(field, "must be text");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max) {
    throw new SdkValidationError(field, `must contain 1 to ${max} characters after normalization`);
  }
  return normalized;
}

function validateProvider(value: unknown): void {
  if (value === undefined) return;
  const provider = record(value, "provider");
  const type = string(provider.type, "provider.type", 1, 40);
  if (apiKeyProviders.includes(type)) {
    onlyKeys(provider, ["type", "apiKey", "model"], "provider");
    string(provider.apiKey, "provider.apiKey", 1, 8192);
  } else if (type === "azure") {
    onlyKeys(provider, ["type", "apiKey", "endpoint", "model"], "provider");
    string(provider.apiKey, "provider.apiKey", 1, 8192);
    const endpoint = string(provider.endpoint, "provider.endpoint", 1, 2048);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new SdkValidationError("provider.endpoint", "must be a valid Azure HTTPS URL");
    }
    const allowed = [".openai.azure.com", ".services.ai.azure.com", ".models.ai.azure.com"];
    if (
      url.protocol !== "https:" || !allowed.some((suffix) => url.hostname.endsWith(suffix)) ||
      url.username || url.password || url.port
    ) throw new SdkValidationError("provider.endpoint", "must be an allowed Azure HTTPS endpoint");
  } else if (type === "aws-bedrock") {
    onlyKeys(provider, [
      "type",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "region",
      "model",
    ], "provider");
    string(provider.accessKeyId, "provider.accessKeyId", 1, 256);
    string(provider.secretAccessKey, "provider.secretAccessKey", 1, 8192);
    if (provider.sessionToken !== undefined) {
      string(provider.sessionToken, "provider.sessionToken", 1, 8192);
    }
    const region = string(provider.region, "provider.region", 1, 40);
    if (!/^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/.test(region)) {
      throw new SdkValidationError("provider.region", "must be an AWS region");
    }
  } else {
    throw new SdkValidationError("provider.type", "is not a supported provider");
  }
  const model = string(provider.model, "provider.model", 1, 300);
  if (/\p{C}/u.test(model)) {
    throw new SdkValidationError("provider.model", "contains control characters");
  }
}

function validatePlan(input: CreateTaskPlanInput): void {
  const value = record(input, "input");
  uuid(value.clientRequestId, "clientRequestId");
  if (value.goal !== undefined) {
    onlyKeys(value, ["clientRequestId", "goal"], "input");
    normalizeText(value.goal, "goal", 2000);
    return;
  }
  onlyKeys(value, ["clientRequestId", "title", "steps", "pairingToken"], "input");
  const title = normalizeText(value.title, "title", 160);
  if (!title) throw new SdkValidationError("title", "must not be blank");
  if (value.pairingToken !== undefined) pairingToken(value.pairingToken);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 30) {
    throw new SdkValidationError("steps", "must contain 1 to 30 items");
  }
  let total = 0;
  value.steps.forEach((rawStep, index) => {
    const field = `steps[${index}]`;
    const step = record(rawStep, field);
    onlyKeys(step, [
      "instruction",
      "prechecks",
      "postchecks",
      "acceptanceCriteria",
      "safetyNotes",
      "openQuestions",
    ], field);
    total += normalizeText(step.instruction, `${field}.instruction`, 1000).length;
    for (
      const key of ["prechecks", "postchecks", "acceptanceCriteria", "safetyNotes", "openQuestions"]
    ) {
      const list = step[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 3) {
        throw new SdkValidationError(`${field}.${key}`, "must contain at most 3 items");
      }
      list.forEach((item, itemIndex) => normalizeText(item, `${field}.${key}[${itemIndex}]`, 240));
    }
  });
  if (total > 16000) {
    throw new SdkValidationError("steps", "combined instructions exceed 16000 characters");
  }
}

function validateChat(input: ChatInput): void {
  const value = record(input, "input");
  if (value.pairingToken !== undefined) {
    onlyKeys(value, ["pairingToken", "messages", "provider"], "input");
    pairingToken(value.pairingToken);
  } else {
    onlyKeys(
      value,
      [
        "clientRequestId",
        "messages",
        "provider",
        "taskRunId",
        "expectedStateVersion",
        "observationWindowId",
      ],
      "input",
    );
    uuid(value.clientRequestId, "clientRequestId");
    if (value.taskRunId !== undefined || value.expectedStateVersion !== undefined) {
      uuid(value.taskRunId, "taskRunId");
      positiveInteger(value.expectedStateVersion, "expectedStateVersion", 9_000_000_000_000_000);
    }
    if (value.observationWindowId !== undefined) {
      uuid(value.taskRunId, "taskRunId");
      uuid(value.observationWindowId, "observationWindowId");
    }
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1) {
    throw new SdkValidationError("messages", "must contain at least one message");
  }
  for (const [index, rawMessage] of value.messages.entries()) {
    const field = `messages[${index}]`;
    const message = record(rawMessage, field);
    onlyKeys(message, ["role", "content", "imageIds"], field);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new SdkValidationError(`${field}.role`, "must be user or assistant");
    }
    if (!string(message.content, `${field}.content`, 1, 256000).trim()) {
      throw new SdkValidationError(`${field}.content`, "must not be blank");
    }
    if (message.imageIds !== undefined) {
      if (!Array.isArray(message.imageIds)) {
        throw new SdkValidationError(`${field}.imageIds`, "must be an array");
      }
      message.imageIds.forEach((id, imageIndex) => uuid(id, `${field}.imageIds[${imageIndex}]`));
      if (message.role !== "user" && message.imageIds.length > 0) {
        throw new SdkValidationError(`${field}.imageIds`, "can only be attached to user messages");
      }
    }
  }
  validateProvider(value.provider);
  const normalizedMessages = value.messages.map((raw) => {
    const message = raw as Record<string, unknown>;
    return { role: message.role, content: message.content, imageIds: message.imageIds ?? [] };
  });
  if (new TextEncoder().encode(JSON.stringify(normalizedMessages)).byteLength > 256000) {
    throw new SdkValidationError("messages", "serialized transcript exceeds 256000 UTF-8 bytes");
  }
}

function validateRunRequest(
  input: { clientRequestId: string; expectedStateVersion: number },
): void {
  const value = record(input, "input");
  uuid(value.clientRequestId, "clientRequestId");
  positiveInteger(value.expectedStateVersion, "expectedStateVersion", 9_000_000_000_000_000);
}

function validateActiveRun(input: unknown): void {
  if (input === undefined) return;
  const run = record(input, "activeRun");
  onlyKeys(run, ["taskRunId", "expectedStateVersion"], "activeRun");
  uuid(run.taskRunId, "activeRun.taskRunId");
  positiveInteger(
    run.expectedStateVersion,
    "activeRun.expectedStateVersion",
    9_000_000_000_000_000,
  );
}

export function createClient(options: ClientOptions): MetaGlassesClient {
  if (!options || typeof options !== "object") {
    throw new SdkValidationError("options", "are required");
  }
  const baseUrl = string(options.baseUrl, "baseUrl", 1, 2048);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new SdkValidationError("baseUrl", "must be an absolute HTTP or HTTPS URL");
  }
  if (
    !/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
  ) {
    throw new SdkValidationError(
      "baseUrl",
      "must be an HTTP or HTTPS base URL without credentials, query, or fragment",
    );
  }
  const fetcher = options.fetch ?? fetch;
  const baseHref = base.href.endsWith("/") ? base.href : `${base.href}/`;

  async function request<P extends ApiPath, M extends ApiMethod<P>>(
    path: P,
    method: M,
    body: unknown,
    token: string | undefined,
    call: CallOptions = {},
    contentType = "application/json",
  ): Promise<OutputOf<OperationAt<P, M>>> {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const requestSignal = call.signal ?? AbortSignal.timeout(30_000);
    const init: RequestInit = { method, headers, signal: requestSignal };
    if (body !== undefined) {
      if (body instanceof Blob) {
        headers.set("Content-Type", contentType);
        init.body = body;
      } else {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(body);
      }
    }
    let response: Response;
    try {
      response = await fetcher(new URL(path.replace(/^\//, ""), baseHref), init);
    } catch (error) {
      if (
        requestSignal.aborted && requestSignal.reason instanceof DOMException &&
        requestSignal.reason.name === "TimeoutError"
      ) throw new ApiTimeoutError();
      if (call.signal?.aborted) throw error;
      throw new ApiTransportError("The API request could not be completed.", error);
    }
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = await response.json();
        if (typeof parsed === "object" && parsed !== null) {
          payload = parsed as Record<string, unknown>;
        }
      } catch { /* Preserve status and request ID when a gateway returns non-JSON errors. */ }
      const details = typeof payload.error === "object" && payload.error !== null
        ? payload.error as Record<string, unknown>
        : {};
      throw new ApiRequestError(
        response.status,
        typeof details.code === "string" ? details.code : null,
        requestId ?? (typeof payload.request_id === "string" ? payload.request_id : null),
        details.context,
        typeof payload.detail === "string"
          ? payload.detail
          : `API request failed with status ${response.status}`,
      );
    }
    if (response.status === 204) return undefined as OutputOf<OperationAt<P, M>>;
    try {
      return await response.json() as OutputOf<OperationAt<P, M>>;
    } catch {
      throw new ApiProtocolError(response.status, requestId);
    }
  }

  function authToken(): string {
    return requiredAccessToken(options.accessToken);
  }

  async function uploadImage(
    image: Blob,
    query: URLSearchParams,
    maxMiB: number,
    call: CallOptions & { clientImageId?: string },
  ): Promise<ImageUploadResponse> {
    if (call.clientImageId !== undefined) {
      query.set("clientImageId", uuid(call.clientImageId, "clientImageId"));
    }
    if (!(image instanceof Blob) || image.size < 1 || image.size > maxMiB * 1024 * 1024) {
      throw new SdkValidationError(
        "image",
        `must be a nonempty JPEG or PNG no larger than ${maxMiB} MiB`,
      );
    }
    const contentType = image.type.toLowerCase();
    const signature = new Uint8Array(await image.slice(0, 8).arrayBuffer());
    const jpeg = contentType === "image/jpeg" && signature.length >= 3 &&
      signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const png = contentType === "image/png" && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => signature[index] === byte);
    if (!jpeg && !png) {
      throw new SdkValidationError("image", "content type must match a JPEG or PNG file signature");
    }
    return request(
      (query.size ? `/v1/images?${query}` : "/v1/images") as "/v1/images",
      "POST",
      image,
      authToken(),
      call,
      contentType,
    );
  }

  function deleteImage(imageId: string, query: URLSearchParams, call: CallOptions): Promise<void> {
    uuid(imageId, "imageId");
    const imagePath = `/v1/images/${encodeURIComponent(imageId)}`;
    return request(
      (query.size ? `${imagePath}?${query}` : imagePath) as "/v1/images/{imageId}",
      "DELETE",
      undefined,
      authToken(),
      call,
    );
  }

  function phoneImageQuery(call: ImageScopeOptions): URLSearchParams {
    const query = new URLSearchParams();
    if (call.taskRunId !== undefined) query.set("taskRunId", uuid(call.taskRunId, "taskRunId"));
    return query;
  }

  return {
    getHealth: (call = {}) => request("/healthz", "GET", undefined, undefined, call),

    setPairingState: (input, call = {}) => {
      const value = record(input, "input");
      onlyKeys(value, ["pairingToken", "state"], "input");
      pairingToken(value.pairingToken);
      if (!["idle", "listening", "thinking", "speaking"].includes(String(value.state))) {
        throw new SdkValidationError("state", "must be idle, listening, thinking, or speaking");
      }
      return request("/v1/state", "POST", input, authToken(), call);
    },

    getDisplay: (token, call = {}) => {
      const query = new URLSearchParams({ token: pairingToken(token) });
      return request(`/v1/display?${query}` as "/v1/display", "GET", undefined, undefined, call);
    },

    createChatResponse: (input, call = {}) => {
      validateChat(input);
      return request("/v1/chat", "POST", input, authToken(), call);
    },

    uploadPairingImage: async (token, image, call = {}) =>
      uploadImage(image, new URLSearchParams({ pairingToken: pairingToken(token) }), 8, call),

    deletePairingImage: (imageId, token, call = {}) =>
      deleteImage(imageId, new URLSearchParams({ pairingToken: pairingToken(token) }), call),

    uploadImage: async (image, call = {}) =>
      uploadImage(image, phoneImageQuery(call), call.taskRunId === undefined ? 8 : 2, call),

    deleteImage: (imageId, call = {}) => deleteImage(imageId, phoneImageQuery(call), call),

    listTaskPlans: (input = {}, call = {}) => {
      const value = record(input, "input");
      onlyKeys(value, ["status", "limit", "offset"], "input");
      if (value.status !== undefined && !taskPlanStatuses.includes(String(value.status))) {
        throw new SdkValidationError("status", "is not a supported task plan status");
      }
      if (
        value.limit !== undefined &&
        (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 ||
          value.limit > 100)
      ) {
        throw new SdkValidationError("limit", "must be an integer from 1 to 100");
      }
      if (
        value.offset !== undefined &&
        (typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0 ||
          value.offset > 2_147_483_547)
      ) {
        throw new SdkValidationError("offset", "must be an integer from 0 to 2147483547");
      }
      const query = new URLSearchParams();
      for (const key of ["status", "limit", "offset"] as const) {
        if (value[key] !== undefined) query.set(key, String(value[key]));
      }
      return request(
        `/v1/task-plans${query.size ? `?${query}` : ""}` as "/v1/task-plans",
        "GET",
        undefined,
        authToken(),
        call,
      );
    },

    createTaskPlan: (input, call = {}) => {
      validatePlan(input);
      return request("/v1/task-plans", "POST", input, authToken(), call);
    },

    getTaskPlan: (taskPlanId, call = {}) => {
      uuid(taskPlanId, "taskPlanId");
      return request(
        `/v1/task-plans/${encodeURIComponent(taskPlanId)}` as "/v1/task-plans/{taskPlanId}",
        "GET",
        undefined,
        authToken(),
        call,
      );
    },

    refineTaskPlan: (taskPlanId, input, call = {}) => {
      uuid(taskPlanId, "taskPlanId");
      const value = record(input, "input");
      onlyKeys(value, ["clientRequestId", "expectedVersion", "message"], "input");
      uuid(value.clientRequestId, "clientRequestId");
      positiveInteger(value.expectedVersion, "expectedVersion");
      normalizeText(value.message, "message", 2000);
      return request(
        `/v1/task-plans/${
          encodeURIComponent(taskPlanId)
        }/refine` as "/v1/task-plans/{taskPlanId}/refine",
        "POST",
        input,
        authToken(),
        call,
      );
    },

    validateTaskPlan: (taskPlanId, call = {}) => {
      uuid(taskPlanId, "taskPlanId");
      return request(
        `/v1/task-plans/${
          encodeURIComponent(taskPlanId)
        }/validate` as "/v1/task-plans/{taskPlanId}/validate",
        "POST",
        {},
        authToken(),
        call,
      );
    },

    approveTaskPlan: (taskPlanId, call = {}) => {
      uuid(taskPlanId, "taskPlanId");
      let approval: ApproveTaskPlanInput | undefined;
      if (call.expectedVersion !== undefined || call.clientRequestId !== undefined) {
        approval = {
          expectedVersion: positiveInteger(call.expectedVersion, "expectedVersion", 2_147_483_647),
          clientRequestId: uuid(call.clientRequestId, "clientRequestId"),
        };
      }
      return request(
        `/v1/task-plans/${
          encodeURIComponent(taskPlanId)
        }/approve` as "/v1/task-plans/{taskPlanId}/approve",
        "POST",
        approval ?? {},
        authToken(),
        call,
      );
    },

    startTaskRun: (input, call = {}) => {
      const value = record(input, "input");
      onlyKeys(
        value,
        ["taskPlanId", "clientRequestId", "pairingToken", "expectedPlanVersion", "activeRun"],
        "input",
      );
      uuid(value.taskPlanId, "taskPlanId");
      uuid(value.clientRequestId, "clientRequestId");
      if (value.pairingToken !== undefined) pairingToken(value.pairingToken);
      if (value.expectedPlanVersion !== undefined) {
        positiveInteger(value.expectedPlanVersion, "expectedPlanVersion", 2_147_483_647);
      }
      validateActiveRun(value.activeRun);
      return request("/v1/task-runs", "POST", input, authToken(), call);
    },

    listUnfinishedTaskRuns: (call = {}) =>
      request(
        "/v1/task-runs?status=unfinished" as "/v1/task-runs",
        "GET",
        undefined,
        authToken(),
        call,
      ),

    getTaskRun: (taskRunId, call = {}) => {
      uuid(taskRunId, "taskRunId");
      return request(
        `/v1/task-runs/${encodeURIComponent(taskRunId)}` as "/v1/task-runs/{taskRunId}",
        "GET",
        undefined,
        authToken(),
        call,
      );
    },

    commandTaskRun: (taskRunId, input, call = {}) => {
      uuid(taskRunId, "taskRunId");
      const value = record(input, "input");
      onlyKeys(value, ["clientRequestId", "expectedStateVersion", "command", "activeRun"], "input");
      validateRunRequest(value as unknown as TaskRunCommandInput);
      if (!taskRunCommands.includes(String(value.command))) {
        throw new SdkValidationError("command", "is not supported");
      }
      if (value.activeRun !== undefined && value.command !== "resume") {
        throw new SdkValidationError("activeRun", "is only supported when resuming");
      }
      validateActiveRun(value.activeRun);
      return request(
        `/v1/task-runs/${
          encodeURIComponent(taskRunId)
        }/commands` as "/v1/task-runs/{taskRunId}/commands",
        "POST",
        input,
        authToken(),
        call,
      );
    },

    stopTaskRun: (taskRunId, input, call = {}) => {
      uuid(taskRunId, "taskRunId");
      const value = record(input, "input");
      onlyKeys(value, ["clientRequestId", "expectedStateVersion"], "input");
      validateRunRequest(value as unknown as StopTaskRunInput);
      return request(
        `/v1/task-runs/${encodeURIComponent(taskRunId)}/stop` as "/v1/task-runs/{taskRunId}/stop",
        "POST",
        input,
        authToken(),
        call,
      );
    },

    submitInferenceWindow: (taskRunId, input, call = {}) => {
      uuid(taskRunId, "taskRunId");
      const value = record(input, "input");
      onlyKeys(
        value,
        ["clientRequestId", "expectedStateVersion", "sequenceNumber", "frames", "question"],
        "input",
      );
      uuid(value.clientRequestId, "clientRequestId");
      positiveInteger(value.expectedStateVersion, "expectedStateVersion", 9_000_000_000_000_000);
      positiveInteger(value.sequenceNumber, "sequenceNumber", 9_000_000_000_000_000);
      if (value.question !== undefined) {
        const question = typeof value.question === "string" ? value.question.trim() : "";
        if (!question || question.includes("\u0000") || [...question].length > 500) {
          throw new SdkValidationError("question", "must have 1 to 500 characters");
        }
      }
      if (!Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > 3) {
        throw new SdkValidationError("frames", "must contain 1 to 3 images");
      }
      let prior = -Infinity;
      const seen = new Set<string>();
      value.frames.forEach((rawFrame, index) => {
        const frame = record(rawFrame, `frames[${index}]`);
        onlyKeys(frame, ["imageId", "capturedAt"], `frames[${index}]`);
        const imageId = uuid(frame.imageId, `frames[${index}].imageId`).toLowerCase();
        if (seen.has(imageId)) throw new SdkValidationError("frames", "must not repeat an image");
        seen.add(imageId);
        const timestamp = string(frame.capturedAt, `frames[${index}].capturedAt`, 24, 24);
        const date = new Date(timestamp);
        const milliseconds = date.getTime();
        if (
          Number.isNaN(milliseconds) || date.getUTCFullYear() < 1 ||
          date.toISOString() !== timestamp || milliseconds <= prior
        ) {
          throw new SdkValidationError(
            `frames[${index}].capturedAt`,
            "must be a strictly increasing UTC timestamp with milliseconds",
          );
        }
        prior = milliseconds;
      });
      return request(
        `/v1/task-runs/${
          encodeURIComponent(taskRunId)
        }/inference-windows` as "/v1/task-runs/{taskRunId}/inference-windows",
        "POST",
        input,
        authToken(),
        call,
      );
    },

    getInferenceWindow: (taskRunId, windowId, call = {}) => {
      uuid(taskRunId, "taskRunId");
      uuid(windowId, "windowId");
      return request(
        `/v1/task-runs/${encodeURIComponent(taskRunId)}/inference-windows/${
          encodeURIComponent(windowId)
        }` as "/v1/task-runs/{taskRunId}/inference-windows/{windowId}",
        "GET",
        undefined,
        authToken(),
        call,
      );
    },
  };
}
