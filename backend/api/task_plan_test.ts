import {
  parseModelJson,
  planValidatorModelId,
  refineTaskPlanWithModel,
  reviewTaskPlanForApprovalWithModel,
  TaskPlanProviderError,
  TaskPlanValidationError,
  validateModelPlan,
  validateTaskPlanFeedback,
  validateTaskPlanInput,
  validateTaskPlanRefinement,
  validateTaskPlanRevisionHistory,
} from "./task_plan.ts";

const sourcePlan = validateTaskPlanInput({
  title: "Install bracket",
  steps: [
    { instruction: "Hold the bracket against the marked wall position." },
    { instruction: "Check that the bracket is level." },
  ],
});

function validModelPlan(): Record<string, unknown> {
  return {
    planSummary: "Install a bracket in two steps.",
    needsUserClarification: false,
    clarificationQuestions: [],
    steps: sourcePlan.steps.map((step) => ({
      sourceStepOrdinal: step.ordinal,
      canonicalInstruction: step.instruction,
      visualAcceptanceCriteria: ["The step is visible."],
      riskLevel: "low",
      requiresUserConfirmation: false,
      allowedTransitions: ["remain_in_progress", "candidate_complete", "blocked"],
    })),
    planRisks: [],
    unsupportedClaims: [],
    guidelineChecks: { clarity: true, completeness: true, observability: true, safety: true },
    approvalBlockers: [],
  };
}

function assert(condition: boolean, message = "Assertion failed."): void {
  if (!condition) throw new Error(message);
}

function assertThrows(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error("Expected the action to throw.");
}

function detailedStep(instruction: string) {
  return {
    instruction,
    prechecks: ["Check the starting position."],
    postchecks: ["Inspect the result."],
    acceptanceCriteria: ["The bracket is in position."],
    safetyNotes: [],
    openQuestions: [],
  };
}

Deno.test("task plan input normalizes source instructions", () => {
  assert(
    sourcePlan.steps[0].instruction === "Hold the bracket against the marked wall position.",
    "Expected normalized source instruction.",
  );
});

Deno.test("task plan validator uses GLM 4.7 Flash", () => {
  assert(
    planValidatorModelId === "zai.glm-4.7-flash",
    "Expected the Bedrock GLM 4.7 Flash model ID.",
  );
});

Deno.test("task plan rejects an empty instruction list", () => {
  assertThrows(() => validateTaskPlanInput({ title: "Install bracket", steps: [] }));
});

Deno.test("task plan feedback is normalized and bounded", () => {
  assert(validateTaskPlanFeedback("  Make step two clearer.  ") === "Make step two clearer.");
  assertThrows(() => validateTaskPlanFeedback("   "));
  assertThrows(() => validateTaskPlanFeedback("x".repeat(2_001)));
});

Deno.test("refinement accepts a bounded proposed step list", () => {
  const revision = validateTaskPlanRefinement({
    changeSummary: "Clarified the level check.",
    steps: [
      detailedStep("Hold the bracket against the marked wall position."),
      detailedStep("Check the bracket level with a bubble level."),
    ],
  }, sourcePlan.title);
  assert(revision.steps[1].instruction === "Check the bracket level with a bubble level.");
  assert(revision.steps[1].acceptanceCriteria?.length === 1);
});

Deno.test("step details survive input validation and remain bounded", () => {
  const plan = validateTaskPlanInput({ title: "Plan", steps: [detailedStep("Do it.")] });
  assert(plan.steps[0].prechecks?.[0] === "Check the starting position.");
  assertThrows(() =>
    validateTaskPlanInput({
      title: "Plan",
      steps: [{ ...detailedStep("Do it."), prechecks: ["x".repeat(241)] }],
    })
  );
  assertThrows(() =>
    validateTaskPlanInput({
      title: "Plan",
      steps: [{ ...detailedStep("Do it."), postchecks: ["a", "b", "c", "d"] }],
    })
  );
  assertThrows(() =>
    validateTaskPlanRefinement(
      { changeSummary: "Updated", steps: [{ instruction: "Do it." }] },
      "Plan",
    )
  );
});

Deno.test("refinement rejects empty, oversized, or malformed proposals", () => {
  assertThrows(() => validateTaskPlanRefinement({ changeSummary: "No steps", steps: [] }, "Plan"));
  assertThrows(() =>
    validateTaskPlanRefinement({ changeSummary: "Bad", steps: [{ instruction: " " }] }, "Plan")
  );
  assertThrows(() =>
    validateTaskPlanRefinement({ changeSummary: " ", steps: [{ instruction: "Do it." }] }, "Plan")
  );
});

Deno.test("revision history is bounded and preserves idempotency keys", () => {
  const history = validateTaskPlanRevisionHistory([{
    clientRequestId: "f4480458-d081-7070-381b-28dc3d03ea39",
    request: "Make step two clearer.",
    summary: "Clarified the level check.",
  }]);
  assert(history.length === 1);
  assert(history[0].clientRequestId === "f4480458-d081-7070-381b-28dc3d03ea39");
  assertThrows(() => validateTaskPlanRevisionHistory(Array.from({ length: 11 }, () => ({}))));
});

Deno.test("sends current plan, conversation history, and feedback to the refiner", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              changeSummary: "Clarified the level check.",
              steps: sourcePlan.steps.map((step, index) =>
                detailedStep(
                  index === 1 ? "Check the bracket level with a bubble level." : step.instruction,
                )
              ),
            }),
          }],
        },
      },
    });
  };
  try {
    const result = await refineTaskPlanWithModel(
      "us-east-1",
      { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      sourcePlan,
      [{
        clientRequestId: "f4480458-d081-7070-381b-28dc3d03ea39",
        request: "Keep the existing order.",
        summary: "The order was preserved.",
      }],
      "Make step two say how to check level.",
      { planSummary: "Install the bracket in two steps." },
    );
    assert(result.steps[1].instruction === "Check the bracket level with a bubble level.");
    const content = (requestBody?.messages as Array<{ content: Array<{ text: string }> }>)[0]
      .content[0].text;
    assert(content.includes("Make step two say how to check level."));
    assert(content.includes("The order was preserved."));
    assert(content.includes("Install the bracket in two steps."));
    assert(
      (requestBody?.system as Array<{ text: string }>)[0].text.includes("untrusted user data"),
    );
    const format = (requestBody?.outputConfig as {
      textFormat: { type: string; structure: { jsonSchema: { schema: string } } };
    }).textFormat;
    assert(format.type === "json_schema");
    const schema = JSON.parse(format.structure.jsonSchema.schema);
    assert(schema.properties.steps.items.required.includes("acceptanceCriteria"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("initial generation rejects changed or missing actions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (
      const steps of [
        [
          detailedStep("Replace the requested action."),
          detailedStep(sourcePlan.steps[1].instruction),
        ],
        [detailedStep(sourcePlan.steps[0].instruction)],
      ]
    ) {
      globalThis.fetch = async () =>
        Response.json({
          output: {
            message: { content: [{ text: JSON.stringify({ changeSummary: "Updated", steps }) }] },
          },
        });
      try {
        await refineTaskPlanWithModel(
          "us-east-1",
          { accessKeyId: "test-key", secretAccessKey: "test-secret" },
          sourcePlan,
          [],
          "Create a plan.",
          null,
          true,
        );
        throw new Error("Expected source mapping failure.");
      } catch (error) {
        if (!(error instanceof TaskPlanValidationError)) throw error;
        assert(error.reason === "source_mapping_mismatch");
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("approval review uses stricter explicit guidelines", async () => {
  const originalFetch = globalThis.fetch;
  let systemPrompt = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    systemPrompt = body.system[0].text;
    return Response.json({
      output: { message: { content: [{ text: JSON.stringify(validModelPlan()) }] } },
    });
  };
  try {
    const result = await reviewTaskPlanForApprovalWithModel(
      "us-east-1",
      { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      sourcePlan,
    );
    assert(result.approvalReady);
    assert(systemPrompt.includes("independent final approval reviewer"));
    assert(systemPrompt.includes("Be strict"));
    assert(systemPrompt.includes("visual verification"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("model plan preserves the exact source ordering", () => {
  const validated = validateModelPlan(validModelPlan(), sourcePlan.steps);
  assert(validated.steps.length === 2, "Expected two validated steps.");
  assert(validated.approvalReady, "Expected the fully passing review to be approval ready.");
});

Deno.test("failed guideline checks create an approval blocker", () => {
  const modelPlan = validModelPlan();
  (modelPlan.guidelineChecks as Record<string, boolean>).observability = false;
  const validated = validateModelPlan(modelPlan, sourcePlan.steps);
  assert(!validated.approvalReady, "A failed guideline must block approval.");
  assert(
    validated.approvalBlockers.includes("Make every step visually verifiable."),
    "Expected an actionable observability blocker.",
  );
});

Deno.test("missing visual evidence criteria blocks approval even if the model says pass", () => {
  const modelPlan = validModelPlan();
  (modelPlan.steps as Array<Record<string, unknown>>)[0].visualAcceptanceCriteria = [];
  const validated = validateModelPlan(modelPlan, sourcePlan.steps);
  assert(!validated.approvalReady, "A step without visual criteria cannot pass review.");
  assert(!validated.guidelineChecks.observability);
  assert(validated.approvalBlockers.includes("Make every step visually verifiable."));
});

Deno.test("high-risk actions without confirmation block approval", () => {
  const modelPlan = validModelPlan();
  (modelPlan.steps as Array<Record<string, unknown>>)[0].riskLevel = "high";
  const validated = validateModelPlan(modelPlan, sourcePlan.steps);
  assert(!validated.approvalReady, "High-risk actions require confirmation.");
  assert(
    validated.approvalBlockers.includes("High-risk steps must require user confirmation."),
    "Expected the high-risk confirmation blocker.",
  );
});

Deno.test("unsupported claims and clarification questions block approval", () => {
  const modelPlan = validModelPlan();
  modelPlan.unsupportedClaims = ["The bracket is definitely anchored in a stud."];
  modelPlan.needsUserClarification = true;
  modelPlan.clarificationQuestions = ["Which wall material is present?"];
  const validated = validateModelPlan(modelPlan, sourcePlan.steps);
  assert(!validated.approvalReady, "Unresolved claims and questions must block approval.");
  assert(validated.approvalBlockers.includes("Resolve unsupported claims before approval."));
  assert(validated.approvalBlockers.includes("Which wall material is present?"));
});

Deno.test("unresolved source questions block approval even when the model passes", () => {
  const steps = sourcePlan.steps.map((step, index) => ({
    ...step,
    openQuestions: index === 0 ? ["Which wall material?"] : [],
  }));
  const validated = validateModelPlan(validModelPlan(), steps);
  assert(!validated.approvalReady);
  assert(!validated.guidelineChecks.completeness);
});

Deno.test("review uses the backend source instruction without requiring a model copy", async () => {
  const originalFetch = globalThis.fetch;
  const review = validModelPlan();
  for (const step of review.steps as Array<Record<string, unknown>>) {
    delete step.canonicalInstruction;
  }
  globalThis.fetch = async () =>
    Response.json({ output: { message: { content: [{ text: JSON.stringify(review) }] } } });
  try {
    const result = await reviewTaskPlanForApprovalWithModel("us-east-1", {
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    }, sourcePlan);
    assert(result.steps[0].canonicalInstruction === sourcePlan.steps[0].instruction);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("review rejects a model response that changes step order", async () => {
  const originalFetch = globalThis.fetch;
  const review = validModelPlan();
  (review.steps as Array<Record<string, unknown>>).reverse();
  globalThis.fetch = async () =>
    Response.json({ output: { message: { content: [{ text: JSON.stringify(review) }] } } });
  try {
    await reviewTaskPlanForApprovalWithModel(
      "us-east-1",
      { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      sourcePlan,
    );
    throw new Error("Expected invalid response.");
  } catch (error) {
    if (!(error instanceof TaskPlanValidationError)) throw error;
    assert(error.reason === "source_mapping_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("review conservatively resolves inconsistent clarification fields", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (
      const [flag, questions] of [[false, ["What quantity?"]], [true, []]] as Array<
        [boolean, string[]]
      >
    ) {
      const review = validModelPlan();
      review.needsUserClarification = flag;
      review.clarificationQuestions = questions;
      globalThis.fetch = async () =>
        Response.json({ output: { message: { content: [{ text: JSON.stringify(review) }] } } });
      const result = await reviewTaskPlanForApprovalWithModel("us-east-1", {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      }, sourcePlan);
      assert(result.needsUserClarification);
      assert(result.clarificationQuestions.length > 0);
      assert(!result.approvalReady);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("extra model review steps cannot enter the plan or pass approval", async () => {
  const originalFetch = globalThis.fetch;
  const review = validModelPlan();
  (review.steps as Array<Record<string, unknown>>).push({ sourceStepOrdinal: 3 });
  globalThis.fetch = async () =>
    Response.json({ output: { message: { content: [{ text: JSON.stringify(review) }] } } });
  try {
    const result = await reviewTaskPlanForApprovalWithModel("us-east-1", {
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    }, sourcePlan);
    assert(result.steps.length === sourcePlan.steps.length);
    assert(!result.approvalReady);
    assert(!result.guidelineChecks.completeness);
    assert(result.approvalBlockers.some((value) => value.includes("additional steps")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("model plan rejects rewritten canonical instructions", () => {
  const modelPlan = validModelPlan();
  (modelPlan.steps as Array<Record<string, unknown>>)[0].canonicalInstruction = "Use a drill.";
  assertThrows(() => validateModelPlan(modelPlan, sourcePlan.steps));
});

Deno.test("model plan rejects reordering", () => {
  const modelPlan = validModelPlan();
  (modelPlan.steps as Array<Record<string, unknown>>).reverse();
  assertThrows(() => validateModelPlan(modelPlan, sourcePlan.steps));
});

Deno.test("model plan requires clarification questions when clarification is needed", () => {
  const modelPlan = validModelPlan();
  modelPlan.needsUserClarification = true;
  assertThrows(() => validateModelPlan(modelPlan, sourcePlan.steps));
});

Deno.test("parses model JSON wrapped in a markdown fence or prose", () => {
  const expected = '{"summary":"ok","confidence":0.5}';
  for (
    const text of [
      expected,
      "```json\n" + expected + "\n```",
      "Here you go:\n" + expected + "\nDone.",
    ]
  ) {
    assert(JSON.stringify(parseModelJson(text)) === expected, `should parse: ${text}`);
  }
});

Deno.test("plan model rejects an upstream error without exposing its body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("private provider details", { status: 429 });
  try {
    await refineTaskPlanWithModel(
      "us-east-1",
      {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
      sourcePlan,
      [],
      "Clarify the plan.",
      null,
    );
    throw new Error("Expected provider failure.");
  } catch (error) {
    if (!(error instanceof TaskPlanProviderError)) throw error;
    assert(error.upstreamStatus === 429);
    assert(!error.message.includes("private provider details"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("plan model rejects a malformed response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ output: { message: { content: [{ text: "no JSON" }] } } });
  try {
    await refineTaskPlanWithModel(
      "us-east-1",
      {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
      sourcePlan,
      [],
      "Clarify the plan.",
      null,
    );
    throw new Error("Expected invalid response.");
  } catch (error) {
    if (!(error instanceof TaskPlanValidationError)) throw error;
    assert(error.reason === "invalid_json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("plan model rejects truncated output even when the JSON is valid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      stopReason: "max_tokens",
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              changeSummary: "Complete",
              steps: sourcePlan.steps,
            }),
          }],
        },
      },
    });
  try {
    await refineTaskPlanWithModel(
      "us-east-1",
      {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
      sourcePlan,
      [],
      "Clarify the plan.",
      null,
    );
    throw new Error("Expected incomplete model response.");
  } catch (error) {
    if (!(error instanceof TaskPlanValidationError)) throw error;
    assert(error.reason === "incomplete_response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
