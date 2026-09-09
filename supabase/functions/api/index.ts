const pairingTtlSeconds = 3600;
const maxImagesPerPairing = 10;
const maxImageBytes = 8 * 1024 * 1024;
const signedUrlTtlSeconds = 60;
const maxTranscriptBytes = 256_000;
const defaultNvidiaBaseUrl = "https://integrate.api.nvidia.com/v1";
const defaultNvidiaModel = "moonshotai/kimi-k3";
const systemPrompt = `You are the MetaGlasses step-by-step voice assistant.
Answer the user's latest request with exactly one practical next step in one short,
plain-text sentence. Keep the answer concise enough to fit on a small wearable lens.
Do not use markdown, preambles, or follow-up questions unless essential for safety.`;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "DELETE, GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type PairingState = "idle" | "listening" | "thinking" | "speaking";

interface AuthenticatedUser {
  id: string;
  accessToken: string;
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

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly authenticate = false,
  ) {
    super(message);
  }
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

function errorResponse(error: ApiError): Response {
  const headers = {
    ...corsHeaders,
    "Content-Type": "application/json",
    ...(error.authenticate ? { "WWW-Authenticate": "Bearer" } : {}),
  };
  return new Response(JSON.stringify({ detail: error.message }), {
    status: error.status,
    headers,
  });
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new ApiError(503, `${name} is not configured.`);
  }
  return value;
}

function keyFromEnvironment(mapName: string, legacyName: string): string {
  const encodedKeys = Deno.env.get(mapName);
  if (encodedKeys) {
    try {
      const keys = JSON.parse(encodedKeys) as Record<string, unknown>;
      const candidate = keys.default ?? Object.values(keys)[0];
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
    } catch {
      throw new ApiError(503, `${mapName} is invalid.`);
    }
  }
  return requiredEnvironment(legacyName);
}

function publishableKey(): string {
  return keyFromEnvironment("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
}

function secretKey(): string {
  return keyFromEnvironment(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
}

function supabaseUrl(): string {
  return requiredEnvironment("SUPABASE_URL").replace(/\/$/, "");
}

function environmentName(): "local" | "trial" | "prod" {
  const url = supabaseUrl();
  if (url.includes("uitdzmwfqtsohgffhuom")) return "trial";
  if (url.includes("hxtdfghufjjmeltarffl")) return "prod";
  return "local";
}

function imageBucket(): string {
  const configured = Deno.env.get("PAIRING_IMAGE_BUCKET")?.trim();
  if (configured) return configured;
  return environmentName() === "prod" ? "images" : "Images";
}

function adminHeaders(): Record<string, string> {
  const key = secretKey();
  return {
    apikey: key,
    ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
    "Content-Type": "application/json",
  };
}

function userHeaders(
  accessToken: string,
  contentType?: string,
): Record<string, string> {
  return {
    apikey: publishableKey(),
    Authorization: `Bearer ${accessToken}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

async function rpc<T>(
  name: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(parameters),
  });
  if (!response.ok) {
    throw new ApiError(503, "Pairing storage unavailable.");
  }
  return (await response.json()) as T;
}

async function authenticate(request: Request): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, "Missing or invalid access token.", true);
  }
  const accessToken = match[1].trim();
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: userHeaders(accessToken),
  });
  if (!response.ok) {
    throw new ApiError(401, "Missing or invalid access token.", true);
  }
  const user = (await response.json()) as { id?: unknown };
  if (typeof user.id !== "string" || !uuidPattern.test(user.id)) {
    throw new ApiError(401, "Missing or invalid access token.", true);
  }
  return { id: user.id, accessToken };
}

const tokenPattern = /^[0-9a-fA-F]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pairingStates = new Set<PairingState>([
  "idle",
  "listening",
  "thinking",
  "speaking",
]);

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

async function signedImageUrl(
  image: StoredImage,
  accessToken: string,
): Promise<string> {
  const bucket = encodeURIComponent(imageBucket());
  const path = image.object_path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${supabaseUrl()}/storage/v1/object/sign/${bucket}/${path}`,
    {
      method: "POST",
      headers: userHeaders(accessToken, "application/json"),
      body: JSON.stringify({ expiresIn: signedUrlTtlSeconds }),
    },
  );
  if (!response.ok) throw new ApiError(503, "Image storage unavailable.");
  const payload = (await response.json()) as { signedURL?: unknown };
  if (typeof payload.signedURL !== "string" || !payload.signedURL) {
    throw new ApiError(503, "Image storage unavailable.");
  }
  return payload.signedURL.startsWith("http")
    ? payload.signedURL
    : `${supabaseUrl()}/storage/v1${payload.signedURL}`;
}

function modelMessage(
  message: ConversationMessage,
  imageUrls: Map<string, string>,
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
        image_url: { url: imageUrls.get(imageId) },
      })),
    ],
  };
}

async function generateResponse(
  messages: ConversationMessage[],
  imageUrls: Map<string, string>,
): Promise<string> {
  const apiKey = requiredEnvironment("NVIDIA_API_KEY");
  const baseUrl = (Deno.env.get("NVIDIA_BASE_URL") ?? defaultNvidiaBaseUrl)
    .replace(/\/$/, "");
  const model = Deno.env.get("NVIDIA_MODEL")?.trim() || defaultNvidiaModel;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((message) => modelMessage(message, imageUrls)),
        ],
        max_tokens: 160,
        stream: false,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(503, "Model provider unavailable.");
  }
  if (response.status === 429) {
    throw new ApiError(429, "Model rate limited. Back off and retry.");
  }
  if (!response.ok) {
    throw new ApiError(503, "Model provider unavailable.");
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
    throw new ApiError(503, "Model provider unavailable.");
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
  if (imageIds.length > maxImagesPerPairing) {
    await setState(token, user.id, "idle");
    throw new ApiError(
      422,
      "Too many images are attached to this chat request.",
    );
  }

  try {
    const images = await getImages(token, user.id, imageIds);
    const signedUrls = await Promise.all(
      images.map((image) => signedImageUrl(image, user.accessToken)),
    );
    const imageUrls = new Map(
      images.map((image, index) => [image.image_id, signedUrls[index]]),
    );
    const text = await generateResponse(messages, imageUrls);
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
  const registration = await rpc<
    "registered" | "limit" | "forbidden" | "not_found"
  >(
    "edge_api_register_image",
    {
      p_token_hash: digest,
      p_owner_id: user.id,
      p_image_id: imageId,
      p_object_path: objectPath,
      p_content_type: contentType,
      p_byte_size: bytes.length,
      p_max_images: maxImagesPerPairing,
    },
  );
  if (registration === "limit") {
    throw new ApiError(
      429,
      "This pairing already contains the maximum number of images.",
    );
  }
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

  const bucket = encodeURIComponent(imageBucket());
  const path = objectPath.split("/").map(encodeURIComponent).join("/");
  const upload = await fetch(
    `${supabaseUrl()}/storage/v1/object/${bucket}/${path}`,
    {
      method: "POST",
      headers: {
        ...userHeaders(user.accessToken, contentType),
        "Cache-Control": "max-age=0",
        "x-upsert": "false",
      },
      body: bytes,
    },
  );
  if (!upload.ok) {
    await removeImageMetadata(token, user.id, imageId).catch(() => undefined);
    throw new ApiError(503, "Image storage unavailable.");
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
  const bucket = encodeURIComponent(imageBucket());
  const deletion = await fetch(`${supabaseUrl()}/storage/v1/object/${bucket}`, {
    method: "DELETE",
    headers: userHeaders(user.accessToken, "application/json"),
    body: JSON.stringify({ prefixes: [image.object_path] }),
  });
  if (!deletion.ok) throw new ApiError(503, "Image storage unavailable.");
  await removeImageMetadata(token, user.id, imageId);
  return emptyResponse(204);
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
  if (request.method === "OPTIONS") return emptyResponse(204);
  const url = new URL(request.url);
  const path = routePath(url.pathname);
  try {
    if (request.method === "GET" && path === "/healthz") {
      return jsonResponse({
        status: "ok",
        environment: environmentName(),
        auth: "required",
      });
    }
    if (request.method === "POST" && path === "/v1/state") {
      return await handleState(request);
    }
    if (request.method === "GET" && path === "/v1/display") {
      return await handleDisplay(url);
    }
    if (request.method === "POST" && path === "/v1/chat") {
      return await handleChat(request);
    }
    if (request.method === "POST" && path === "/v1/images") {
      return await handleImageUpload(request, url);
    }
    const imageDelete = path.match(/^\/v1\/images\/([^/]+)$/);
    if (request.method === "DELETE" && imageDelete) {
      return await handleImageDelete(request, url, imageDelete[1]);
    }
    throw new ApiError(404, "Not found.");
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    return errorResponse(new ApiError(500, "Internal server error."));
  }
});
