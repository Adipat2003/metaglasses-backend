import { FetchError, JwtParseError } from "npm:aws-jwt-verify@5.2.1/error";

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
const { handleApiRequest, logInference, verifier, taskPlanListQuery, runTaskPlanCleanup } =
  await import("./index.ts");
const { validateInferenceFrames, validateInferenceQuestion, validateTaskObservation } =
  await import("./index.ts");

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
    ["GET", "/v1/task-plans"],
    ["GET", `/v1/task-plans/${id}`],
    ["POST", `/v1/task-plans/${id}/validate`],
    ["POST", `/v1/task-plans/${id}/refine`],
    ["POST", `/v1/task-plans/${id}/approve`],
    ["POST", "/v1/task-runs"],
    ["GET", "/v1/task-runs?status=unfinished"],
    ["GET", `/v1/task-runs/${id}`],
    ["POST", `/v1/task-runs/${id}/commands`],
    ["POST", `/v1/task-runs/${id}/stop`],
    ["POST", `/v1/task-runs/${id}/inference-windows`],
    ["GET", `/v1/task-runs/${id}/inference-windows/${id}`],
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

Deno.test("transient Cognito failures are retryable without an auth challenge", async () => {
  const previousVerify = verifier.verify;
  try {
    for (
      const [error, status, code] of [
        [
          new FetchError("https://issuer.example.com", "transient failure"),
          503,
          "auth_unavailable",
        ],
        [new JwtParseError("invalid token"), 401, "auth_rejected"],
      ] as const
    ) {
      verifier.verify = () => Promise.reject(error);
      const response = await handleApiRequest(
        new Request("http://localhost/v1/chat", {
          method: "POST",
          headers: { authorization: "Bearer example" },
        }),
      );
      assert(
        response.headers.has("www-authenticate") === (status === 401),
        "Invalid auth challenge",
      );
      await assertEnvelope(response, status, code);
    }
  } finally {
    verifier.verify = previousVerify;
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
  const staticRoutes = [
    ...new Set([...source.matchAll(/path === "([^"]+)"/g)].map((match) => match[1])),
  ].sort();
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
  const dynamicRoutes = [...source.matchAll(/path\.match\(\s*\/([^\n]+?)\/,?\s*\)/g)];
  assert(
    dynamicRoutes.length === 7,
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
  const messages = [{ role: "user", content: "Help me with this step." }];
  const cases: Array<[string, string, string, number, string]> = [
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages, clientRequestId: id, taskRunId: id }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages, clientRequestId: id, observationWindowId: id }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages, clientRequestId: id, pairingToken: "a".repeat(32) }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages, clientRequestId: id, provider: { type: "invalid" } }),
      422,
      "provider_configuration_invalid",
    ],
    [
      "POST",
      "/v1/chat",
      JSON.stringify({ messages: Array(51).fill(messages[0]), clientRequestId: id }),
      413,
      "payload_too_large",
    ],
    [
      "POST",
      "/v1/task-plans",
      JSON.stringify({ clientRequestId: id, goal: "   " }),
      422,
      "task_plan_invalid",
    ],
    [
      "POST",
      "/v1/task-plans",
      JSON.stringify({ clientRequestId: id, goal: "Fold laundry", title: "Laundry" }),
      422,
      "task_plan_invalid",
    ],
    [
      "POST",
      `/v1/task-plans/${id}/approve`,
      JSON.stringify({ clientRequestId: id }),
      422,
      "validation_error",
    ],
    [
      "POST",
      `/v1/task-plans/${id}/approve`,
      JSON.stringify({ clientRequestId: id, expectedVersion: 2_147_483_648 }),
      422,
      "validation_error",
    ],
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
    ["POST", "/v1/images", "", 400, "bad_request"],
    ["POST", "/v1/images?clientImageId=invalid", "", 422, "validation_error"],
    ["POST", "/v1/images?taskRunId=invalid", "", 422, "validation_error"],
    ["POST", "/v1/images", "invalid image", 415, "unsupported_media_type"],
    [
      "POST",
      `/v1/images?taskRunId=${id}`,
      "a".repeat(2 * 1024 * 1024 + 1),
      413,
      "payload_too_large",
    ],
    [
      "DELETE",
      `/v1/images/${id}?pairingToken=${"a".repeat(32)}&taskRunId=${id}`,
      "",
      422,
      "validation_error",
    ],
    ["GET", `/v1/task-runs/${id}/inference-windows/invalid`, "", 422, "validation_error"],
    ["POST", "/v1/task-plans", "{}", 422, "validation_error"],
    [
      "POST",
      "/v1/task-plans",
      JSON.stringify({ clientRequestId: id, title: "Test", steps: [] }),
      422,
      "task_plan_invalid",
    ],
    ["GET", "/v1/task-plans?status=unknown", "", 422, "validation_error"],
    ["GET", "/v1/task-plans?limit=101", "", 422, "validation_error"],
    ["GET", "/v1/task-plans?offset=-1", "", 422, "validation_error"],
    ["GET", "/v1/task-plans?status=approved&status=draft", "", 422, "validation_error"],
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
    ["GET", "/v1/task-runs", "", 422, "validation_error"],
    ["GET", "/v1/task-runs?status=active", "", 422, "validation_error"],
    ["GET", "/v1/task-runs?status=unfinished&status=unfinished", "", 422, "validation_error"],
    ["GET", "/v1/task-runs?status=unfinished&extra=true", "", 422, "validation_error"],
    [
      "POST",
      "/v1/task-runs",
      JSON.stringify({ taskPlanId: id, clientRequestId: id, expectedPlanVersion: 2_147_483_648 }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/task-runs",
      JSON.stringify({ taskPlanId: id, clientRequestId: id, activeRun: null }),
      422,
      "validation_error",
    ],
    [
      "POST",
      "/v1/task-runs",
      JSON.stringify({ taskPlanId: id, clientRequestId: id, pairingToken: "bad" }),
      422,
      "validation_error",
    ],
    ["POST", `/v1/task-plans/${id}/refine`, "{}", 422, "validation_error"],
    ["POST", `/v1/task-runs/${id}/commands`, "{}", 422, "validation_error"],
    ...(["resume", "pause"] as const).map((command): [string, string, string, number, string] => [
      "POST",
      `/v1/task-runs/${id}/commands`,
      JSON.stringify({
        command,
        clientRequestId: id,
        expectedStateVersion: 1,
        activeRun: { taskRunId: id, expectedStateVersion: command === "resume" ? 0 : 1 },
      }),
      422,
      "validation_error",
    ]),
    [
      "POST",
      `/v1/task-runs/${id}/commands`,
      JSON.stringify({ clientRequestId: id, command: "pause", expectedStateVersion: 0 }),
      422,
      "validation_error",
    ],
    ["POST", `/v1/task-runs/${id}/stop`, "{}", 422, "validation_error"],
    ["POST", `/v1/task-runs/${id}/inference-windows`, "{}", 422, "validation_error"],
    [
      "POST",
      `/v1/task-runs/${id}/inference-windows`,
      JSON.stringify({
        clientRequestId: id,
        sequenceNumber: 1,
        expectedStateVersion: 1,
        frames: [{ imageId: id, capturedAt: "2020-01-01T00:00:00.000Z" }],
        question: "x".repeat(501),
      }),
      422,
      "validation_error",
    ],
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

Deno.test("plan list parameters have bounded deterministic defaults", () => {
  const defaults = taskPlanListQuery(new URL("http://localhost/v1/task-plans"));
  assert(
    defaults.status === null && defaults.limit === 50 && defaults.offset === 0,
    "Invalid defaults",
  );
  const approved = taskPlanListQuery(
    new URL("http://localhost/v1/task-plans?status=approved&limit=10&offset=20"),
  );
  assert(
    approved.status === "approved" && approved.limit === 10 && approved.offset === 20,
    "Invalid page",
  );
});

Deno.test("plan cleanup logs safe outcomes and prevents overlapping work", async () => {
  const originalInfo = console.info;
  const originalError = console.error;
  const logs: string[] = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await runTaskPlanCleanup(() => Promise.resolve(2));
    await runTaskPlanCleanup(() => Promise.reject(new Error("private database details")));
    assert(
      logs.length === 2 && !logs.join().includes("private database details"),
      "Unsafe cleanup logging",
    );
    assert(
      JSON.parse(logs[0]).deleted === 2 &&
        JSON.parse(logs[1]).error_code === "task_plan_cleanup_failed",
      "Missing cleanup outcome",
    );
    let release!: () => void;
    let called = false;
    const pending = runTaskPlanCleanup(() =>
      new Promise<number>((resolve) => {
        release = () => resolve(0);
      })
    );
    await runTaskPlanCleanup(() => {
      called = true;
      return Promise.resolve(0);
    });
    release();
    await pending;
    assert(!called, "Cleanup must not overlap itself");
  } finally {
    console.info = originalInfo;
    console.error = originalError;
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
    "/v1/task-runs/{taskRunId}/inference-windows/{windowId}",
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

function assertRejectsInput(callback: () => unknown): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("Expected invalid input to be rejected.");
}

Deno.test("inference validates ordered, unique frames while permitting old replay timestamps", () => {
  const first = {
    imageId: "ABCD0000-1111-4111-8111-111111111111",
    capturedAt: "2020-01-01T00:00:00.000Z",
  };
  const second = {
    imageId: "abcd0000-1111-4111-8111-111111111112",
    capturedAt: "2020-01-01T00:00:01.000Z",
  };
  const [parsed] = validateInferenceFrames([first, second]);
  assert(parsed.imageId === first.imageId.toLowerCase(), "UUID was not canonicalized");
  assert(parsed.capturedAt === first.capturedAt, "Replay timestamp changed");
  for (
    const frames of [
      [],
      [second, first],
      [first, { ...second, imageId: first.imageId.toLowerCase() }],
      [{ ...first, capturedAt: "2020-01-01" }],
      [{ ...first, capturedAt: "2020-02-31T00:00:00.000Z" }],
    ]
  ) {
    assertRejectsInput(() => validateInferenceFrames(frames));
  }
  assert(validateInferenceQuestion(undefined) === null, "Optional question became required");
  assert(
    validateInferenceQuestion(` ${"😀".repeat(500)} `)?.length === 1000,
    "Valid question did not use character count",
  );
  for (const question of [null, 42, "   ", "😀".repeat(501)]) {
    assertRejectsInput(() => validateInferenceQuestion(question));
  }
});

Deno.test("inference observations validate evidence and include a bounded answer for questions", () => {
  const candidate = {
    summary: " Cup visible. ",
    proposedTransition: "candidate_complete",
    confidence: 0.9,
    evidenceFrameIndexes: [0],
    answer: " A cup.\n",
  };
  const observation = validateTaskObservation(candidate, 1, true);
  assert(
    observation.answer === "A cup." && observation.summary === "Cup visible.",
    "Observation text was not normalized",
  );
  assert(!("answer" in validateTaskObservation(candidate, 1)), "Unexpected answer was exposed");
  for (
    const change of [
      { summary: "" },
      { confidence: 2 },
      { proposedTransition: "advance" },
      { evidenceFrameIndexes: [1] },
      { evidenceFrameIndexes: [0, 0] },
      { answer: "a".repeat(501) },
      { answer: undefined },
    ]
  ) {
    assertRejectsInput(() => validateTaskObservation({ ...candidate, ...change }, 1, true));
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
