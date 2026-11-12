import type { TaskPlanInput, TaskPlanRefinement } from "./task_plan.ts";

export const initialPlanRequest =
  "Organize the supplied steps into a clear task plan while preserving their intent and order.";

export class TaskPlanCreationConflict extends Error {}

export interface CreatePlanDependencies {
  createDraft(): Promise<Record<string, unknown>>;
  generate(input: TaskPlanInput): Promise<TaskPlanRefinement>;
  save(planId: string, requestId: string, proposal: TaskPlanRefinement): Promise<string>;
  read(planId: string): Promise<Record<string, unknown>>;
}

export async function createPlanWithModel(
  input: TaskPlanInput,
  requestId: string,
  dependencies: CreatePlanDependencies,
): Promise<Record<string, unknown>> {
  const plan = await dependencies.createDraft();
  if (plan.access !== undefined) return plan;
  if (typeof plan.taskPlanId !== "string") throw new Error("Draft plan has no ID.");
  const history = Array.isArray(plan.revisionHistory) ? plan.revisionHistory : [];
  if (history.some((item) => item?.clientRequestId === requestId)) return plan;
  if (plan.currentVersion !== 1 || plan.status !== "draft") {
    throw new TaskPlanCreationConflict("Initial plan version changed before generation.");
  }
  const proposal = await dependencies.generate(input);
  const result = await dependencies.save(plan.taskPlanId, requestId, proposal);
  if (result !== "saved" && result !== "already_applied") {
    throw new TaskPlanCreationConflict(`Initial plan generation could not be saved: ${result}`);
  }
  return await dependencies.read(plan.taskPlanId);
}
