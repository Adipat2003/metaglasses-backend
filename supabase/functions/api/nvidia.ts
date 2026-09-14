const defaultPollBaseUrl = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status";
const maximumPollSeconds = 30;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PollOptions {
  apiKey: string;
  deadlineMilliseconds: number;
  fetcher?: Fetcher;
  pollBaseUrl?: string;
}

export class NvidiaPendingResponseError extends Error {
  constructor(
    readonly code: string,
    readonly context: Record<string, string | number | boolean>,
  ) {
    super("NVIDIA returned an invalid pending response.");
    this.name = "NvidiaPendingResponseError";
  }
}

export async function resolveNvidiaResponse(
  initialResponse: Response,
  options: PollOptions,
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const pollBaseUrl = (options.pollBaseUrl ?? defaultPollBaseUrl).replace(/\/$/, "");
  let response = initialResponse;

  while (response.status === 202) {
    const requestId = response.headers.get("NVCF-REQID")?.trim() ?? "";
    if (!requestIdPattern.test(requestId)) {
      throw new NvidiaPendingResponseError("model_pending_response_invalid", {
        upstream_status: response.status,
      });
    }

    const remainingMilliseconds = options.deadlineMilliseconds - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new DOMException("NVIDIA polling deadline exceeded.", "TimeoutError");
    }
    const pollSeconds = Math.max(
      1,
      Math.min(maximumPollSeconds, Math.floor(remainingMilliseconds / 1_000)),
    );

    response = await fetcher(`${pollBaseUrl}/${encodeURIComponent(requestId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        "NVCF-POLL-SECONDS": String(pollSeconds),
      },
      signal: AbortSignal.timeout(Math.ceil(remainingMilliseconds)),
    });
  }

  return response;
}
