import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiRequestError,
  SdkValidationError,
  createClient,
} from "../dist/client.js";

const uuid = "11111111-1111-4111-8111-111111111111";

test("requires a caller-configured API base URL", () => {
  assert.throws(() => createClient({}), SdkValidationError);
  assert.throws(() => createClient({ baseUrl: "https://user:secret@example.test" }), SdkValidationError);
});

test("validates input and authentication before sending a request", async () => {
  let requests = 0;
  const api = createClient({ baseUrl: "https://api.example.invalid", fetch: async () => {
    requests++;
    return new Response("{}", { status: 200 });
  } });

  assert.throws(() => api.listTaskPlans(), SdkValidationError);
  assert.throws(() => api.createTaskPlan({
    clientRequestId: uuid,
    title: "  ",
    steps: [{ instruction: "Do something" }],
  }), SdkValidationError);
  assert.equal(requests, 0);
});

test("calls named methods and returns their JSON result", async () => {
  let requestedUrl;
  const api = createClient({
    baseUrl: "https://api.example.invalid/root/",
    fetch: async (url) => {
      requestedUrl = new URL(url);
      return Response.json({ status: "ok", environment: "local", auth: "required" });
    },
  });

  const health = await api.getHealth();
  assert.equal(requestedUrl.pathname, "/root/healthz");
  assert.equal(health.status, "ok");
});

test("surfaces safe machine error details and the request ID", async () => {
  const api = createClient({
    baseUrl: "https://api.example.invalid",
    accessToken: "access-token",
    fetch: async () => Response.json({
      detail: "Plan changed.",
      request_id: uuid,
      status: 409,
      error: { type: "ApiError", code: "task_plan_changed", message: "Plan changed." },
    }, { status: 409, headers: { "x-request-id": uuid } }),
  });

  await assert.rejects(api.listTaskPlans(), (error) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "task_plan_changed");
    assert.equal(error.requestId, uuid);
    return true;
  });
});

test("checks pairing token format before network access", async () => {
  let requests = 0;
  const api = createClient({
    baseUrl: "https://api.example.invalid",
    accessToken: "access-token",
    fetch: async () => {
      requests++;
      return new Response(null, { status: 204 });
    },
  });

  assert.throws(() => api.getDisplay("short"), SdkValidationError);
  assert.equal(requests, 0);
});

test("checks image type and byte signature before uploading raw bytes", async () => {
  let received;
  const api = createClient({
    baseUrl: "https://api.example.invalid",
    accessToken: "access-token",
    fetch: async (url, init) => {
      received = { url: new URL(url), init };
      return Response.json({
        imageId: uuid,
        contentType: "image/jpeg",
        byteSize: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      }, { status: 201 });
    },
  });

  await assert.rejects(api.uploadPairingImage(
    "0123456789abcdef0123456789abcdef",
    new Blob(["not an image"], { type: "image/jpeg" }),
  ), SdkValidationError);
  assert.equal(received, undefined);

  const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  await api.uploadPairingImage("0123456789abcdef0123456789abcdef", image);
  assert.equal(received.url.searchParams.get("pairingToken"), "0123456789abcdef0123456789abcdef");
  assert.equal(received.init.body, image);
  assert.equal(received.init.headers.get("Content-Type"), "image/jpeg");
});
