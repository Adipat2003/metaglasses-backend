import {
  ExternalProviderError,
  generateExternalResponse,
  parseExternalProvider,
  ProviderConfigurationError,
  signedBedrockRequest,
} from "./providers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  assert(typeof init?.body === "string", "request body should be JSON text");
  return JSON.parse(init.body) as Record<string, unknown>;
}

const textMessages = [{ role: "user" as const, text: "Hello", images: [] }];

Deno.test("parses supported stateless provider configurations", () => {
  for (
    const type of [
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
    ]
  ) {
    const provider = parseExternalProvider({ type, apiKey: "user-secret", model: "model-1" });
    assert(provider?.type === type, `${type} should be supported`);
  }
  const azure = parseExternalProvider({
    type: "azure",
    apiKey: "user-secret",
    model: "deployment-1",
    endpoint: "https://example.openai.azure.com",
  });
  assert(azure?.type === "azure", "Azure should be supported");
  const aws = parseExternalProvider({
    type: "aws-bedrock",
    accessKeyId: "TESTACCESSKEY00000000",
    secretAccessKey: "user-secret",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    region: "us-east-1",
  });
  assert(aws?.type === "aws-bedrock", "AWS Bedrock should be supported");
});

Deno.test("rejects arbitrary endpoints and incomplete provider credentials", () => {
  for (
    const value of [
      { type: "custom", apiKey: "secret", model: "model" },
      {
        type: "azure",
        apiKey: "secret",
        model: "model",
        endpoint: "https://attacker.example.com",
      },
      { type: "openai", model: "model" },
    ]
  ) {
    let error: unknown;
    try {
      parseExternalProvider(value);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof ProviderConfigurationError, "invalid configuration should fail safely");
  }
});

Deno.test("formats OpenAI-compatible multimodal requests without system injection", async () => {
  const provider = parseExternalProvider({
    type: "openai",
    apiKey: "user-secret",
    model: "gpt-4.1-mini",
  });
  assert(provider, "provider should parse");
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const answer = await generateExternalResponse(
    provider,
    [{
      role: "user",
      text: "Describe this",
      images: [{ contentType: "image/jpeg", url: "https://images.example.test/signed" }],
    }],
    (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "A bicycle." } }] }),
      );
    },
  );

  assert(answer === "A bicycle.", "provider text should be returned");
  assert(requestedUrl === "https://api.openai.com/v1/chat/completions", "URL should be fixed");
  const headers = new Headers(requestedInit?.headers);
  assert(headers.get("authorization") === "Bearer user-secret", "key should authorize request");
  const body = JSON.stringify(requestBody(requestedInit));
  assert(body.includes("image_url"), "image should use OpenAI multimodal content");
  assert(!body.includes('"system"'), "no system message should be injected");
  assert(!body.includes("user-secret"), "credentials should not enter the request body");
});

Deno.test("returns actionable credential errors without exposing the credential", async () => {
  const provider = parseExternalProvider({
    type: "anthropic",
    apiKey: "never-log-this-secret",
    model: "claude-sonnet-4-5",
  });
  assert(provider, "provider should parse");
  let error: unknown;
  try {
    await generateExternalResponse(provider, textMessages, () =>
      Promise.resolve(
        Response.json({ error: { type: "authentication_error" } }, { status: 401 }),
      ));
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof ExternalProviderError, "provider error should be typed");
  assert(error.status === 422, "provider credentials should not look like app authentication");
  assert(error.code === "provider_auth_rejected", "error code should identify credentials");
  assert(error.message.includes("API key"), "message should tell the user what to check");
  assert(error.context.suggested_action !== undefined, "error should include a next action");
  assert(!JSON.stringify(error).includes("never-log-this-secret"), "credential must be absent");
});

Deno.test("maps provider failures to distinct actionable errors", async () => {
  const provider = parseExternalProvider({
    type: "openai",
    apiKey: "never-log-this-secret",
    model: "gpt-example",
  });
  assert(provider, "provider should parse");
  const cases = [
    [400, "provider_request_rejected", 422],
    [404, "provider_model_not_found", 422],
    [429, "provider_rate_limited", 429],
    [500, "model_provider_error", 503],
  ] as const;

  for (const [upstreamStatus, expectedCode, expectedStatus] of cases) {
    let error: unknown;
    try {
      await generateExternalResponse(provider, textMessages, () =>
        Promise.resolve(
          Response.json({ error: { code: `test_${upstreamStatus}` } }, {
            status: upstreamStatus,
          }),
        ));
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof ExternalProviderError, `${upstreamStatus} should be typed`);
    assert(error.code === expectedCode, `${upstreamStatus} should map to ${expectedCode}`);
    assert(error.status === expectedStatus, `${upstreamStatus} should map to ${expectedStatus}`);
    assert(error.context.provider === "openai", "provider should be identified");
    assert(error.context.model === "gpt-example", "model should be identified");
    assert(error.context.upstream_status === upstreamStatus, "upstream status should be included");
    assert(error.context.suggested_action !== undefined, "recovery action should be included");
    assert(!JSON.stringify(error).includes("never-log-this-secret"), "credential must be absent");
  }
});

Deno.test("inlines signed images for Google Gemini", async () => {
  const provider = parseExternalProvider({
    type: "google",
    apiKey: "google-secret",
    model: "gemini-2.5-flash",
  });
  assert(provider, "provider should parse");
  let modelInit: RequestInit | undefined;
  const answer = await generateExternalResponse(
    provider,
    [{
      role: "user",
      text: "Describe this",
      images: [{ contentType: "image/png", url: "https://images.example.test/signed" }],
    }],
    (input, init) => {
      if (String(input).startsWith("https://images.example.test/")) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      }
      modelInit = init;
      return Promise.resolve(
        Response.json({ candidates: [{ content: { parts: [{ text: "A chart." }] } }] }),
      );
    },
  );

  assert(answer === "A chart.", "Gemini text should be returned");
  const body = JSON.stringify(requestBody(modelInit));
  assert(body.includes('"inline_data"'), "Gemini should receive inline image data");
  assert(body.includes('"AQID"'), "image bytes should be base64 encoded");
  assert(!body.includes("google-secret"), "Google credential must not enter the body");
});

Deno.test("signs AWS Bedrock requests without putting the secret in headers", async () => {
  const provider = parseExternalProvider({
    type: "aws-bedrock",
    accessKeyId: "TESTACCESSKEY00000000",
    secretAccessKey: "never-send-this-secret",
    sessionToken: "session-token",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    region: "us-east-1",
  });
  assert(provider?.type === "aws-bedrock", "AWS provider should parse");
  const request = await signedBedrockRequest(
    provider,
    '{"messages":[]}',
    new Date("2026-09-29T04:00:00.000Z"),
  );
  const headers = new Headers(request.init.headers);

  assert(request.url.startsWith("https://bedrock-runtime.us-east-1.amazonaws.com/model/"), "host");
  assert(headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=TEST"), "SigV4");
  assert(headers.get("x-amz-security-token") === "session-token", "session token should pass");
  assert(!JSON.stringify(request).includes("never-send-this-secret"), "secret must not be sent");
});
