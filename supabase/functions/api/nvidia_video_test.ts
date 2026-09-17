import {
  analyzeVideoClip,
  defaultVideoModel,
  validateMp4Clip,
  VideoModelError,
} from "./nvidia_video.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Structural fixture only, not a playable video.
function fixture(): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0,
    12,
    102,
    116,
    121,
    112,
    105,
    115,
    111,
    109,
    0,
    0,
    0,
    8,
    109,
    111,
    111,
    118,
    0,
    0,
    0,
    8,
    109,
    100,
    97,
    116,
  ]);
}

Deno.test("submits inline MP4 video to the separate Nemotron model", async () => {
  let called = false;
  const text = await analyzeVideoClip(fixture(), {
    apiKey: "test-only-key",
    prompt: "What is happening?",
    signal: new AbortController().signal,
    fetcher: (_url, init) => {
      called = true;
      const body = JSON.parse(String(init?.body));
      assert(body.model === defaultVideoModel, "Nemotron video model expected");
      assert(body.stream === false, "input is a finite clip, not output SSE");
      const parts = body.messages[0].content;
      assert(parts[0].text === "What is happening?", "prompt should be forwarded");
      assert(parts[1].type === "video_url", "video_url content expected");
      assert(parts[1].video_url.url.startsWith("data:video/mp4;base64,"), "inline data expected");
      assert(init?.signal instanceof AbortSignal, "cancellation should reach fetch");
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "A person walks." } }] }),
      );
    },
  });
  assert(called && text === "A person walks.", "model response expected");
});

Deno.test("rejects incomplete and fragmented MP4 containers", () => {
  for (const bytes of [new Uint8Array(8), fixture().subarray(0, 12)]) {
    let failed = false;
    try {
      validateMp4Clip(bytes);
    } catch (error) {
      failed = error instanceof VideoModelError;
    }
    assert(failed, "incomplete container should fail");
  }
  const fragmented = fixture();
  fragmented.set([109, 111, 111, 102], 16);
  try {
    validateMp4Clip(fragmented);
    throw new Error("fragmented clip unexpectedly accepted");
  } catch (error) {
    assert(
      error instanceof VideoModelError && error.code === "video_clip_fragmented",
      "fragment rejected",
    );
  }
});

Deno.test("returns safe rate limit errors without provider bodies", async () => {
  try {
    await analyzeVideoClip(fixture(), {
      apiKey: "test-only-key",
      prompt: "Describe.",
      signal: new AbortController().signal,
      fetcher: () => Promise.resolve(new Response("sensitive upstream details", { status: 429 })),
    });
    throw new Error("rate limit unexpectedly succeeded");
  } catch (error) {
    assert(error instanceof VideoModelError, "safe model error expected");
    assert(error.code === "video_model_rate_limited", "rate limit mapping expected");
    assert(!error.message.includes("sensitive"), "upstream body must not be exposed");
  }
});

Deno.test("does not submit an already cancelled clip", async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await analyzeVideoClip(fixture(), {
      apiKey: "test-only-key",
      prompt: "Describe.",
      signal: controller.signal,
      fetcher: () => {
        throw new Error("fetch must not run");
      },
    });
    throw new Error("cancelled request unexpectedly succeeded");
  } catch (error) {
    assert(
      error instanceof VideoModelError && error.code === "video_model_cancelled",
      "cancellation expected",
    );
  }
});

Deno.test("rejects empty model answers", async () => {
  try {
    await analyzeVideoClip(fixture(), {
      apiKey: "test-only-key",
      prompt: "Describe.",
      signal: new AbortController().signal,
      fetcher: () => Promise.resolve(Response.json({ choices: [{ message: { content: " " } }] })),
    });
    throw new Error("empty answer unexpectedly accepted");
  } catch (error) {
    assert(
      error instanceof VideoModelError && error.code === "video_model_invalid_response",
      "empty answer rejected",
    );
  }
});

Deno.test("polls pending video requests and supports model overrides", async () => {
  let calls = 0;
  const requestId = "12345678-1234-4234-8234-123456789012";
  const text = await analyzeVideoClip(fixture(), {
    apiKey: "test-only-key",
    prompt: "Describe.",
    signal: new AbortController().signal,
    model: "custom-video-model",
    baseUrl: "https://example.test/v1/",
    fetcher: (url, init) => {
      calls += 1;
      if (calls === 1) {
        assert(String(url) === "https://example.test/v1/chat/completions", "base URL expected");
        assert(JSON.parse(String(init?.body)).model === "custom-video-model", "override expected");
        return Promise.resolve(
          new Response(null, { status: 202, headers: { "NVCF-REQID": requestId } }),
        );
      }
      assert(String(url).endsWith(requestId), "poll request ID expected");
      assert(init?.signal instanceof AbortSignal, "poll must be cancellable");
      return Promise.resolve(Response.json({ choices: [{ message: { content: "An action." } }] }));
    },
  });
  assert(calls === 2 && text === "An action.", "pending result should be resolved");
});

Deno.test("cancels an in-flight pending video poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  try {
    await analyzeVideoClip(fixture(), {
      apiKey: "test-only-key",
      prompt: "Describe.",
      signal: controller.signal,
      fetcher: (_url, init) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 202,
              headers: { "NVCF-REQID": "12345678-1234-4234-8234-123456789012" },
            }),
          );
        }
        controller.abort();
        return Promise.reject(init?.signal?.reason);
      },
    });
    throw new Error("pending poll unexpectedly succeeded");
  } catch (error) {
    assert(
      error instanceof VideoModelError && error.code === "video_model_cancelled",
      "poll cancellation expected",
    );
  }
});
