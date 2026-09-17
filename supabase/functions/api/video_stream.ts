export const maxVideoChunkBytes = 1024 * 1024;
export const maxPendingVideoMessages = 8;
export const maxVideoSessionMilliseconds = 120_000;

export type VideoStreamControl =
  | {
    type: "start";
    contentType: string;
    codec?: string;
    mode: "transport" | "nvidia";
    prompt: string;
  }
  | { type: "ping" }
  | { type: "stop" };

export class VideoStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoStreamProtocolError";
  }
}

function optionalCodec(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new VideoStreamProtocolError("codec must be a string when provided.");
  }
  const codec = value.trim();
  if (!codec || codec.length > 80 || /[\u0000-\u001f\u007f]/.test(codec)) {
    throw new VideoStreamProtocolError("codec must be 1 to 80 printable characters.");
  }
  return codec;
}

export function parseVideoStreamControl(value: string): VideoStreamControl {
  if (value.length > 2_048) {
    throw new VideoStreamProtocolError("Control messages must not exceed 2048 characters.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new VideoStreamProtocolError("Control messages must be valid JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new VideoStreamProtocolError("Control messages must be JSON objects.");
  }

  const message = payload as Record<string, unknown>;
  if (message.type === "ping") return { type: "ping" };
  if (message.type === "stop") return { type: "stop" };
  if (message.type !== "start") {
    throw new VideoStreamProtocolError("Unknown video stream control message.");
  }
  if (typeof message.contentType !== "string") {
    throw new VideoStreamProtocolError("start.contentType must be a video media type.");
  }
  const contentType = message.contentType.trim().toLowerCase();
  if (
    !/^video\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\u0000-\u001f\u007f]*)?$/.test(contentType) ||
    contentType.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(contentType)
  ) {
    throw new VideoStreamProtocolError("start.contentType must be a valid video media type.");
  }
  const codec = optionalCodec(message.codec);
  const mode = message.mode ?? "transport";
  if (mode !== "transport" && mode !== "nvidia") {
    throw new VideoStreamProtocolError("mode must be transport or nvidia.");
  }
  if (mode === "nvidia" && contentType.split(";", 1)[0].trim() !== "video/mp4") {
    throw new VideoStreamProtocolError("NVIDIA mode requires complete video/mp4 clips.");
  }
  const prompt = message.prompt ??
    "Describe the visible actions in this video in one short sentence.";
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1_200) {
    throw new VideoStreamProtocolError("prompt must contain 1 to 1200 characters.");
  }
  return { type: "start", contentType, mode, prompt: prompt.trim(), ...(codec ? { codec } : {}) };
}

export async function videoChunkByteLength(value: unknown): Promise<number | null> {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  return null;
}
