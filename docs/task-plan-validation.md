# Task-plan validation and live guidance

The AWS API supports user-authored structured plans, model-assisted refinement and review, explicit
approval, task runs, commands, and asynchronous observation of one to three uploaded images. The
[frontend handoff](backend-frontend-handoff.md#task-plans-create-review-refine-approve) contains
request examples, limits, responses, retry behavior, and the complete route list. The
[approval guidelines](task-plan-approval-guidelines.md) define the review rubric.

## Plan lifecycle

1. An authenticated user with an active pairing creates a plan with an ordered list of steps.
2. The user can request natural-language refinements. Each successful refinement creates a new
   version and clears the previous review. The title remains unchanged.
3. Validation is an optional preview. Approval runs a separate strict review of the current version.
   Backend checks enforce the review result, and only an explicit user action should call approval.
4. If approval fails, the user reads the saved blockers, refines the plan, and retries. A successful
   approval permits the user to start a run on the active pairing.

GLM 4.7 Flash (`zai.glm-4.7-flash`) handles refinement, validation, and strict approval review.
The backend checks the model's structured output and controls the approval transaction. A model
cannot approve a plan. See `supabase/functions/api/task_plan.ts` for the fixed model and validation.

## Run and observation

Starting a run publishes the first instruction to the lens display. The user can pause, resume,
repeat, confirm, skip, go back, correct, or stop through the command endpoint. Each accepted command
changes the state version. Clients submit the last observed version and must refresh after a conflict.

Clients upload JPEG or PNG frames, then submit an ordered window of one to three image IDs with
capture times, a sequence number, and the observed state version. A `202` response means queued,
not completed. The AWS process claims windows and uses `us.amazon.nova-lite-v1:0` for bounded
observations. The code may publish a confirmation or camera-correction prompt to the lens; the
observation cannot advance, confirm, skip, or stop a run. User commands own those transitions.
Stale results cannot update the current display.

The current API does not implement initial free-form plan generation, native video ingestion,
automatic step confirmation, a separate Nova 2 verification path, or an observation retrieval
endpoint. Do not build client behavior around those proposed features.

## Operations

The task-guidance smoke test and its side effects are documented in
[local development](local-development.md#aws-integration-smoke-test). Runtime and database
configuration, deployment, and recovery are in [AWS operations](aws-deployment.md). Model
availability and quotas must be checked in the target AWS account before relying on a cadence or
capacity estimate.
