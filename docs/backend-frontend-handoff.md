# Backend and frontend integration handoff

This handoff describes the repository at commit `c72eb9e`, inspected on 2026-11-10. It is a guide to the checked-in implementation, not proof that a particular environment is deployed or healthy. The routed Deno service is in [`supabase/functions/api/index.ts`](../supabase/functions/api/index.ts); the AWS database functions are in [`database/migrations/`](../database/migrations/). Verify the target environment and deployed revision with its operator before release.

## Deployment discrepancy to resolve first

The supplied repository instructions say trial and production run on Supabase Edge Functions and identify `supabase/migrations/` as the schema. The checked-in README, AWS deployment workflow, Deno implementation, and `database/migrations/` instead describe and implement an AWS runtime using Cognito, RDS, S3, and Bedrock. The checked-in Deno API unconditionally constructs a Cognito verifier and uses AWS database and storage clients. The Supabase local setup documentation and smoke script therefore must not be assumed to work with this revision. Likewise, older examples referring to Supabase user access tokens do not establish that those tokens work with the current Deno service. Confirm the actual deployment, identity provider, schema revision, and supported local setup with the backend owner before connecting a frontend or provisioning infrastructure. This document describes the checked-in Deno and AWS implementation; it does not assert the live state of any service.

The README records an AWS base URL of `https://xay03orwv0.execute-api.us-east-1.amazonaws.com`. Treat it as a documented candidate, not a verified live endpoint. Obtain the environment-specific base URL, Cognito region, user pool ID, public app client ID, OAuth configuration and redirect URLs, and a test account from the operator. Do not put server credentials or a confidential client secret in the app. Authentication and account registration are handled by the configured identity provider, not by these API routes. The API verifies Cognito **access tokens**, not ID tokens. The exact enabled sign-in methods and token refresh flow depend on the deployed Cognito configuration and cannot be derived reliably from this repository.

## Architecture and responsibilities

1. The phone authenticates with the configured Cognito user pool and sends its access token to protected routes.
2. The phone creates a cryptographically random 16-byte pairing capability encoded as 32 hexadecimal characters, transfers it securely to the lens, and registers it with `POST /v1/state`.
3. The lens polls `GET /v1/display?token=...` using that capability. Possession of the pairing token grants display access, so protect it like a password. Do not put it in analytics, logs, screenshots, or public links. Query parameters can be retained by clients and intermediaries.
4. The phone uploads optional camera images and sends a conversation to chat. The API calls a model and saves the most recent display response. The client owns conversation history.
5. For guided tasks, the phone creates and reviews a plan, obtains explicit user approval, starts a run, and sends user commands and optional frame windows. The backend publishes instructions to the same lens display.
6. The Deno service uses private PostgreSQL functions for data, private S3 objects for images, NVIDIA for managed chat, and Bedrock for plan review and visual observation. The cleanup worker removes expired images. See [AWS operations](aws-deployment.md) for infrastructure and recovery.

The Python app in `app/` is a local reference, not the hosted API contract. Supabase configuration and migrations remain in the repository for local or legacy paths; their presence does not establish equivalence with the AWS implementation.

## Shared HTTP conventions

Append paths below to the confirmed base URL, without a trailing slash. Protected requests use `Authorization: Bearer <COGNITO_ACCESS_TOKEN>`. JSON requests use `Content-Type: application/json`; image upload uses raw binary bytes. UUIDs are RFC-compatible strings. Each response has `x-request-id`; record that ID with a safe error report. The API currently responds to CORS preflight and allows any origin, but CORS is not authorization. `204` responses have no JSON body. Always check HTTP status before parsing a response.

Errors have this shape (fields in `context` are optional):

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

`API_BASE` and the current access token must be supplied by the app. Encode query parameters with `URLSearchParams`. The helper intentionally leaves retries and session refresh to the application.

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

A request may include `provider`, for example `{"type":"openai","apiKey":"<USER_API_KEY>","model":"<MODEL>"}`. Supported types are `openai`, `anthropic`, `google`, `azure`, `aws-bedrock`, `nvidia`, `openrouter`, `groq`, `mistral`, `xai`, `together`, `fireworks`, `deepseek`, `perplexity`, and `cerebras`. Azure also requires `endpoint`; Bedrock uses `region`, `accessKeyId`, `secretAccessKey`, optional `sessionToken`, and `model`. See [provider examples](../README.md#use-your-own-model-provider) and [`providers.ts`](../supabase/functions/api/providers.ts) for validation and model-specific behavior. Credentials are supplied for that request and are not intended to be stored by the backend. A failed user-provider request does not fall back to the managed provider. A frontend offering this feature must protect credentials in transit and on device, and never log them.

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

The title is 1-160 characters after normalization; there must be 1-30 steps, each instruction 1-1,000 characters, with at most 16,000 combined instruction characters. Text is Unicode NFKC normalized, trimmed, and whitespace collapsed. Initial free-form plan generation is not implemented. Success is 201 and returns the current plan. Its fields include `taskPlanId`, `title`, `status`, `currentVersion`, nullable `approvedVersion`, `createdAt`, `updatedAt`, `sourceSteps` with ordinal and instruction, `validationStatus`, nullable `validation`, and `revisionHistory`. Store the returned `taskPlanId`.

### Read and validate

`GET /v1/task-plans/<TASK_PLAN_UUID>` returns the same current representation for the owner while its pairing is active. `POST /v1/task-plans/<TASK_PLAN_UUID>/validate` invokes the optional model review for a draft and returns the updated plan. Use `{}` as the JSON body. The validation can report `planSummary`, `needsUserClarification`, `clarificationQuestions`, normalized `steps`, `planRisks`, `unsupportedClaims`, `guidelineChecks`, `approvalBlockers`, and `approvalReady`. Show each step's canonical instruction, visual criteria, risk, and confirmation label as well as the source steps. Validation is not approval.

### Refine

`POST /v1/task-plans/<TASK_PLAN_UUID>/refine`:

```json
{"clientRequestId":"<NEW_UUID>","expectedVersion":1,"message":"Make the second step more specific."}
```

The message is 1-2,000 characters after normalization. The response is the updated plan with a new `currentVersion`, cleared review, and revision history. Each new edit needs the latest version and a new request ID. Refinements are limited to ten and cannot change the title; they are unavailable after approval or once a run exists. On a version conflict, fetch the plan and let the user review the new state before issuing a new edit. Refinement is a model proposal, so present it for review.

### Approve

After the user explicitly approves the displayed current version, call `POST /v1/task-plans/<TASK_PLAN_UUID>/approve` with `{}`. The server performs a fresh strict review of the current version and atomically checks it has not changed. Calling validate first is optional. On success, the returned plan has `status: "approved"` and an approved version. A `409 task_plan_guidelines_failed` leaves it editable: fetch the plan, show saved blockers and clarification questions, refine, and ask the user to approve again. Other conflicts include stale plan and non-approvable state. Approval is not a model-only action; do not invoke it without a deliberate user action. See [approval guidelines](task-plan-approval-guidelines.md).

## Task runs and visual guidance

### Start and read

`POST /v1/task-runs` requires an approved plan and an active pairing:

```json
{"taskPlanId":"<TASK_PLAN_UUID>","clientRequestId":"<UUID>"}
```

The 201 response includes `taskRunId`, `taskPlanId`, `planVersion`, `status`, `currentStepOrdinal`, `stateVersion`, and `lensInstruction`. The server publishes the first instruction to display. Wait for a successful start before capturing guidance frames. `GET /v1/task-runs/<TASK_RUN_UUID>` returns these fields plus `currentStepStatus`, timestamps, and nullable `stoppedAt`. Runs can be `active`, `paused`, `completed`, or `stopped`. A plan must be approved and its pairing active; an existing active run can also prevent starting another. An expired pairing can make the run unavailable.

### Commands and concurrency

`POST /v1/task-runs/<TASK_RUN_UUID>/commands`:

```json
{"clientRequestId":"<UUID>","expectedStateVersion":1,"command":"confirm"}
```

Commands are `pause`, `resume`, `repeat`, `confirm`, `skip`, `back`, `correct`, and `stop`. The server checks the current state, applies the command, increments `stateVersion`, and returns `outcome`, run state, and lens instruction. Pause requires active; resume requires paused; back requires active and a step after the first; confirm and skip require active and advance or complete the final step. Repeat and correct republish the current instruction. Stop ends the run. `POST /v1/task-runs/<TASK_RUN_UUID>/stop` accepts the same body without `command` and forces stop. The server caps recorded commands per run at 1,000.

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

## Suggested frontend sequence

1. Obtain the confirmed environment configuration, sign in, and keep access tokens refreshed using the configured identity provider.
2. Generate and securely exchange a pairing token with the lens. Call state and begin display polling. Keep the pairing alive with phone activity.
3. For chat, capture and upload an image if needed, maintain local message history, call chat, and show or speak the returned text. Release images when no longer needed.
4. For guidance, create a structured plan, render the source and review, refine as requested, and obtain explicit approval. Start the run only after approval.
5. Keep the latest plan version and run state version. Record a stable ID per logical command or window. For visual guidance, upload bounded frames and queue windows, while the lens polls display.
6. Let the user pause, confirm, skip, go back, or stop. On stale state, refresh before another user decision. Stop capture when the run ends or pairing expires.

## Setup, operations, and verification

For the AWS path, read [AWS deployment and operations](aws-deployment.md), [infrastructure](../infrastructure/), the [deployment workflow](../.github/workflows/aws-deploy.yml), and [environment template](../config/env/edge-functions.env.example). The template lists `APP_ENV`, `AWS_REGION`, Cognito pool and client IDs, database host/port/name, image bucket, NVIDIA secret ARN, and optional model settings. Provisioning also needs IAM roles, private network connectivity, RDS schema and migration role, S3, model access, Secrets Manager, and the cleanup schedule as described in the deployment guide. Secrets and server IAM credentials stay server-side. `NVIDIA_API_KEY` can alternatively be supplied directly to the process when a secret ARN is not used. Do not copy a populated environment file into Git or a frontend bundle.

For local work, prerequisites and commands are in [local development](local-development.md). The Python reference can be run with Python 3.12, `uv`, `cp config/env/python-local.env.example .env.local`, `uv sync --all-groups`, and `uv run uvicorn app.main:app --reload --env-file .env.local`. It is useful for reference tests, but its auth, persistence, and feature parity must not be assumed to match the Deno AWS service. The documented Supabase stack uses Docker and pinned Supabase CLI 2.116.0, but the mismatch described above must be resolved before treating that stack as a working end-to-end environment for this revision. Do not reset a database containing data you need.

Repository checks and pinned Deno commands are listed in [local development](local-development.md). The canonical request collection is the separate [MetaGlasses Postman repository](https://github.com/Adipat2003/metaglasses-postman). Verify its revision matches the deployed backend before treating it as the live contract. The dedicated `scripts/smoke-task-guidance-api.sh` exercises Cognito, pairing, plan review, run, image, observation, and stop against a configured environment. It requires a dedicated test account and pairing, incurs model calls, changes the display, and creates audit records; read the script before running it. Use request IDs and structured logs for diagnosis. Confirm deployment and recovery using the operational guide rather than assuming a successful code push deployed the change.

## Known integration decisions still needed

- Confirm the actual hosted platform and deployed commit, the correct base URL, identity provider and public client settings, and the test account and redirect configuration.
- Resolve the checked-in Supabase local setup versus AWS-only Deno runtime mismatch, including which database migration tree is authoritative for the target environment.
- Agree on frontend polling cadence, pairing-token transfer and storage, access-token refresh, privacy retention, and handling of intermittent connectivity. The backend does not prescribe all of these product choices.
- Confirm quota, model availability, cleanup behavior, and CORS policy in the actual environment. The source and historical documentation are not a live operational check.
