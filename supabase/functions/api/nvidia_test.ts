import {
  NvidiaPendingResponseError,
  resolveNvidiaResponse,
  resolveNvidiaResponseWithFallback,
} from "./nvidia.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("returns completed NVIDIA responses without polling", async () => {
  let calls = 0;
  const response = new Response('{"choices":[]}', { status: 200 });

  const resolved = await resolveNvidiaResponse(response, {
    apiKey: "test-key",
    deadlineMilliseconds: Date.now() + 10_000,
    fetcher: () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  });

  assert(resolved === response, "the completed response should be returned unchanged");
  assert(calls === 0, "completed responses should not be polled");
});

Deno.test("polls pending NVIDIA responses using their request ID", async () => {
  const requestId = "123e4567-e89b-12d3-a456-426614174000";
  let polledUrl = "";
  let polledInit: RequestInit | undefined;
  const pending = new Response(null, {
    status: 202,
    headers: { "NVCF-REQID": requestId },
  });

  const resolved = await resolveNvidiaResponse(pending, {
    apiKey: "test-key",
    deadlineMilliseconds: Date.now() + 10_000,
    fetcher: (input, init) => {
      polledUrl = String(input);
      polledInit = init;
      return Promise.resolve(
        new Response('{"choices":[{"message":{"content":"A bicycle."}}]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  });

  assert(resolved.status === 200, "polling should return the completed response");
  assert(
    polledUrl === `https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${requestId}`,
    "polling should use the NVIDIA status endpoint",
  );
  const headers = new Headers(polledInit?.headers);
  assert(headers.get("authorization") === "Bearer test-key", "polling should be authorized");
  assert(headers.get("nvcf-poll-seconds") !== null, "polling should use bounded long polling");
});

Deno.test("rejects pending NVIDIA responses without a valid request ID", async () => {
  const pending = new Response(null, { status: 202 });
  let error: unknown;

  try {
    await resolveNvidiaResponse(pending, {
      apiKey: "test-key",
      deadlineMilliseconds: Date.now() + 10_000,
    });
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof NvidiaPendingResponseError, "a typed polling error should be thrown");
  assert(error.code === "model_pending_response_invalid", "the error code should be actionable");
  assert(error.context.upstream_status === 202, "the pending status should be preserved");
});

Deno.test("uses the fallback model after a provider-side server error", async () => {
  let fallbackCalls = 0;
  const resolved = await resolveNvidiaResponseWithFallback(
    new Response(null, { status: 500 }),
    {
      apiKey: "test-key",
      deadlineMilliseconds: Date.now() + 10_000,
      fallback: () => {
        fallbackCalls += 1;
        return Promise.resolve(
          new Response('{"choices":[{"message":{"content":"A bicycle."}}]}', {
            status: 200,
          }),
        );
      },
    },
  );

  assert(resolved.response.status === 200, "the fallback response should be returned");
  assert(resolved.primaryStatus === 500, "the primary failure should be retained");
  assert(resolved.usedFallback, "the result should identify fallback use");
  assert(fallbackCalls === 1, "the fallback should be requested once");
});

Deno.test("does not use the fallback model for client and rate-limit errors", async () => {
  for (const status of [400, 401, 404, 429]) {
    let fallbackCalls = 0;
    const resolved = await resolveNvidiaResponseWithFallback(
      new Response(null, { status }),
      {
        apiKey: "test-key",
        deadlineMilliseconds: Date.now() + 10_000,
        fallback: () => {
          fallbackCalls += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
    );

    assert(resolved.response.status === status, `${status} should be returned unchanged`);
    assert(!resolved.usedFallback, `${status} should not use the fallback`);
    assert(fallbackCalls === 0, `${status} should not request the fallback`);
  }
});
