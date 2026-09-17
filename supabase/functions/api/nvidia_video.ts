import { resolveNvidiaResponse } from "./nvidia.ts";

export const defaultVideoModel = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
export const videoInferenceTimeoutMilliseconds = 60_000;

export class VideoModelError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) {
    super("Video model request failed.");
    this.name = "VideoModelError";
  }
}

export function validateMp4Clip(bytes: Uint8Array): void {
  // This checks container structure, not codec support or decodability.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let hasMovie = false;
  let hasMedia = false;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const length = size === 0 ? bytes.length - offset : size;
    if (length < 8 || offset + length > bytes.length || (offset === 0 && type !== "ftyp")) {
      throw new VideoModelError("video_clip_invalid");
    }
    if (type === "moof") throw new VideoModelError("video_clip_fragmented");
    hasMovie ||= type === "moov";
    hasMedia ||= type === "mdat";
    offset += length;
  }
  if (offset !== bytes.length || !hasMovie || !hasMedia) {
    throw new VideoModelError("video_clip_invalid");
  }
}

function videoDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return `data:video/mp4;base64,${btoa(binary)}`;
}

export async function analyzeVideoClip(
  bytes: Uint8Array,
  options: {
    apiKey: string;
    prompt: string;
    signal: AbortSignal;
    baseUrl?: string;
    model?: string;
    fetcher?: typeof fetch;
  },
): Promise<string> {
  validateMp4Clip(bytes);
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(videoInferenceTimeoutMilliseconds),
  ]);
  try {
    signal.throwIfAborted();
    let response = await fetcher(
      `${
        (options.baseUrl ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "")
      }/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model ?? defaultVideoModel,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: options.prompt },
              { type: "video_url", video_url: { url: videoDataUrl(bytes) } },
            ],
          }],
          max_tokens: 1024,
          reasoning_budget: 256,
          temperature: 0.2,
          stream: false,
        }),
        signal,
      },
    );
    response = await resolveNvidiaResponse(response, {
      apiKey: options.apiKey,
      deadlineMilliseconds: Date.now() + videoInferenceTimeoutMilliseconds,
      signal,
      fetcher,
    });
    if (!response.ok) {
      throw new VideoModelError(
        response.status === 429 ? "video_model_rate_limited" : "video_model_provider_error",
        response.status,
      );
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim() || text.length > 8_192) {
      throw new VideoModelError("video_model_invalid_response");
    }
    signal.throwIfAborted();
    return text.trim();
  } catch (error) {
    if (error instanceof VideoModelError) throw error;
    throw new VideoModelError(
      options.signal.aborted ? "video_model_cancelled" : "video_model_request_failed",
    );
  }
}
