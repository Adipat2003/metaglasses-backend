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

test("sends phone guidance contracts with the caller's access token", async () => {
  const calls = [];
  const api = createClient({
    baseUrl: "https://api.example.invalid/v1-root",
    accessToken: "test-access",
    fetch: async (url, init) => {
      assert.equal(init.headers.get("authorization"), "Bearer test-access");
      calls.push([init.method, url.href, init.body ? JSON.parse(init.body) : undefined]);
      return Response.json({});
    },
  });
  const goal = { clientRequestId: uuid, goal: "Make a bookmark" };
  const approval = { clientRequestId: uuid, expectedVersion: 1 };
  const start = { clientRequestId: uuid, taskPlanId: uuid, expectedPlanVersion: 1 };
  const chat = {
    clientRequestId: uuid,
    taskRunId: uuid,
    expectedStateVersion: 1,
    observationWindowId: uuid,
    messages: [{ role: "user", content: "Which tool should I use?" }],
  };
  const activeRun = { taskRunId: uuid, expectedStateVersion: 1 };
  const resume = { clientRequestId: uuid, expectedStateVersion: 2, command: "resume", activeRun };
  const window = {
    clientRequestId: uuid,
    expectedStateVersion: 1,
    sequenceNumber: 1,
    question: "Is paper visible?",
    frames: [{ imageId: uuid, capturedAt: "2000-01-01T00:00:00.000Z" }],
  };
  await api.createTaskPlan(goal);
  await api.approveTaskPlan(uuid, approval);
  await api.approveTaskPlan(uuid);
  await api.startTaskRun(start);
  await api.listUnfinishedTaskRuns();
  await api.createChatResponse(chat);
  await api.commandTaskRun(uuid, resume);
  await api.submitInferenceWindow(uuid, window);
  await api.getInferenceWindow(uuid, uuid);
  const origin = "https://api.example.invalid/v1-root/v1";
  assert.deepEqual(calls, [
    ["POST", origin + "/task-plans", goal],
    ["POST", origin + `/task-plans/${uuid}/approve`, approval],
    ["POST", origin + `/task-plans/${uuid}/approve`, {}],
    ["POST", origin + "/task-runs", start],
    ["GET", origin + "/task-runs?status=unfinished", undefined],
    ["POST", origin + "/chat", chat],
    ["POST", origin + `/task-runs/${uuid}/commands`, resume],
    ["POST", origin + `/task-runs/${uuid}/inference-windows`, window],
    ["GET", origin + `/task-runs/${uuid}/inference-windows/${uuid}`, undefined],
  ]);
});

test("validates phone workflow fields before sending", () => {
  const api = createClient({
    baseUrl: "https://api.example.invalid",
    accessToken: "test-access",
    fetch: () => assert.fail("An invalid request reached fetch"),
  });
  const input = { clientRequestId: uuid, messages: [{ role: "user", content: "Hi" }] };
  assert.throws(() => api.createTaskPlan({ clientRequestId: uuid, goal: " " }), SdkValidationError);
  assert.throws(() => api.approveTaskPlan(uuid, { expectedVersion: 2 }), SdkValidationError);
  assert.throws(() => api.createChatResponse({ ...input, taskRunId: uuid }), SdkValidationError);
  assert.throws(() => api.createChatResponse({ ...input, observationWindowId: uuid }), SdkValidationError);
  assert.throws(() => api.commandTaskRun(uuid, {
    clientRequestId: uuid,
    expectedStateVersion: 1,
    command: "pause",
    activeRun: { taskRunId: uuid, expectedStateVersion: 1 },
  }), SdkValidationError);
  assert.throws(() => api.getInferenceWindow(uuid, "invalid"), SdkValidationError);
});

test("uploads and deletes phone images using their original scope", async () => {
  const calls = [];
  const api = createClient({
    baseUrl: "https://api.example.invalid",
    accessToken: "test-access",
    fetch: async (url, init) => {
      calls.push([init.method, url.pathname, url.search, init.body]);
      return init.method === "POST" ? Response.json({}, { status: 201 }) : new Response(null, { status: 204 });
    },
  });
  const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  await api.uploadImage(image);
  await api.uploadImage(image, { taskRunId: uuid, clientImageId: uuid });
  await api.deleteImage(uuid);
  await api.deleteImage(uuid, { taskRunId: uuid });
  const largeImage = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/jpeg" });
  await assert.rejects(api.uploadImage(largeImage, { taskRunId: uuid }), /no larger than 2 MiB/);
  assert.deepEqual(calls, [
    ["POST", "/v1/images", "", image],
    ["POST", "/v1/images", `?taskRunId=${uuid}&clientImageId=${uuid}`, image],
    ["DELETE", `/v1/images/${uuid}`, "", undefined],
    ["DELETE", `/v1/images/${uuid}`, `?taskRunId=${uuid}`, undefined],
  ]);
});
