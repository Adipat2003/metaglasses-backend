import {
  maxPendingVideoMessages,
  maxVideoChunkBytes,
  parseVideoStreamControl,
  videoChunkByteLength,
  VideoStreamProtocolError,
} from "./video_stream.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("parses video stream start metadata", () => {
  const message = parseVideoStreamControl(JSON.stringify({
    type: "start",
    contentType: "Video/MP4",
    codec: "avc1.42E01E",
  }));

  assert(message.type === "start", "start message should be returned");
  assert(message.contentType === "video/mp4", "content type should be normalized");
  assert(message.codec === "avc1.42E01E", "codec should be preserved");
  assert(message.mode === "transport", "existing clients should remain transport-only");
});

Deno.test("accepts opt-in NVIDIA video clip analysis", () => {
  const message = parseVideoStreamControl(
    '{"type":"start","contentType":"video/mp4","mode":"nvidia","prompt":"Describe this."}',
  );
  assert(message.type === "start" && message.mode === "nvidia", "analysis mode expected");
});

Deno.test("rejects non-MP4 inference and blank prompts", () => {
  for (
    const fields of [
      { contentType: "video/webm", mode: "nvidia" },
      { contentType: "video/mp4", mode: "nvidia", prompt: " " },
      { contentType: "video/mp4", mode: "unknown" },
    ]
  ) {
    let failed = false;
    try {
      parseVideoStreamControl(JSON.stringify({ type: "start", ...fields }));
    } catch (error) {
      failed = error instanceof VideoStreamProtocolError;
    }
    assert(failed, "invalid inference metadata should fail");
  }
});

Deno.test("accepts ping and stop controls", () => {
  assert(parseVideoStreamControl('{"type":"ping"}').type === "ping", "ping expected");
  assert(parseVideoStreamControl('{"type":"stop"}').type === "stop", "stop expected");
});

Deno.test("rejects non-video start metadata", () => {
  let error: unknown;
  try {
    parseVideoStreamControl('{"type":"start","contentType":"application/json"}');
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof VideoStreamProtocolError, "a protocol error should be raised");
});

Deno.test("rejects oversized control messages", () => {
  let error: unknown;
  try {
    parseVideoStreamControl("x".repeat(2_049));
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof VideoStreamProtocolError, "an oversized control should be rejected");
});

Deno.test("measures supported binary chunks", async () => {
  assert(await videoChunkByteLength(new ArrayBuffer(12)) === 12, "ArrayBuffer size expected");
  assert(await videoChunkByteLength(new Uint8Array(7)) === 7, "typed array size expected");
  assert(await videoChunkByteLength("not binary") === null, "text is not a binary chunk");
  assert(maxVideoChunkBytes === 1024 * 1024, "chunk limit should remain explicit");
  assert(maxPendingVideoMessages === 8, "pending message limit should remain explicit");
});
