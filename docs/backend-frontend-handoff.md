# Backend and frontend integration handoff

This handoff describes the checked-in AWS backend. The routed Deno service is in
[`backend/api/index.ts`](../backend/api/index.ts), and its database functions
are in [`database/migrations/`](../database/migrations/). Verify the target environment and deployed
revision with its operator before release. The hosted runtime uses AWS Cognito, RDS, S3, and Bedrock.

The API base URL is `https://xay03orwv0.execute-api.us-east-1.amazonaws.com`. On 2026-11-11,
the public health endpoint returned `ok` and the deployment workflow reported success for backend
commit `ffc51bdb0e32e154045180d0f1ad19c9e92e88d0`. This is a point-in-time check, not a guarantee
of later availability. The complete machine-readable contract is [api-openapi.yaml](api-openapi.yaml).

## Frontend authentication configuration

These public values were read from the AWS stack during the previous deployment session. On
2026-11-11 the public Cognito discovery document confirmed the issuer and hosted endpoints; the
AWS SSO session was expired, so the stack and running client allowlist could not be rechecked in
this handoff update.

| Setting | Value |
| --- | --- |
| AWS Region | `us-east-1` |
| Cognito user pool ID | `us-east-1_YzNGN326J` |
| Glanss mobile OAuth public client ID | `2rik7ab2daicig70vsu703op0v` |
| Issuer | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_YzNGN326J` |
| Authorization endpoint | `https://metaglasses-995342110760.auth.us-east-1.amazoncognito.com/oauth2/authorize` |
| Token endpoint | `https://metaglasses-995342110760.auth.us-east-1.amazoncognito.com/oauth2/token` |
| Mobile sign-in and logout redirect | `glanss://auth/callback` |
| Allowed scopes | `openid email profile` |
| Flow | Authorization code with PKCE, `S256`; public client, no client secret |
| API base URL | `https://xay03orwv0.execute-api.us-east-1.amazonaws.com` |

The configured access-token lifetime is 15 minutes and refresh-token lifetime is 30 days, with
refresh-token rotation enabled. Use the current **access token** in the bearer header. Store tokens
in platform-protected storage, handle session refresh, and clear local credentials on sign-out.
An ID token is not accepted by the API. The checked-in auth template also has a separate legacy
SRP client and a Postman OAuth client; do not substitute either ID for the Glanss OAuth ID.

The backend verifies the issuing client against its own allowlist. The Glanss client was added to
the running container in the previous deployment session, but the CloudFormation parameter was
not changed because its prepared change set could replace the EC2 instance. **An instance
replacement can therefore remove that running allowlist change.** Before release, the backend
operator must reconcile the stack and verify a real Glanss access token against a protected route.
The public health check does not test authentication.

For OAuth: generate a unique verifier and `S256` challenge and a random `state`, open the
Cognito authorization endpoint with `response_type=code`, client ID, redirect URI, scopes,
challenge, and state; validate the returned state; then exchange the authorization code and original
verifier at the token endpoint. The mobile app must register the exact callback scheme. Cognito
handles sign-up, verification, sign-in, refresh, and password recovery; the backend router does not
provide those routes. The template configures email-based sign-in and optional software-token MFA.
Do not embed server credentials or a confidential client secret in the app.

## Architecture and responsibilities

1. The phone authenticates with the configured Cognito user pool and sends its access token to protected routes.
2. The phone creates a cryptographically random 16-byte pairing capability encoded as 32 hexadecimal characters, transfers it securely to the lens, and registers it with `POST /v1/state`.
3. The lens polls `GET /v1/display?token=...` using that capability. Possession of the pairing token grants display access, so protect it like a password. Do not put it in analytics, logs, screenshots, or public links. Query parameters can be retained by clients and intermediaries.
4. The phone uploads optional camera images and sends a conversation to chat. The API calls a model and saves the most recent display response. The client owns conversation history.
5. For guided tasks, the phone creates and reviews a plan, obtains explicit user approval, starts a run, and sends user commands and optional frame windows. The backend publishes instructions to the same lens display.
6. The Deno service uses private PostgreSQL functions for data, private S3 objects for images, NVIDIA for managed chat, and Bedrock for plan review and visual observation. The cleanup worker removes expired images. See [AWS operations](aws-deployment.md) for infrastructure and recovery.

The Python app in `app/` is a local reference, not the hosted API contract. Historical Supabase migrations remain for audit history and are not used by the AWS runtime.

## Shared HTTP conventions

Append paths below to the confirmed base URL, without a trailing slash. Protected requests use `Authorization: Bearer <COGNITO_ACCESS_TOKEN>`. JSON requests use `Content-Type: application/json`; image upload uses raw binary bytes. UUIDs are RFC-compatible strings. Each response has `x-request-id`; record that ID with a safe error report. The API currently responds to CORS preflight and allows any origin, but CORS is not authorization. `204` responses have no JSON body. Always check HTTP status before parsing a response.

Errors generated by the backend API have this shape (fields in `context` are optional). API Gateway, infrastructure, and network failures can have a different format or no response, so clients must also handle non-JSON failures:

```json
{
  "detail": "Task run state changed. Refresh and retry.",
  "request_id": "<REQUEST_UUID>",
  "status": 409,
  "error": {
    "type": "ApiError",
    "code": "task_run_stale",
    "message": "Task run state changed. Refresh and retry.",
    "context": { "state_version": 2 }
  }
}
```

Use `error.code` for program logic and `detail` or `error.message` for a safe user-facing message. `error.context.suggested_action` is present on some errors. Handle `401` by renewing the user session or re-pairing as appropriate; `403` means a pairing belongs to another user; `404` can mean an unavailable resource or expired pairing; `409` requires resolving a state or plan conflict; `413`, `415`, and `422` require correcting input; `429` requires respecting limits; `503` indicates a dependency failure. Never automatically retry a non-idempotent operation with a new ID after an uncertain outcome. Health success alone does not check model, database, or storage readiness.

Example reusable request helper:

```js
async function api(path, { accessToken, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw { status: response.status, requestId: response.headers.get("x-request-id"), body };
  }
  return response.status === 204 ? null : response.json();
}
```

`API_BASE` and the current access token must be supplied by the app. A thrown network error is not
an API error envelope, so handle it separately and retain the logical request ID before retrying. Encode query parameters with `URLSearchParams`. The helper intentionally leaves retries and session refresh to the application.

## Endpoint index

| Method and path | Credential | Success | Purpose |
| --- | --- | --- | --- |
| `GET /healthz` | None | 200 | Process health |
| `POST /v1/state` | User | 204 | Register or refresh pairing and phone state |
| `GET /v1/display?token=...` | Pairing token | 200 | Read latest lens display |
| `POST /v1/chat` | User | 200 | Generate and publish a response |
| `POST /v1/images?pairingToken=...` | User | 201 | Upload one image |
| `DELETE /v1/images/{imageId}?pairingToken=...` | User | 204 | Delete an image |
| `POST /v1/task-plans` | User | 201 | Create a structured plan |
| `GET /v1/task-plans/{taskPlanId}` | User | 200 | Read current plan and review |
| `POST /v1/task-plans/{taskPlanId}/refine` | User | 200 | Propose a new version |
| `POST /v1/task-plans/{taskPlanId}/validate` | User | 200 | Optional preview review |
| `POST /v1/task-plans/{taskPlanId}/approve` | User | 200 | Strict review and user approval |
| `POST /v1/task-runs` | User | 201 | Start an approved plan |
| `GET /v1/task-runs/{taskRunId}` | User | 200 | Read run state |
| `POST /v1/task-runs/{taskRunId}/commands` | User | 200 | Apply a user command |
| `POST /v1/task-runs/{taskRunId}/stop` | User | 200 | Stop a run |
| `POST /v1/task-runs/{taskRunId}/inference-windows` | User | 202 | Queue visual observation |

There are no list, delete-plan, conversation-history, image-download, native video, push-display, or account-management routes in this router. Do not infer endpoints from the database or design documents.

## Pairing and display

### Health

`GET /healthz` returns `{"status":"ok","environment":"aws","auth":"required"}` in an AWS-configured process. `environment` depends on runtime configuration.

### Register and maintain a pairing

`POST /v1/state` requires a user token:

```json
{"pairingToken":"<32_HEX_CHARACTERS>","state":"listening"}
```

Valid states are `idle`, `listening`, `thinking`, and `speaking`. The token is exactly 32 hexadecimal characters. A successful request returns 204. Pairing lifetime is 3,600 seconds from phone activity; refresh it while the session is in use. The database stores a hash of the pairing capability and associates it with the authenticated owner. Another user cannot use an active pairing through protected routes. Once expired, a pairing needs registration again. Do not assume lens polling extends its lifetime.

### Read the lens display

`GET /v1/display?token=<PAIRING_TOKEN>` requires the pairing capability, not the phone's bearer token:

```json
{"responseId":"r_<ID>","text":"Hello","state":"speaking","createdAt":"2026-01-01T00:00:00.000Z"}
```

Before a response is published, `responseId`, `text`, and `createdAt` can be null. Poll at a product-chosen bounded cadence and render updates when `responseId` changes; no server push or mandated polling interval is implemented. The latest display is shared by chat and task guidance. `401` for an unknown or expired token means the phone should re-pair. No endpoint returns historical display messages.

## Images and chat

### Upload and delete

First register an active pairing. Send `POST /v1/images?pairingToken=<PAIRING_TOKEN>` with the bearer token, `Content-Type: image/jpeg` or `image/png`, and raw file bytes, not JSON, base64, or multipart. The byte signature must match the content type. Images must be nonempty and no larger than 8 MiB. The server does not impose a fixed image count per pairing.

```json
{"imageId":"<UUID>","contentType":"image/jpeg","byteSize":12345,"createdAt":"<ISO_TIMESTAMP>"}
```

For example, in a browser or a compatible JavaScript runtime, send `fetch(url, {method: "POST", headers: {Authorization: `Bearer ${accessToken}`, "Content-Type": file.type}, body: file})`. Native apps should send the same raw bytes with the matching content type.

The 201 response is metadata, not an image URL. Keep the `imageId` for chat, frame windows, or deletion. `DELETE /v1/images/<IMAGE_UUID>?pairingToken=<PAIRING_TOKEN>` requires the same owner and active pairing and returns 204. Image metadata and objects expire with the pairing and are subject to asynchronous cleanup; this is not a permanent media library. The managed model receives short-lived signed image URLs, currently valid for 10 minutes. Each frame submitted for task inference has a stricter 2 MiB limit.

### Chat

`POST /v1/chat` accepts the complete conversation to send for this request:

```json
{
  "pairingToken":"<PAIRING_TOKEN>",
  "messages":[
    {"role":"user","content":"What is this?","imageIds":["<IMAGE_UUID>"]},
    {"role":"assistant","content":"It looks like a cup."},
    {"role":"user","content":"What color is it?"}
  ]
}
```

`messages` is a nonempty array; roles are `user` or `assistant`; content must be nonblank. `imageIds` is optional, is an array of UUIDs, and may only be attached to user messages. Images must belong to this owner and active pairing. The normalized serialized messages must fit within 256,000 UTF-8 bytes. The API forwards only supplied messages; it does not inject a system prompt or retrieve previous turns. Trim old turns if needed.

Success returns `{"responseId":"r_<ID>","text":"<MODEL_TEXT>","createdAt":"<ISO_TIMESTAMP>"}` and publishes it to the display. Chat sets state to `thinking`, then saves a response; on failure it attempts to return state to `idle`. Because a chat call can result in another generated response on retry, do not assume it is idempotent.

Managed chat defaults to NVIDIA Llama 3.2 90B Vision, falling back to Llama 3.2 11B Vision and then Kimi K3 for the classified provider failures described in [README](../README.md). Authentication, validation, and rate-limit errors do not trigger this fallback. Availability, latency, and deployed model configuration must be verified with the operator.

### Optional user-supplied provider

A request may include `provider`, for example `{"type":"openai","apiKey":"<USER_API_KEY>","model":"<MODEL>"}`. Supported types are `openai`, `anthropic`, `google`, `azure`, `aws-bedrock`, `nvidia`, `openrouter`, `groq`, `mistral`, `xai`, `together`, `fireworks`, `deepseek`, `perplexity`, and `cerebras`. Azure also requires `endpoint`; Bedrock uses `region`, `accessKeyId`, `secretAccessKey`, optional `sessionToken`, and `model`. See [provider examples](../README.md#use-your-own-model-provider) and [`providers.ts`](../backend/api/providers.ts) for validation and model-specific behavior. Credentials are supplied for that request and are not intended to be stored by the backend. A failed user-provider request does not fall back to the managed provider. A frontend offering this feature must protect credentials in transit and on device, and never log them.

## Task plans: create, review, refine, approve

Task plans require a currently active pairing owned by the authenticated user. Keep the returned IDs and versions. UUID request IDs identify a logical operation: reuse the same ID and same payload for a retry after an uncertain result, and generate a new ID for a new operation. Do not change payloads under a reused ID.

### Create

`POST /v1/task-plans`:

```json
{
  "pairingToken":"<PAIRING_TOKEN>",
  "clientRequestId":"<UUID>",
  "title":"Place a cup on a table",
  "steps":[{"instruction":"Place the cup on the table."}]
}
```

The title is 1-160 characters after normalization; there must be 1-30 steps, each instruction 1-1,000 characters, with at most 16,000 combined instruction characters. Text is Unicode NFKC normalized, trimmed, and whitespace collapsed. Initial free-form plan generation is not implemented. Creation saves the original steps as version 1 and uses the model to produce a draft proposal as version 2. Success is 201 and returns the current plan. Retry a failed creation with the same clientRequestId and identical request. Its fields include `taskPlanId`, `title`, `status`, `currentVersion`, nullable `approvedVersion`, `createdAt`, `updatedAt`, `sourceSteps` with ordinal and instruction, `validationStatus`, nullable `validation`, and `revisionHistory`. Store the returned `taskPlanId`.

A representative successful creation response follows. IDs and timestamps are examples; generated
text varies. `revisionHistory` contains the model's initial proposal summary, and `sourceSteps`
contains the **current generated proposal**, not necessarily the exact originally submitted steps.
Keep a copy of the submitted steps in the app if the UI must display them later. The current read
endpoint does not expose the original version separately.

```json
{
  "taskPlanId":"11111111-1111-4111-8111-111111111111",
  "title":"Place a cup on a table",
  "status":"draft",
  "currentVersion":2,
  "approvedVersion":null,
  "createdAt":"2026-01-01T12:00:00.000Z",
  "updatedAt":"2026-01-01T12:00:01.000Z",
  "sourceSteps":[{"ordinal":1,"instruction":"Place the cup on the table."}],
  "validationStatus":"not_validated",
  "validation":null,
  "revisionHistory":[{
    "clientRequestId":"22222222-2222-4222-8222-222222222222",
    "request":"Organize the supplied steps into a clear task plan while preserving their intent and order.",
    "summary":"Organized the supplied step.",
    "version":2
  }]
}
```

If model generation fails, a draft may already exist even though the app received `503`. Retry
with the identical payload and request ID; do not generate a new ID. Concurrent retries can invoke
the model more than once, but the backend persists one proposal. A reused ID with a different title,
pairing, or steps returns `409 task_plan_idempotency_conflict`. The model runs at temperature zero,
but separate attempts are not guaranteed to produce identical text.

### Read and validate

`GET /v1/task-plans/<TASK_PLAN_UUID>` returns the same current representation for the owner while its pairing is active. `POST /v1/task-plans/<TASK_PLAN_UUID>/validate` invokes the optional model review for a draft and returns the updated plan. Use `{}` as the JSON body. The validation can report `planSummary`, `needsUserClarification`, `clarificationQuestions`, normalized `steps`, `planRisks`, `unsupportedClaims`, `guidelineChecks`, `approvalBlockers`, and `approvalReady`. Show each step's canonical instruction, visual criteria, risk, and confirmation label as well as the source steps. Validation is not approval.

### Refine

`POST /v1/task-plans/<TASK_PLAN_UUID>/refine`:

```json
{"clientRequestId":"<NEW_UUID>","expectedVersion":2,"message":"Make the second step more specific."}
```

The example assumes `currentVersion` is 2, as in a newly generated plan. In an actual request,
always use the latest value returned by create, read, or refine.

The message is 1-2,000 characters after normalization. The response is the updated plan with a new `currentVersion`, cleared review, and revision history. Each new edit needs the latest version and a new request ID. The initial model proposal uses one revision, leaving at most nine refinements. Refinements cannot change the title; they are unavailable after approval or once a run exists. On a version conflict, fetch the plan and let the user review the new state before issuing a new edit. Refinement is a model proposal, so present it for review.

### Approve

After the user explicitly approves the displayed current version, call `POST /v1/task-plans/<TASK_PLAN_UUID>/approve` with `{}`. The server performs a fresh strict review of the current version and atomically checks it has not changed. Calling validate first is optional. On success, the returned plan has `status: "approved"` and an approved version. A `409 task_plan_guidelines_failed` leaves it editable: fetch the plan, show saved blockers and clarification questions, refine, and ask the user to approve again. Other conflicts include stale plan and non-approvable state. Approval is not a model-only action; do not invoke it without a deliberate user action. See [approval guidelines](task-plan-approval-guidelines.md).

## Task runs and visual guidance

### Start and read

`POST /v1/task-runs` requires an approved plan and an active pairing:

```json
{"taskPlanId":"<TASK_PLAN_UUID>","clientRequestId":"<UUID>"}
```

The 201 response includes `taskRunId`, `taskPlanId`, `planVersion`, `status`, `currentStepOrdinal`, `stateVersion`, and `lensInstruction`. The server publishes the first instruction to display. Wait for a successful start before capturing guidance frames. `GET /v1/task-runs/<TASK_RUN_UUID>` returns these fields plus `currentStepStatus`, timestamps, and nullable `stoppedAt`. Runs can be `active`, `paused`, `completed`, or `stopped`. A plan must be approved and its pairing active; an existing active run can also prevent starting another. An expired pairing can make the run unavailable.

A representative start response is:

```json
{
  "taskRunId":"33333333-3333-4333-8333-333333333333",
  "taskPlanId":"11111111-1111-4111-8111-111111111111",
  "planVersion":2,
  "status":"active",
  "currentStepOrdinal":1,
  "stateVersion":1,
  "createdAt":"2026-01-01T12:01:00.000Z",
  "lensInstruction":"Place the cup on the table."
}
```

Keep `taskRunId`, `planVersion`, and `stateVersion`. `currentStepOrdinal` is one-based. The
initial instruction is also published through the pairing display. Starting a run returns
`409 task_run_not_ready` when the plan is not approved or the pairing is unavailable. A retry of
the same logical start must reuse its original `clientRequestId` and `taskPlanId`.

### Commands and concurrency

`POST /v1/task-runs/<TASK_RUN_UUID>/commands`:

```json
{"clientRequestId":"<UUID>","expectedStateVersion":1,"command":"confirm"}
```

Commands are `pause`, `resume`, `repeat`, `confirm`, `skip`, `back`, `correct`, and `stop`. The server checks the current state, applies the command, increments `stateVersion`, and returns `outcome`, run state, and lens instruction. Pause requires active; resume requires paused; back requires active and a step after the first; confirm and skip require active and advance or complete the final step. Repeat and correct republish the current instruction. Stop ends the run. `POST /v1/task-runs/<TASK_RUN_UUID>/stop` accepts the same body without `command` and forces stop. The server caps recorded commands per run at 1,000.

A successful command response has this shape:

```json
{
  "outcome":"applied",
  "taskRunId":"33333333-3333-4333-8333-333333333333",
  "status":"paused",
  "currentStepOrdinal":1,
  "currentStepStatus":"in_progress",
  "stateVersion":2,
  "lensInstruction":"Guidance paused."
}
```

Use the latest returned `stateVersion` for every command. On `409 task_run_stale`, fetch the run, update the UI, and ask the user to retry an action that is still appropriate. Do not silently replay a stale confirmation. Reuse the original `clientRequestId` and payload only when retrying the same operation after an uncertain network result. User commands, not visual model observations, control step progression.

### Submit an inference window

Upload 1-3 distinct JPEG or PNG images through the image endpoint for the run's pairing; each must be at most 2 MiB. Record each actual capture time as canonical UTC ISO 8601 with milliseconds, such as `2026-11-10T12:00:00.000Z`. Submit frames in strictly increasing capture-time order. At request validation, capture times must be no more than 30 seconds old and no more than 5 seconds in the future. Keep device clocks synchronized.

`POST /v1/task-runs/<TASK_RUN_UUID>/inference-windows`:

```json
{
  "clientRequestId":"<UUID>",
  "sequenceNumber":1,
  "expectedStateVersion":1,
  "frames":[{"imageId":"<IMAGE_UUID>","capturedAt":"2026-11-10T12:00:00.000Z"}]
}
```

Use a positive, increasing sequence number for each new window and the run state version observed when capturing. Success is 202, for example `{"outcome":"accepted","inferenceWindowId":"<UUID>","sequenceNumber":1,"status":"queued","stateVersion":1,"createdAt":"<ISO_TIMESTAMP>"}`. It means queued, not observed or complete. In the AWS implementation the worker processes queued windows asynchronously and may publish a display prompt. No public endpoint in this router retrieves an individual window or observation; poll display and read run state as needed. An observation does not advance, confirm, skip, or stop the task. Old-state or out-of-order windows are rejected. Model calls can fail or be discarded, so do not promise a display update for every accepted window.

### When the app should send frames: initial pilot policy

The backend does not choose capture times or send a capture trigger to the app. Use this **proposed
starting policy**, subject to testing on the actual device and AWS environment. The timings below
are product defaults for an early, single-user pilot, not guarantees or limits imposed by the API.

1. Ask the user for camera permission and an explicit start to visual guidance. Wait until
   `POST /v1/task-runs` succeeds. Do not upload camera frames while reviewing a plan.
2. While the run is `active` and the camera view is usable, capture one fresh JPEG or PNG frame.
   Record the actual UTC capture timestamp and the run's latest `stateVersion`. Upload it and
   submit a window containing that image ID. Start with a single frame to limit latency and data.
3. Begin with a minimum **four-second interval between window submissions**, measured by a
   monotonic device clock. Keep at most one upload or submission request in flight. Drop frames
   locally instead of queuing them if a request is still running, connectivity is poor, the view
   is obscured, or the app is backgrounded. Do not send a burst to catch up later.
4. Because `202` means only queued, use the returned `inferenceWindowId` to look for a display
   update whose `responseId` is `task_observation_<inferenceWindowId>`. Treat a match as evidence
   that this particular observation reached the display; it is not a user confirmation. For this
   conservative pilot, do not submit another window until the match is seen and the four-second
   minimum has elapsed.
5. If no matching display update is observed within **20 seconds**, stop automatic submissions and
   show a recoverable status such as “Visual guidance is taking longer than expected.” Let the user
   retry or continue using task commands. This timeout is a UI limit, not evidence that the backend
   stopped processing. A later display update may still arrive. A shared display can be overwritten
   by chat or another update, so a missing match does not prove the window failed.
6. On a pause or stop action, stop capturing immediately. Resume only after the server confirms the
   run is active and the app has its current state version. Every accepted command, including
   `repeat`, changes `stateVersion`; discard captured but unsubmitted frames whenever the version
   changes. For an unknown command outcome or `task_run_stale`, read the run before resuming.
   If the previous window has no matching display update, pause automatic submissions and let the
   user decide whether to retry; the earlier window may still be processed or discarded.
7. After an accepted step transition, capture a new frame for the newly current step when the
   preceding conditions for submission are satisfied. Do not reuse
   frames from the previous step or send a frame that has aged beyond the API's 30-second limit.
   On stop, completion, sign-out, or permission withdrawal, stop the camera and clear local queued
   frames. Delete uploaded images through the image endpoint when no longer needed and practical.

If a single frame proves insufficient for an action that changes over time, the app may submit up
to three **distinct** frames captured in order within one window. Do not synthesize timestamps or
repeat an image ID. Evaluate this separately because every additional frame adds upload and model
cost. The worker's two-second queue check is an internal scheduling detail, not a recommended client
cadence or maximum processing time.

The display endpoint is a single latest-value channel, not an observation queue. There is no public
window-status endpoint, failure callback, or cancellation of a queued window. Therefore the app
cannot prove that the worker has finished when no matching display update appears, and this policy
cannot guarantee zero backend backlog. Before expanding beyond a small pilot, measure capture and
upload latency, frame freshness, observation latency and failures, battery, bandwidth, and model
cost; coordinate cadence and queue limits with the backend owner.

## Error handling by operation

The HTTP status and `error.code` are the contract. The `detail` and `error.message` fields are
user-facing descriptions and can change. `error.context` is optional. The server returns
`x-request-id` on application responses; include it in a support report without logging tokens,
pairing capabilities, request bodies, images, or provider credentials.

| Condition or code | Meaning and frontend action |
| --- | --- |
| `401 unauthorized` or `auth_rejected` | User token is missing, expired, invalid, or issued to a client the backend does not accept. Refresh or sign in; if a fresh Glanss token fails, give support the request ID. |
| `401 unauthorized` on pairing-dependent work or display | The message can instead indicate an unknown or expired pairing. Re-register or re-pair as appropriate. |
| `403 forbidden` | The active pairing belongs to another user. Do not reuse another user's token. |
| `404 not_found`, `task_plan_not_found`, `task_run_not_found` | The resource or active pairing is unavailable to this user. Refresh app state and re-pair if needed. |
| `422 validation_error`, `task_plan_invalid` | Correct the input; do not automatically retry unchanged input. |
| `413 payload_too_large`, `415 unsupported_media_type` | Reduce the transcript or image, or supply a supported JPEG/PNG. |
| `409 task_plan_idempotency_conflict` | A create or refinement request ID was reused for a different operation. Generate a new UUID for the new operation. |
| `409 task_plan_stale`, `task_plan_changed` | Fetch the current plan and let the user review it before issuing a new edit or approval. |
| `409 task_plan_guidelines_failed` | Fetch the plan; show `validation.approvalBlockers` and `clarificationQuestions`, then allow refinement. |
| `409 task_plan_not_draft`, `task_plan_not_refinable`, `task_plan_not_approvable`, `task_plan_has_runs`, `task_plan_revision_limit` | The requested plan operation is unavailable in its current lifecycle. Fetch and display the current state. |
| `409 task_run_not_ready`, `task_run_invalid_transition`, `task_run_not_active` | Check plan approval, pairing, and current run state; do not blindly replay a command. |
| `409 task_run_stale` | Read the run; the optional `error.context.state_version` may help, but use the full current state for the UI. |
| `409 window_out_of_order`, `422 window_media_invalid` | Use a higher sequence for a new window and valid, recent images from the same active pairing. |
| `429 rate_limited`, `model_rate_limited`, `provider_rate_limited`, `task_run_command_limit` | Model rate limits may be transient; the command limit is a per-run cap and waiting alone does not reset it. |
| `503 plan_creation_unavailable`, `plan_creation_invalid_response` | Keep the same create payload and UUID for retry. A draft may already have been saved. |
| `503 plan_refinement_unavailable`, `plan_refinement_invalid_response` | Show the error; retry the same intended revision with its original UUID and payload when appropriate. |
| `503 plan_validation_unavailable`, `plan_validation_invalid_response`, `plan_approval_review_unavailable`, `plan_approval_review_invalid_response` | The model review did not complete or could not be used. Keep the current plan visible and retry when appropriate. |
| `503 pairing_rpc_failed`, `storage_upload_failed`, `storage_delete_failed`, `storage_sign_failed`, `model_request_failed`, `model_provider_error`, `model_invalid_response` | A backend dependency failed. Show safe detail and suggested action when supplied; retain the request ID. |
| `500 internal_error` or another `5xx` | Show a generic recovery message and send the request ID to support. Do not display raw infrastructure responses. |

Transport errors and API Gateway errors may lack the JSON envelope or `x-request-id`. Preserve the
user's unsent input and distinguish a connection failure from a verified backend rejection. Use
bounded, deliberate retries: never automatically retry validation, authorization, or other
non-transient failures. Do not silently retry a user confirmation after a state conflict.

## Suggested frontend sequence

1. Obtain the confirmed environment configuration, sign in, and keep access tokens refreshed using the configured identity provider.
2. Generate and securely exchange a pairing token with the lens. Call state and begin display polling. Keep the pairing alive with phone activity.
3. For chat, capture and upload an image if needed, maintain local message history, call chat, and show or speak the returned text. Release images when no longer needed.
4. For guidance, create a structured plan, render the source and review, refine as requested, and obtain explicit approval. Start the run only after approval.
5. Keep the latest plan version and run state version. Record a stable ID per logical command or window. For visual guidance, upload bounded frames and queue windows, while the lens polls display.
6. Let the user pause, confirm, skip, go back, or stop. On stale state, refresh before another user decision. Stop capture when the run ends or pairing expires.

## Setup, operations, and verification

For the AWS path, read [AWS deployment and operations](aws-deployment.md), [infrastructure](../infrastructure/), the [deployment workflow](../.github/workflows/aws-deploy.yml), and [environment template](../config/env/edge-functions.env.example). The template lists `APP_ENV`, `AWS_REGION`, Cognito pool and client IDs, database host/port/name, image bucket, NVIDIA secret ARN, and optional model settings. Provisioning also needs IAM roles, private network connectivity, RDS schema and migration role, S3, model access, Secrets Manager, and the cleanup schedule as described in the deployment guide. Secrets and server IAM credentials stay server-side. `NVIDIA_API_KEY` can alternatively be supplied directly to the process when a secret ARN is not used. Do not copy a populated environment file into Git or a frontend bundle.

For local work, prerequisites and commands are in [local development](local-development.md). The
Python reference is useful for its own tests, but its auth, persistence, and feature parity must not
be assumed to match the Deno AWS service. The repository does not provide a fully local AWS stack.

Repository checks and pinned Deno commands are listed in [local development](local-development.md). The canonical request collection is the separate [MetaGlasses Postman repository](https://github.com/Adipat2003/metaglasses-postman). Verify its revision matches the deployed backend before treating it as the live contract. The dedicated `scripts/smoke-task-guidance-api.sh` exercises Cognito, pairing, plan review, run, image, observation, and stop against a configured environment. It requires a dedicated test account and pairing, incurs model calls, changes the display, and creates audit records; read the script before running it. Use request IDs and structured logs for diagnosis. Confirm deployment and recovery using the operational guide rather than assuming a successful code push deployed the change.

## Known integration decisions still needed

- Confirm the deployed commit, base URL, Cognito public client settings, test account, and redirect configuration.
- Agree on frontend polling cadence, pairing-token transfer and storage, access-token refresh, privacy retention, and handling of intermittent connectivity. The backend does not prescribe all of these product choices.
- Confirm quota, model availability, cleanup behavior, and CORS policy in the actual environment. The source and historical documentation are not a live operational check.
