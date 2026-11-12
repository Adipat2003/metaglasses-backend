type ErrorContext = Record<string, string | number | boolean>;

function defaultErrorCode(status: number): string {
  const codes: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    410: "gone",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    503: "service_unavailable",
  };
  return codes[status] ?? (status >= 500 ? "internal_error" : "request_failed");
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly authenticate = false,
    readonly code = defaultErrorCode(status),
    readonly context: ErrorContext = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(
  error: unknown,
  requestId: string,
  corsHeaders: HeadersInit,
): Response {
  const safeError = error instanceof ApiError ? error : new ApiError(500, "Internal server error.");
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("X-Request-ID", requestId);
  if (safeError.authenticate) headers.set("WWW-Authenticate", "Bearer");
  const allowed = new Set([
    "failure_type",
    "upstream_status",
    "provider",
    "model",
    "suggested_action",
    "maximum_inline_image_bytes",
    "prior_upstream_statuses",
    "state_version",
  ]);
  const context = Object.fromEntries(
    Object.entries(safeError.context).filter(([key]) => allowed.has(key)),
  );
  if (!context.suggested_action && safeError.status === 429) {
    context.suggested_action = "Wait before retrying.";
  } else if (!context.suggested_action && safeError.status >= 500) {
    context.suggested_action =
      "Retry shortly. Contact support with the request ID if it continues.";
  }
  return new Response(
    JSON.stringify({
      detail: safeError.message,
      request_id: requestId,
      status: safeError.status,
      error: {
        type: safeError.name,
        code: safeError.code,
        message: safeError.message,
        ...(Object.keys(context).length ? { context } : {}),
      },
    }),
    { status: safeError.status, headers },
  );
}
