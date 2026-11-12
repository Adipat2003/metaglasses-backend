const environment: Record<string, string> = {
  APP_ENV: "local",
  AWS_REGION: "us-east-1",
  COGNITO_USER_POOL_ID: "us-east-1_TestPool",
  COGNITO_APP_CLIENT_ID: "test-client",
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "test",
  PAIRING_IMAGE_BUCKET: "test-bucket",
};
for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
const { handleApiRequest, logInference, verifier } = await import("./index.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertEnvelope(response: Response, status: number, code: string): Promise<void> {
  assert(response.status === status, `Expected ${status}, received ${response.status}`);
  const body = await response.json();
  const requestId = response.headers.get("x-request-id");
  assert(requestId && body.request_id === requestId, "Request ID mismatch");
  assert(body.status === status, "Status differs from HTTP status");
  assert(body.error.type === "ApiError" && body.error.code === code, "Incorrect error contract");
  assert(
    typeof body.detail === "string" && body.detail === body.error.message,
    "Missing safe detail",
  );
  assert(response.headers.get("access-control-allow-origin") === "*", "Missing CORS header");
}

Deno.test("all phone routes reject missing authentication with the shared envelope", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const routes = [
    ["POST", "/v1/state"],
    ["POST", "/v1/chat"],
    ["POST", "/v1/images"],
    ["DELETE", `/v1/images/${id}`],
    ["POST", "/v1/task-plans"],
    ["GET", `/v1/task-plans/${id}`],
    ["POST", `/v1/task-plans/${id}/validate`],
    ["POST", `/v1/task-plans/${id}/refine`],
    ["POST", `/v1/task-plans/${id}/approve`],
    ["POST", "/v1/task-runs"],
    ["GET", `/v1/task-runs/${id}`],
    ["POST", `/v1/task-runs/${id}/commands`],
    ["POST", `/v1/task-runs/${id}/stop`],
    ["POST", `/v1/task-runs/${id}/inference-windows`],
  ];
  for (const [method, path] of routes) {
    const response = await handleApiRequest(new Request(`http://localhost${path}`, { method }));
    assert(
      response.headers.get("www-authenticate") === "Bearer",
      `Missing auth challenge: ${path}`,
    );
    await assertEnvelope(response, 401, "unauthorized");
  }
});

Deno.test("public route validation and unknown routes share the error contract", async () => {
  const cases = [
    ["GET", "/v1/display", 422, "validation_error"],
    ["GET", "/v1/display?token=invalid", 422, "validation_error"],
    ["GET", "/unknown", 404, "not_found"],
    ["POST", "/v1/task-plans/not-a-uuid/validate", 422, "validation_error"],
  ] as const;
  for (const [method, path, status, code] of cases) {
    await assertEnvelope(
      await handleApiRequest(new Request(`http://localhost${path}`, { method })),
      status,
      code,
    );
  }
});

Deno.test("health and preflight still carry request IDs", async () => {
  for (
    const [method, path, status] of [["GET", "/healthz", 200], [
      "OPTIONS",
      "/v1/chat",
      204,
    ]] as const
  ) {
    const response = await handleApiRequest(new Request(`http://localhost${path}`, { method }));
    assert(
      response.status === status && response.headers.get("x-request-id"),
      "Missing status or request ID",
    );
  }
});

Deno.test("logging failure never changes the API response", async () => {
  const previous = console.warn;
  console.warn = () => {
    throw new Error("logging unavailable");
  };
  try {
    const response = await handleApiRequest(
      new Request("http://localhost/v1/state", { method: "POST" }),
    );
    await assertEnvelope(response, 401, "unauthorized");
  } finally {
    console.warn = previous;
  }
});

Deno.test("unknown request paths and query strings are not logged", async () => {
  const previous = console.warn;
  let log = "";
  console.warn = (...args: unknown[]) => {
    log = args.join(" ");
  };
  try {
    const response = await handleApiRequest(
      new Request("http://localhost/private-value?token=private-value"),
    );
    await assertEnvelope(response, 404, "not_found");
    assert(!log.includes("private-value"), "Unrecognized path or query leaked to logs");
    assert(JSON.parse(log).route === "unmatched", "Missing safe route label");
  } finally {
    console.warn = previous;
  }
});

Deno.test("route inventory requires coverage updates when endpoints change", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const staticRoutes = [...source.matchAll(/path === "([^"]+)"/g)].map((match) => match[1]).sort();
  const expected = [
    "/healthz",
    "/v1/state",
    "/v1/display",
    "/v1/chat",
    "/v1/images",
    "/v1/task-plans",
    "/v1/task-runs",
  ].sort();
  assert(
    JSON.stringify(staticRoutes) === JSON.stringify(expected),
    "Update the route error coverage for added or changed routes",
  );
  const dynamicRoutes = [...source.matchAll(/path\.match\(\/([^\n]+?)\/\)/g)];
  assert(
    dynamicRoutes.length === 6,
    "Update the route error coverage for added or changed parameterized routes",
  );
});

Deno.test("authenticated validation failures use the shared envelope before dependencies", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  verifier.cacheJwks({
    keys: [{ n: jwk.n!, e: jwk.e!, kid: "test-key", alg: "RS256", use: "sig", kty: "RSA" }],
  });
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const head = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encode({
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
    client_id: "test-client",
    token_use: "access",
    sub: "11111111-1111-4111-8111-111111111111",
    exp: 4102444800,
  });
  const bytes = new TextEncoder().encode(`${head}.${payload}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, bytes),
  );
  const encodedSignature = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
  const token = `${head}.${payload}.${encodedSignature}`;
  const id = "11111111-1111-4111-8111-111111111111";
  const cases: Array<[string, string, string, number, string]> = [
    ["POST", "/v1/state", "{}", 422, "validation_error"],
    [
      "POST",
      "/v1/state",
      JSON.stringify({ pairingToken: "a".repeat(32), state: "invalid" }),
      422,
      "validation_error",
    ],
    ["POST", "/v1/state", "{", 422, "validation_error"],
    ["POST", "/v1/chat", "{}", 422, "validation_error"],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ pairingToken: "a".repeat(32), messages: [] }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({
        pairingToken: "a".repeat(32),
        messages: [{ role: "system", content: "x" }],
      }),
      422,
      "validation_error",
    ],
    ["POST", "/v1/images", "", 422, "validation_error"],
    ["DELETE", `/v1/images/${id}`, "", 422, "validation_error"],
    ["POST", "/v1/task-plans", "{}", 422, "validation_error"],
    [
      "POST",
      "/v1/task-plans",
      JSON.stringify({
        pairingToken: "a".repeat(32),
        clientRequestId: id,
        title: "Test",
        steps: [],
      }),
      422,
      "task_plan_invalid",
    ],
    ["POST", "/v1/task-runs", "{}", 422, "validation_error"],
    ["POST", `/v1/task-plans/${id}/refine`, "{}", 422, "validation_error"],
    ["POST", `/v1/task-runs/${id}/commands`, "{}", 422, "validation_error"],
    [
      "POST",
      `/v1/task-runs/${id}/commands`,
      JSON.stringify({ clientRequestId: id, command: "pause", expectedStateVersion: 0 }),
      422,
      "validation_error",
    ],
    ["POST", `/v1/task-runs/${id}/stop`, "{}", 422, "validation_error"],
    ["POST", `/v1/task-runs/${id}/inference-windows`, "{}", 422, "validation_error"],
  ];
  for (const [method, path, body, status, code] of cases) {
    const response = await handleApiRequest(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: body || undefined,
      }),
    );
    await assertEnvelope(response, status, code);
  }
});

Deno.test("OpenAPI covers the router's endpoint paths and shared error response", async () => {
  const source = await Deno.readTextFile(new URL("../../docs/api-openapi.yaml", import.meta.url));
  const paths = [...source.matchAll(/^  (\/[^:\s]+):$/gm)].map((match) => match[1]).sort();
  const expected = [
    "/healthz",
    "/v1/state",
    "/v1/display",
    "/v1/chat",
    "/v1/images",
    "/v1/images/{imageId}",
    "/v1/task-plans",
    "/v1/task-plans/{taskPlanId}",
    "/v1/task-plans/{taskPlanId}/validate",
    "/v1/task-plans/{taskPlanId}/refine",
    "/v1/task-plans/{taskPlanId}/approve",
    "/v1/task-runs",
    "/v1/task-runs/{taskRunId}",
    "/v1/task-runs/{taskRunId}/commands",
    "/v1/task-runs/{taskRunId}/stop",
    "/v1/task-runs/{taskRunId}/inference-windows",
  ].sort();
  assert(
    JSON.stringify(paths) === JSON.stringify(expected),
    "OpenAPI paths differ from route coverage",
  );
  for (const path of paths) {
    const block = source.split(`  ${path}:\n`)[1].split(/\n  \/|\ncomponents:/)[0];
    assert(block.includes("#/components/responses/Error"), `Missing error response for ${path}`);
  }
});

Deno.test("inference logger preserves structured data and tolerates logging failure", () => {
  const previous = console.error;
  let output = "";
  console.error = (...args: unknown[]) => {
    output = args.join(" ");
  };
  try {
    logInference("error", { event: "task_inference_failed", upstream_status: 503 });
    assert(JSON.parse(output).upstream_status === 503, "Missing safe diagnostic status");
    console.error = () => {
      throw new Error("log unavailable");
    };
    logInference("error", { event: "task_inference_failed" });
  } finally {
    console.error = previous;
  }
});
