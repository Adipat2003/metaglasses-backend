import { createPlanWithModel, initialPlanRequest } from "./task_plan_create.ts";
import { validateTaskPlanInput } from "./task_plan.ts";

const input = validateTaskPlanInput({ title: "Tea", steps: [{ instruction: "Pour water." }] });
const proposal = { summary: "Organized the step.", steps: input.steps };
const requestId = "d86ca46b-95e4-4e26-96c3-524d56ec0614";

Deno.test("creation saves one model proposal and returns the stored plan", async () => {
  let calls = 0;
  const result = await createPlanWithModel(input, requestId, {
    createDraft: async () => ({ taskPlanId: "plan", currentVersion: 1, status: "draft" }),
    generate: async (plan) => {
      if (plan !== input) throw new Error("Incorrect source plan.");
      calls++;
      return proposal;
    },
    save: async (planId, id, value) => {
      if (planId !== "plan" || id !== requestId || value !== proposal) throw new Error("Bad save");
      return "saved";
    },
    read: async () => ({ taskPlanId: "plan", currentVersion: 2 }),
  });
  if (calls !== 1 || result.currentVersion !== 2) throw new Error("Incorrect creation result.");
});

Deno.test("retry returns an already generated plan without another model call", async () => {
  const plan = {
    taskPlanId: "plan",
    currentVersion: 2,
    status: "draft",
    revisionHistory: [{
      clientRequestId: requestId,
      request: initialPlanRequest,
    }],
  };
  const fail = () => {
    throw new Error("Unexpected dependency call.");
  };
  const result = await createPlanWithModel(input, requestId, {
    createDraft: async () => plan,
    generate: fail,
    save: fail,
    read: fail,
  });
  if (result !== plan) throw new Error("Expected existing plan.");
});

Deno.test("concurrent duplicate save returns the stored plan", async () => {
  const result = await createPlanWithModel(input, requestId, {
    createDraft: async () => ({ taskPlanId: "plan", currentVersion: 1, status: "draft" }),
    generate: async () => proposal,
    save: async () => "already_applied",
    read: async () => ({ currentVersion: 2 }),
  });
  if (result.currentVersion !== 2) throw new Error("Expected existing proposal.");
});

Deno.test("failed model call leaves the draft available for a retry", async () => {
  let saved = false;
  try {
    await createPlanWithModel(input, requestId, {
      createDraft: async () => ({ taskPlanId: "plan", currentVersion: 1, status: "draft" }),
      generate: async () => {
        throw new Error("unavailable");
      },
      save: async () => {
        saved = true;
        return "saved";
      },
      read: async () => ({}),
    });
    throw new Error("Expected failure.");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "unavailable" || saved) throw error;
  }
});

Deno.test("access and idempotency failures do not call the model", async () => {
  for (const access of ["forbidden", "idempotency_conflict"]) {
    const fail = () => {
      throw new Error("Unexpected dependency call.");
    };
    const result = await createPlanWithModel(input, requestId, {
      createDraft: async () => ({ access }),
      generate: fail,
      save: fail,
      read: fail,
    });
    if (result.access !== access) throw new Error("Expected access failure.");
  }
});

Deno.test("creation rejects a missing draft ID and stale state", async () => {
  for (
    const draft of [{ status: "draft", currentVersion: 1 }, {
      taskPlanId: "plan",
      status: "draft",
      currentVersion: 2,
    }]
  ) {
    const fail = () => {
      throw new Error("Unexpected dependency call.");
    };
    try {
      await createPlanWithModel(input, requestId, {
        createDraft: async () => draft,
        generate: fail,
        save: fail,
        read: fail,
      });
      throw new Error("Expected invalid draft rejection.");
    } catch (error) {
      if (
        !(error instanceof Error) || error.message === "Expected invalid draft rejection." ||
        error.message === "Unexpected dependency call."
      ) throw error;
    }
  }
});
