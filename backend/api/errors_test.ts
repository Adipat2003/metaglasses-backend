import { ApiError, errorResponse } from "./errors.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("every supported failure uses the same envelope and request ID", async () => {
  for (
    const [status, code] of [
      [400, "bad_request"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [410, "gone"],
      [413, "payload_too_large"],
      [415, "unsupported_media_type"],
      [422, "validation_error"],
      [429, "rate_limited"],
      [500, "internal_error"],
      [503, "service_unavailable"],
    ] as const
  ) {
    const requestId = crypto.randomUUID();
    const response = errorResponse(new ApiError(status, "Safe detail", status === 401), requestId, {
      "Access-Control-Allow-Origin": "*",
    });
    const body = await response.json();
    assert(response.status === status, `Incorrect HTTP status ${status}`);
    assert(response.headers.get("x-request-id") === requestId, "Missing correlation header");
    assert(response.headers.get("access-control-allow-origin") === "*", "Missing CORS header");
    assert(response.headers.get("content-type") === "application/json", "Incorrect content type");
    assert(body.status === status && body.request_id === requestId, "Incorrect envelope metadata");
    assert(
      body.detail === "Safe detail" && body.error.message === body.detail,
      "Incorrect message",
    );
    assert(body.error.type === "ApiError" && body.error.code === code, "Incorrect error code");
    if (status === 401) {
      assert(response.headers.get("www-authenticate") === "Bearer", "Missing auth challenge");
    }
    if (status === 429 || status >= 500) {
      assert(body.error.context.suggested_action, "Missing recovery action");
    }
  }
});

Deno.test("unexpected failures and provider bodies never reach the client", async () => {
  const failure = new Error("credential or internal detail");
  const generic = errorResponse(failure, "request-id", {});
  const genericText = await generic.text();
  assert(!genericText.includes(failure.message), "Unexpected exception leaked");
  assert(
    generic.status === 500 && genericText.includes("internal_error"),
    "Missing internal error",
  );
  const provider = new ApiError(503, "Provider unavailable", false, "model_provider_error", {
    provider: "nvidia",
    upstream_status: 503,
    provider_error_message: "private provider body",
    private_field: "sensitive",
  });
  const body = await (errorResponse(provider, "request-id", {})).text();
  assert(
    !body.includes("private provider body") && !body.includes("sensitive"),
    "Provider data leaked",
  );
  assert(body.includes("upstream_status"), "Safe upstream status missing");
});
