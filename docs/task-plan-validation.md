# Task-plan validation and live guidance

The AWS API supports user-authored structured plans, model-assisted generation and refinement,
review, explicit approval, task runs, commands, and asynchronous observation of one to three
uploaded images. The [API OpenAPI contract](api-openapi.yaml) specifies requests,
responses, and errors. The [frontend handoff](backend-frontend-handoff.md#task-plans-create-review-refine-approve)
explains the client flow, and the [approval guidelines](task-plan-approval-guidelines.md) define
the review rubric.

## Plan lifecycle

1. An authenticated user with an active pairing creates a plan with an ordered list of steps. The
   submitted normalized steps are saved as version 1; GLM generates a proposed version 2. The
   response includes the proposed steps and revision summary. The user must review the proposal.
2. If generation fails, the original draft remains. Retry the same request with the same
   `clientRequestId`. Reusing an ID with different input returns `409 task_plan_idempotency_conflict`.
   Concurrent retries may call the model more than once, but only one proposal is stored.
3. The user can request natural-language refinements. Each successful refinement creates a new
   version and clears the previous review. Initial generation uses one revision, leaving at most
   nine additional refinements. The title remains unchanged.
4. Validation is an optional preview, saved only if its reviewed version is still current. Approval
   runs a separate strict review of the current version. Backend checks enforce the review result,
   and only an explicit user action should call approval.
5. If approval fails, the user reads the saved blockers, refines the plan, and retries. A successful
   approval permits the user to start a run on the active pairing.

GLM 4.7 Flash (`zai.glm-4.7-flash`) handles generation, refinement, validation, and strict approval
review. The backend checks the model's structured output and controls persistence and approval.
A model cannot approve a plan. Calls use temperature zero, but separate model calls may produce
different outputs; saved results and idempotent retries use the persisted proposal.

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
