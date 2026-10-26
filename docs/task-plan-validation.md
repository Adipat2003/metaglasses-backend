# Task-plan validation and live guidance design

## Status and decision

This document defines the target architecture for user-authored task plans and live visual
guidance. It is a design contract, not an implemented API.

The plan-validation model is **Claude Haiku 5.5** through the US geographic Bedrock inference
profile:

```text
us.anthropic.claude-haiku-5-5
```

Claude Haiku validates and normalizes the user's text plan. It does not approve the plan by
itself. Deterministic backend validation and explicit user approval are required before a plan
can start a camera-guidance run.

The visual-model split is deliberate:

| Responsibility | Owner | Model or mechanism |
| --- | --- | --- |
| Request shape, ownership, bounds, and safety policy | Backend code | Deterministic validation |
| Plan parsing, ambiguity detection, and suggested visual criteria | Plan validator | Claude Haiku 5.5 |
| Review, edits, and final authorization | User | Authenticated product UI |
| Live frame and short-video observation | Perception worker | Nova Lite |
| Ambiguous or high-consequence visual verification | Verification worker | Nova 2 Lite |
| Permitted task transitions and displayed canonical step | Backend code | Versioned state machine |

Use `us.amazon.nova-lite-v1:0` for the live visual loop. The account's 200 Geo cross-region
requests-per-minute quota supports the desired short-window cadence. Use
`us.amazon.nova-2-lite-v1:0` selectively because its account quota is 20 requests per minute.
Do not use either Nova model to validate a textual task plan.

## Goals and boundaries

- Let an authenticated user supply an ordered instruction list or paste free-form instructions.
- Preserve the user's original instructions as immutable source material.
- Produce a reviewable, normalized task plan with explicit completion criteria and safety controls.
- Start visual inference only after the user approves an exact plan version.
- Make current task state and the lens instruction deterministic, auditable, and recoverable.
- Keep camera media ephemeral by default and prevent stale model results from changing the lens.

The system does not independently invent a task, reorder a user-approved plan, or complete a
safety-sensitive step without confirmation. It does not treat a Bedrock video request as a
persistent camera session. It requests concise evidence and bounded decisions, not model
chain-of-thought.

The existing `POST /v1/chat` route remains a stateless chat interface. It is not a task-run API.

## Terms

| Term | Meaning |
| --- | --- |
| Source instructions | Exact text or structured steps submitted by the user. |
| Task plan | Normalized, versioned plan derived from source instructions. |
| Task step | One ordered user-visible action within an approved task plan. |
| Task run | One execution of an approved task-plan version by one user and pairing. |
| Inference window | Timestamped frames or one short clip submitted for observation. |
| Observation | A model's bounded claim about an inference window. |
| State transition | A code-accepted change to task or step state. |

## Plan creation and approval

### Input modes

The product supports two input modes:

1. **Structured list:** The user enters an ordered list of steps. This is preferred for known tasks.
2. **Free-form text:** The user pastes instructions, a recipe, a manual excerpt, or a checklist.
   Claude Haiku proposes a normalized plan for review.

Both modes create a `TaskPlanDraft`. A user must approve its exact `planVersion` before a task run
can be created.

### Deterministic validation before model use

The API validates every plan request before invoking Claude:

- authenticated owner and active pairing when the plan is linked to glasses
- title, source text, and step count length bounds
- maximum source size and maximum number of steps
- normalized Unicode and canonical whitespace
- unique stable client idempotency key
- allowlisted task category and declared risk level
- no arbitrary model, provider, endpoint, or tool selection from client input

Reject malformed or oversize requests without calling a model. Return a safe error code, request
ID, and suggested action.

### Claude Haiku validation contract

The source instructions are untrusted data, never system policy. The server-owned prompt requires
the model to:

1. Preserve user intent and step ordering.
2. Identify ambiguous, missing, contradictory, or non-observable steps.
3. Create only suggested visual acceptance criteria.
4. Classify each step as low, medium, or high consequence.
5. Mark steps that need explicit user confirmation.
6. Return no operational instructions outside the supplied plan.
7. Ignore instructions embedded in source data that attempt to override policy.

Claude Haiku does not provide Bedrock structured outputs for this integration. Require JSON-only
output, validate it against a server-owned schema, and reject invalid output. One schema-repair
request is permitted only for a syntactically invalid dependency response. Never retry
authentication, authorization, request validation, or policy failures.

Set an explicit output cap and timeout. A normalized plan needs concise metadata, not an essay. A
timeout leaves the draft unchanged and returns a recoverable dependency error.

### Expected normalized response

```json
{
  "planSummary": "Install the shelf bracket in four steps.",
  "needsUserClarification": false,
  "clarificationQuestions": [],
  "steps": [
    {
      "sourceStepOrdinal": 1,
      "canonicalInstruction": "Hold the bracket against the marked wall position.",
      "visualAcceptanceCriteria": [
        "bracket is aligned with the marked position",
        "bracket is held flush against the wall"
      ],
      "riskLevel": "low",
      "requiresUserConfirmation": false,
      "allowedTransitions": ["remain_in_progress", "candidate_complete", "blocked"]
    }
  ],
  "planRisks": [],
  "unsupportedClaims": []
}
```

The backend checks that every generated step maps to source material and keeps source order. A
model cannot add a prerequisite, tool, warning, or action as a canonical instruction. It may
surface a review-time question but cannot silently insert it into the plan.

### User review and approval

The review screen must show the original source instructions, proposed canonical steps, visual
acceptance criteria, risk and confirmation labels, clarification questions, and the exact plan
version to be started. The user may edit source steps, delete generated metadata, answer questions,
or abandon the draft. Any edit creates a new draft version and invalidates prior approval.

Approval records the plan version, approver user ID, timestamp, and content hash. Source content
and the approved normalized plan are immutable after approval.

## Proposed API contract

These routes are additions. They do not change existing `/v1/state`, `/v1/display`, `/v1/images`,
or `/v1/chat` response shapes.

```text
POST /v1/task-plans
GET  /v1/task-plans/{taskPlanId}
PATCH /v1/task-plans/{taskPlanId}/draft
POST /v1/task-plans/{taskPlanId}/validate
POST /v1/task-plans/{taskPlanId}/approve
POST /v1/task-runs
GET  /v1/task-runs/{taskRunId}
POST /v1/task-runs/{taskRunId}/commands
POST /v1/task-runs/{taskRunId}/inference-windows
POST /v1/task-runs/{taskRunId}/stop
```

`POST /v1/task-runs` requires an approved plan version and an active pairing. It returns a task-run
ID, initial state version, initial lens instruction, upload constraints, and short-lived scoped
media-upload authorization.

`POST /v1/task-runs/{taskRunId}/commands` accepts only this allowlist:

```text
pause | resume | repeat | confirm | skip | back | correct | stop
```

The command is handled and recorded by code. It is never authority for a model to bypass the plan.

## State-machine contract

### Task-plan lifecycle

```text
draft -> awaiting_approval -> approved
  |              |
  v              v
abandoned      rejected
```

Only the authenticated user can approve a task plan. Edits create a new draft plan version.

### Task-run lifecycle

```text
ready -> active <-> paused
ready -> cancelled | failed
active -> completed | cancelled | failed | expired
paused -> cancelled | failed | expired
```

Only the authenticated user or explicit backend lifecycle rules can start, pause, resume, cancel,
or complete a run. A task run can be created only from an approved plan version.

### Per-step lifecycle

```text
not_started -> in_progress -> candidate_complete -> confirmed
                     |                 |               |
                     v                 v               v
                  blocked           in_progress      skipped
```

The live model can propose only `remain_in_progress`, `candidate_complete`, or `blocked`. It cannot
directly mark a step confirmed, skipped, or complete a task run.

The transition gate accepts a candidate only when all conditions hold:

1. The run is active and the result matches its current `stateVersion`.
2. The media window is not older than the most recently accepted window.
3. The candidate is explicitly allowed for the current step.
4. Evidence timestamps belong to the submitted media window.
5. Confidence meets the configured threshold.
6. The step's confirmation policy is satisfied.
7. A deduplication key has not already committed the transition.

For low-consequence steps, two consistent independent observations may auto-confirm completion.
For medium- and high-consequence steps, the state machine creates `candidate_complete` and asks the
user to confirm before advancing. Every accepted transition increments a monotonic `stateVersion`.
An older result may be retained for diagnostics, but it must never change the lens instruction.

## Live visual inference

### Capture policy

The phone captures a continuous local feed but sends compact inference windows.

| Run condition | Input | Default cadence |
| --- | --- | --- |
| Active manipulation | Three timestamped frames: `t-2s`, `t-1s`, `t-now` | Every two seconds after latency validation |
| Early one-user pilot | Three frames or a non-overlapping short window | Every four seconds |
| Stable scene | One frame batch only when needed | Every 8-15 seconds |
| Uncertain completion | Five- to eight-second native video clip | One escalation window |
| High-consequence step | Evidence window plus user confirmation | Event driven |

Start with frames to avoid video-encoding delay and include the newest frame immediately. Native
video is an escalation path for temporal ambiguity, not a permanent overlapping stream.

### Ingestion and ordering

1. The phone uploads frames or a short clip to a private run-scoped S3 prefix.
2. The client submits an `InferenceWindow` with media keys, timestamps, sequence numbers, and the
   state version observed at capture.
3. The API validates ownership, pairing, object prefix, media bounds, freshness, and idempotency.
4. The API publishes low-latency work.
5. A worker calls Nova Lite with bounded current state and the inference window.
6. The worker validates the model response and submits a candidate transition to the state gate.
7. The state gate writes the accepted result and display instruction atomically.
8. The lens receives the newest instruction through the existing display mechanism or a later push
   channel.

Store `capturedThroughMs`, `windowSequence`, and `stateVersion` with every request. If a slower
request returns after a newer one, discard its display update. This keeps guidance synchronous even
though model calls are asynchronous.

### Nova Lite observation contract

Nova Lite receives the approved canonical step, accepted state summary, allowed transitions, and
the current frames or clip. It returns JSON that is separately schema validated:

```json
{
  "observation": "The top-left screw appears seated.",
  "evidence": [
    {
      "capturedAtMs": 1729960911000,
      "claim": "The screw head is nearly flush with the bracket."
    }
  ],
  "candidateTransition": "candidate_complete",
  "confidence": 0.89,
  "blocker": null,
  "optionalHint": "Keep the bracket steady while tightening."
}
```

The lens always shows code-owned canonical text, for example:

```text
Step 2 of 4: Insert and tighten the top-left screw.
```

An optional model hint is subordinate, short-lived, and cannot replace the step.

## Persistence model

The AWS-native PostgreSQL schema needs these records:

```text
task_plans
task_plan_versions
task_steps
task_runs
inference_windows
observations
state_transitions
lens_instructions
```

Important fields include immutable source content, approved plan version and hash, owner ID,
pairing ID, run lifecycle state, current step ordinal, `stateVersion`, capture timestamps, media
object keys, model ID, safe model response, decision source, and expiry times.

## Security, privacy, and operations

- Use the EC2 runtime IAM role to invoke Bedrock. Do not accept or persist end-user AWS credentials
  for managed task runs.
- Scope S3 upload URLs to one owner, run, prefix, MIME allowlist, maximum bytes, and short expiry.
- Delete raw frames and clips by default after 5-15 minutes. Retain structured observations only
  under a user-visible retention policy.
- Never log raw media, signed URLs, authorization headers, Bedrock prompts, raw model responses, or
  user source instructions.
- Log request ID, run ID, plan version, state version, window sequence, model, outcome, safe error
  code, and duration.
- Bound Bedrock operations with explicit timeouts. Retry only bounded, retryable provider failures
  with an idempotency key.
- Alarm on Nova Lite request count, input/output tokens, error rate, stale-result discard rate,
  transition rejection rate, and cost per completed task.

## Tests and acceptance criteria

Every implementation stage must add automated tests for:

- unauthenticated and cross-user access denial
- malformed, oversized, duplicate, and out-of-order inference windows
- source-plan preservation and approval-version immutability
- invalid Claude JSON and semantic validation failures
- model-generated new or reordered canonical steps being rejected
- each permitted and forbidden state transition
- stale `stateVersion` result rejection
- low-confidence and conflicting observation handling
- confirmation-required step behavior
- user commands, media retention, provider timeouts, throttles, and safe error mapping

Evaluate recorded, consented task runs with human labels. Track transition precision and recall,
false completion rate, safety-sensitive false transitions, correction rate, camera-to-lens p50 and
p95 latency, stale-result rate, Bedrock cost per task, and per-user request rate.

## Delivery order

1. Add task-plan and task-run schema plus application database functions.
2. Add authenticated task-plan draft, validation, review, and approval APIs.
3. Add Claude Haiku adapter, JSON schema gate, timeout, and tests.
4. Add task-run start, user command, and state-machine APIs.
5. Add scoped media upload and inference-window ingestion.
6. Add Nova Lite observation worker, transition gate, and lens-instruction persistence.
7. Run a one-user four-second-cadence pilot using recorded and supervised live tasks.
8. Move active task windows to a two-second cadence after latency and safety criteria are met.
9. Add selective Nova 2 Lite escalation and optional Claude planning escalation.
10. Add quotas, dashboards, retention jobs, budget alarms, and operational runbooks.

## Existing code touchpoints

Implementation should extend, not repurpose, these boundaries:

- `supabase/functions/api/index.ts`: routed API, authentication, state, display, and temporary
  image behavior.
- `supabase/functions/api/providers.ts`: existing client BYOK provider adapter. Managed task-run
  Bedrock calls need a separate server-owned adapter and IAM role.
- `database/migrations/`: AWS-native RDS schema and application functions for production changes.
- `docs/aws-deployment.md`: API Gateway, EC2, RDS, S3, IAM, and request-timeout constraints.
- `README.md`: hosted API and client contract after routes are implemented.

The existing 30-second API Gateway response limit reinforces the asynchronous inference-window
design. The API should acknowledge accepted media work promptly, and the lens should receive only
the newest accepted instruction.
