# Glanss SDK

The API origin is supplied by the app at runtime. The SDK has no baked-in backend address and
does not read environment variables or persist credentials.

```bash
npm install metaglasses-sdk
```

```ts
import { createClient, ApiRequestError, SdkValidationError } from "metaglasses-sdk";

const api = createClient({
  baseUrl: appConfig.metaglassesApiBaseUrl,
  accessToken,
});

try {
  const plan = await api.createTaskPlan({
    clientRequestId: crypto.randomUUID(),
    title: "Make tea",
    steps: [{ instruction: "Place a teabag in the cup." }],
  });
  console.log(plan.taskPlanId);
} catch (error) {
  if (error instanceof SdkValidationError) {
    // Correct the input before retrying. No request was sent.
  } else if (error instanceof ApiRequestError) {
    // Use error.code for recovery and error.requestId for support.
  }
}
```

Calls are named functions on the client. TypeScript types describe each call's input and output.
Each function's editor documentation states its authentication, pairing, ownership, state, and
retry prerequisites. The SDK checks local input constraints before sending requests. State that
can change on the server, such as whether a plan is approved or a run is still active, remains a
server decision and is returned as an `ApiRequestError` with its status and machine-readable code.

For phone guidance, pass a `goal` and stable `clientRequestId` to `createTaskPlan`.
After reviewing the draft, call `approveTaskPlan` with `expectedVersion` and a request ID.
Pass the approved version as `expectedPlanVersion` to `startTaskRun`. Use
`listUnfinishedTaskRuns` to restore active and paused runs. Commands use the latest
`stateVersion`; preserve the original ID and body for each uncertain retry.

`createChatResponse` accepts owner-scoped Talk chat with a request ID and optional run
context. `uploadImage` stores a Talk image unless you pass a `taskRunId`. To check camera
frames, upload them to the active run, call `submitInferenceWindow`, and poll
`getInferenceWindow` for its result. Lens clients can still use `setPairingState` and
`uploadPairingImage`.

`ApiTransportError` represents a network failure or timeout. `ApiProtocolError` means the server
returned success with a non-JSON body. API failures expose `status`, `code`, `requestId`, and safe
context on `ApiRequestError`. The SDK never logs credentials or request contents.
