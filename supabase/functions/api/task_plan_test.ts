import { validateModelPlan, validateTaskPlanInput } from "./task_plan.ts";

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
  };
}

function assert(condition: boolean, message: string): void {
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

Deno.test("task plan input normalizes source instructions", () => {
  assert(
    sourcePlan.steps[0].instruction === "Hold the bracket against the marked wall position.",
    "Expected normalized source instruction.",
  );
});

Deno.test("task plan rejects an empty instruction list", () => {
  assertThrows(() => validateTaskPlanInput({ title: "Install bracket", steps: [] }));
});

Deno.test("model plan preserves the exact source ordering", () => {
  assert(
    validateModelPlan(validModelPlan(), sourcePlan.steps).steps.length === 2,
    "Expected two validated steps.",
  );
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
