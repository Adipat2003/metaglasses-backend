const providerTimeoutMilliseconds = 5 * 60_000;
const maximumInlineImageBytes = 16 * 1024 * 1024;

const openAiCompatibleBaseUrls = {
  openai: "https://api.openai.com/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  deepseek: "https://api.deepseek.com",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
} as const;

type OpenAiCompatibleProvider = keyof typeof openAiCompatibleBaseUrls;
export type ExternalProviderName =
  | OpenAiCompatibleProvider
  | "anthropic"
  | "google"
  | "azure"
  | "aws-bedrock";

interface ApiKeyProviderConfig {
  type: Exclude<ExternalProviderName, "azure" | "aws-bedrock">;
  apiKey: string;
  model: string;
}

interface AzureProviderConfig {
  type: "azure";
  apiKey: string;
  endpoint: string;
  model: string;
}

interface AwsProviderConfig {
  type: "aws-bedrock";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  model: string;
}

export type ExternalProviderConfig =
  | ApiKeyProviderConfig
  | AzureProviderConfig
  | AwsProviderConfig;

export interface ProviderImage {
  contentType: "image/jpeg" | "image/png";
  url: string;
}

export interface ProviderMessage {
  role: "user" | "assistant";
  text: string;
  images: ProviderImage[];
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export class ExternalProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "ExternalProviderError";
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderConfigurationError("provider must be an object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  name: string,
  maximumLength: number,
): string {
  const value = record[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new ProviderConfigurationError(
      `provider.${name} must contain 1 to ${maximumLength} characters.`,
    );
  }
  return value.trim();
}

function optionalSecret(record: Record<string, unknown>, name: string): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredString(record, name, 8_192);
}

function validatedModel(record: Record<string, unknown>): string {
  const model = requiredString(record, "model", 300);
  if (/\p{C}/u.test(model)) {
    throw new ProviderConfigurationError("provider.model contains invalid characters.");
  }
  return model;
}

function validatedAzureEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigurationError("provider.endpoint must be a valid Azure HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = [
    ".openai.azure.com",
    ".services.ai.azure.com",
    ".models.ai.azure.com",
  ].some((suffix) => hostname.endsWith(suffix));
  if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port) {
    throw new ProviderConfigurationError(
      "provider.endpoint must be an HTTPS Azure OpenAI or Azure AI Foundry endpoint.",
    );
  }
  return url.origin;
}

export function parseExternalProvider(value: unknown): ExternalProviderConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const provider = recordValue(value);
  const type = requiredString(provider, "type", 40) as ExternalProviderName;
  const supported = new Set<ExternalProviderName>([
    ...Object.keys(openAiCompatibleBaseUrls) as OpenAiCompatibleProvider[],
    "anthropic",
    "google",
    "azure",
    "aws-bedrock",
  ]);
  if (!supported.has(type)) {
    throw new ProviderConfigurationError(
      `Unsupported provider type '${type}'.`,
    );
  }

  const model = validatedModel(provider);
  if (type === "azure") {
    return {
      type,
      apiKey: requiredString(provider, "apiKey", 8_192),
      endpoint: validatedAzureEndpoint(requiredString(provider, "endpoint", 2_048)),
      model,
    };
  }
  if (type === "aws-bedrock") {
    const region = requiredString(provider, "region", 40).toLowerCase();
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
      throw new ProviderConfigurationError("provider.region is not a valid AWS region.");
    }
    return {
      type,
      accessKeyId: requiredString(provider, "accessKeyId", 256),
      secretAccessKey: requiredString(provider, "secretAccessKey", 8_192),
      sessionToken: optionalSecret(provider, "sessionToken"),
      region,
      model,
    };
  }
  return {
    type,
    apiKey: requiredString(provider, "apiKey", 8_192),
    model,
  } as ApiKeyProviderConfig;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

async function inlineImageData(
  messages: ProviderMessage[],
  provider: ExternalProviderName,
  model: string,
  fetcher: Fetcher,
): Promise<Map<string, string>> {
  const images = [...new Map(
    messages.flatMap((message) => message.images).map((image) => [image.url, image]),
  ).values()];
  const encoded = new Map<string, string>();
  let totalBytes = 0;
  for (const image of images) {
    let response: Response;
    try {
      response = await fetcher(image.url, {
        signal: AbortSignal.timeout(providerTimeoutMilliseconds),
      });
    } catch (error) {
      throw connectionError(provider, model, error, "The image could not be downloaded.");
    }
    if (!response.ok) {
      throw new ExternalProviderError(
        503,
        "provider_image_download_failed",
        "The selected provider requires inline images, but an image could not be downloaded. Retry the request.",
        {
          provider,
          model,
          upstream_status: response.status,
          suggested_action: "Retry the request or upload the image again.",
        },
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > maximumInlineImageBytes) {
      throw new ExternalProviderError(
        413,
        "provider_image_payload_too_large",
        "The attached images are too large for this provider. Remove older images and retry.",
        {
          provider,
          model,
          maximum_inline_image_bytes: maximumInlineImageBytes,
          suggested_action: "Remove older or larger images and retry.",
        },
      );
    }
    encoded.set(image.url, bytesToBase64(bytes));
  }
  return encoded;
}

function openAiMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.images.length === 0 ? message.text : [
      { type: "text", text: message.text },
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: image.url },
      })),
    ],
  }));
}

function providerCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const nested = typeof record.error === "object" && record.error !== null
    ? record.error as Record<string, unknown>
    : record;
  const code = nested.code ?? nested.type ?? nested.status;
  if (typeof code !== "string" && typeof code !== "number") return undefined;
  const normalized = String(code).slice(0, 120);
  return /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : undefined;
}

async function responseError(
  response: Response,
  provider: ExternalProviderName,
  model: string,
): Promise<ExternalProviderError> {
  let code: string | undefined;
  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    try {
      code = providerCode(await response.json());
    } catch {
      // The tailored status message below remains actionable.
    }
  }
  const context: Record<string, string | number | boolean> = {
    provider,
    model,
    upstream_status: response.status,
    ...(code ? { provider_error_code: code } : {}),
  };
  if (response.status === 401 || response.status === 403) {
    return new ExternalProviderError(
      422,
      "provider_auth_rejected",
      `${provider} rejected the supplied credentials. Check the API key, permissions, and billing status.`,
      { ...context, suggested_action: "Check the provider credentials and account permissions." },
    );
  }
  if (response.status === 404) {
    return new ExternalProviderError(
      422,
      "provider_model_not_found",
      `${provider} could not find model '${model}'. Check the model or deployment name and regional access.`,
      { ...context, suggested_action: "Choose a model available to this provider account." },
    );
  }
  if (response.status === 429) {
    return new ExternalProviderError(
      429,
      "provider_rate_limited",
      `${provider} rate-limited the request or the account has exhausted its quota. Retry later or check billing.`,
      { ...context, suggested_action: "Retry later or check provider quota and billing." },
    );
  }
  if (response.status === 400 || response.status === 409 || response.status === 422) {
    return new ExternalProviderError(
      422,
      "provider_request_rejected",
      `${provider} rejected the request. Confirm that model '${model}' supports chat and the attached images.`,
      { ...context, suggested_action: "Check model capabilities and request compatibility." },
    );
  }
  return new ExternalProviderError(
    503,
    "model_provider_error",
    `${provider} is unavailable right now. Retry shortly or select another provider.`,
    { ...context, suggested_action: "Retry shortly or select another provider." },
  );
}

function connectionError(
  provider: ExternalProviderName,
  model: string,
  error: unknown,
  detail = "The provider request could not be completed.",
): ExternalProviderError {
  return new ExternalProviderError(
    503,
    "model_request_failed",
    `${detail} Retry or select another provider.`,
    {
      provider,
      model,
      failure_type: error instanceof Error ? error.name : "UnknownError",
      suggested_action: "Check connectivity, then retry or select another provider.",
    },
  );
}

function usableText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function requestJson(
  url: string,
  init: RequestInit,
  provider: ExternalProviderName,
  model: string,
  fetcher: Fetcher,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(providerTimeoutMilliseconds),
    });
  } catch (error) {
    throw connectionError(provider, model, error);
  }
  if (!response.ok) throw await responseError(response, provider, model);
  try {
    return await response.json();
  } catch {
    throw new ExternalProviderError(
      503,
      "model_invalid_response",
      `${provider} returned an unreadable response. Retry or select another provider.`,
      {
        provider,
        model,
        upstream_status: response.status,
        suggested_action: "Retry or select another provider.",
      },
    );
  }
}

async function openAiCompatibleResponse(
  config: ApiKeyProviderConfig | AzureProviderConfig,
  messages: ProviderMessage[],
  fetcher: Fetcher,
): Promise<string> {
  let url: string;
  let headers: Record<string, string>;
  if (config.type === "azure") {
    const hostname = new URL(config.endpoint).hostname.toLowerCase();
    url = hostname.endsWith(".openai.azure.com")
      ? `${config.endpoint}/openai/v1/chat/completions`
      : `${config.endpoint}/models/chat/completions?api-version=2024-05-01-preview`;
    headers = { "api-key": config.apiKey, "Content-Type": "application/json" };
  } else {
    url = `${openAiCompatibleBaseUrls[config.type as OpenAiCompatibleProvider]}/chat/completions`;
    headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
  }
  const payload = await requestJson(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: openAiMessages(messages),
        max_tokens: 512,
        stream: false,
      }),
    },
    config.type,
    config.model,
    fetcher,
  ) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = usableText(payload.choices?.[0]?.message?.content);
  if (text) return text;
  throw invalidTextError(config.type, config.model);
}

async function anthropicResponse(
  config: ApiKeyProviderConfig,
  messages: ProviderMessage[],
  fetcher: Fetcher,
): Promise<string> {
  const payload = await requestJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 512,
        messages: messages.map((message) => ({
          role: message.role,
          content: [
            { type: "text", text: message.text },
            ...message.images.map((image) => ({
              type: "image",
              source: { type: "url", url: image.url },
            })),
          ],
        })),
      }),
    },
    config.type,
    config.model,
    fetcher,
  ) as { content?: Array<{ type?: unknown; text?: unknown }> };
  const text = payload.content?.filter((block) => block.type === "text")
    .map((block) => usableText(block.text)).filter(Boolean).join("\n").trim();
  if (text) return text;
  throw invalidTextError(config.type, config.model);
}

async function googleResponse(
  config: ApiKeyProviderConfig,
  messages: ProviderMessage[],
  fetcher: Fetcher,
): Promise<string> {
  const images = await inlineImageData(messages, config.type, config.model, fetcher);
  const payload = await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(config.model)
    }:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [
            { text: message.text },
            ...message.images.map((image) => ({
              inline_data: {
                mime_type: image.contentType,
                data: images.get(image.url),
              },
            })),
          ],
        })),
        generationConfig: { maxOutputTokens: 512 },
      }),
    },
    config.type,
    config.model,
    fetcher,
  ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => usableText(part.text))
    .filter(Boolean).join("\n").trim();
  if (text) return text;
  throw invalidTextError(config.type, config.model);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(key).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)),
  );
}

export async function signedBedrockRequest(
  config: AwsProviderConfig,
  body: string,
  now = new Date(),
): Promise<{ url: string; init: RequestInit }> {
  const domain = config.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  const host = `bedrock-runtime.${config.region}.${domain}`;
  const path = `/model/${encodeURIComponent(config.model)}/converse`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const bodyHash = await sha256(body);
  const signedHeaderNames = [
    "content-type",
    "host",
    "x-amz-content-sha256",
    "x-amz-date",
    ...(config.sessionToken ? ["x-amz-security-token"] : []),
  ];
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${amzDate}`,
    ...(config.sessionToken ? [`x-amz-security-token:${config.sessionToken}`] : []),
  ].join("\n") + "\n";
  const canonicalRequest = [
    "POST",
    path,
    "",
    canonicalHeaders,
    signedHeaderNames.join(";"),
    bodyHash,
  ].join("\n");
  const scope = `${date}/${config.region}/bedrock/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");
  const secret = new TextEncoder().encode(`AWS4${config.secretAccessKey}`);
  const dateKey = await hmac(secret, date);
  const regionKey = await hmac(dateKey, config.region);
  const serviceKey = await hmac(regionKey, "bedrock");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    url: `https://${host}${path}`,
    init: {
      method: "POST",
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${
          signedHeaderNames.join(";")
        }, Signature=${signature}`,
        "Content-Type": "application/json",
        "x-amz-content-sha256": bodyHash,
        "x-amz-date": amzDate,
        ...(config.sessionToken ? { "x-amz-security-token": config.sessionToken } : {}),
      },
      body,
    },
  };
}

async function bedrockResponse(
  config: AwsProviderConfig,
  messages: ProviderMessage[],
  fetcher: Fetcher,
): Promise<string> {
  const images = await inlineImageData(messages, config.type, config.model, fetcher);
  const body = JSON.stringify({
    messages: messages.map((message) => ({
      role: message.role,
      content: [
        { text: message.text },
        ...message.images.map((image) => ({
          image: {
            format: image.contentType === "image/png" ? "png" : "jpeg",
            source: { bytes: images.get(image.url) },
          },
        })),
      ],
    })),
    inferenceConfig: { maxTokens: 512 },
  });
  const request = await signedBedrockRequest(config, body);
  const payload = await requestJson(
    request.url,
    request.init,
    config.type,
    config.model,
    fetcher,
  ) as { output?: { message?: { content?: Array<{ text?: unknown }> } } };
  const text = payload.output?.message?.content?.map((part) => usableText(part.text))
    .filter(Boolean).join("\n").trim();
  if (text) return text;
  throw invalidTextError(config.type, config.model);
}

function invalidTextError(
  provider: ExternalProviderName,
  model: string,
): ExternalProviderError {
  return new ExternalProviderError(
    503,
    "model_invalid_response",
    `${provider} returned no usable text. Retry or choose another model.`,
    { provider, model, suggested_action: "Retry or choose another model." },
  );
}

export async function generateExternalResponse(
  config: ExternalProviderConfig,
  messages: ProviderMessage[],
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (config.type === "anthropic") return await anthropicResponse(config, messages, fetcher);
  if (config.type === "google") return await googleResponse(config, messages, fetcher);
  if (config.type === "aws-bedrock") return await bedrockResponse(config, messages, fetcher);
  return await openAiCompatibleResponse(config, messages, fetcher);
}
