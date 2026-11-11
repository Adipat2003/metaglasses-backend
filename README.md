# MetaGlasses backend

The hosted MetaGlasses API runs as a single routed HTTP service on AWS. Its Deno source remains
under `supabase/functions/` for historical path compatibility. AWS EC2 is the application runtime;
Cognito, RDS, and S3 provide authentication, data, and image storage.

## Hosted API

| Environment | API base URL | Storage bucket |
| --- | --- | --- |
| AWS single environment | `https://xay03orwv0.execute-api.us-east-1.amazonaws.com` | Private S3 bucket from `metaglasses-storage` |

Append the existing route to the environment base URL:

- `GET /healthz`
- `POST /v1/state`
- `GET /v1/display`
- `POST /v1/chat`
- `POST /v1/images`
- `DELETE /v1/images/{image_id}`
- `POST /v1/task-plans`
- `GET /v1/task-plans/{task_plan_id}`
- `POST /v1/task-plans/{task_plan_id}/refine`
- `POST /v1/task-plans/{task_plan_id}/validate`
- `POST /v1/task-plans/{task_plan_id}/approve`
- `POST /v1/task-runs`
- `GET /v1/task-runs/{task_run_id}`
- `POST /v1/task-runs/{task_run_id}/commands`
- `POST /v1/task-runs/{task_run_id}/inference-windows`
- `POST /v1/task-runs/{task_run_id}/stop`

Phone routes require a Cognito user access token in `Authorization: Bearer <token>`. The
lens display route uses the random pairing token as its capability credential. The Edge API
returns permissive CORS headers. CORS does not replace authentication or pairing ownership
enforcement.

Task guidance uses GLM 4.7 Flash for plan refinement and a separate strict approval review, then Nova Lite to observe
one to three recent images. The user remains responsible for confirming, skipping, pausing, or
stopping every task transition. See [task-plan validation](docs/task-plan-validation.md) for the
state machine, [approval guidelines](docs/task-plan-approval-guidelines.md), and
[local development](docs/local-development.md) for the smoke test.

## Temporary images

Register an active pairing with `POST /v1/state`, then upload JPEG or PNG bytes:

```http
POST /v1/images?pairingToken=<PAIRING_TOKEN>
Authorization: Bearer <COGNITO_ACCESS_TOKEN>
Content-Type: image/jpeg

<IMAGE_BYTES>
```

Attach the returned `imageId` to a user chat message:

```json
{
  "pairingToken": "<PAIRING_TOKEN>",
  "messages": [
    {
      "role": "user",
      "content": "What am I looking at?",
      "imageIds": ["<IMAGE_ID>"]
    }
  ]
}
```

The API creates a 10-minute signed S3 URL for the NVIDIA request. Images and metadata expire with
their pairing and are deleted by the scheduled cleanup worker. The hosted
API does not impose a fixed number of images per pairing, although each image must still satisfy
the file size and content-type validation.

Chat inference uses Llama 3.2 90B Vision by default. If NVIDIA returns a model-not-found or
provider-side 5xx error, the request is retried with Llama 3.2 11B Vision and then Kimi K3.
Authentication, validation, and rate-limit responses are returned without a model fallback.
AWS model requests have a 20-second deadline so API Gateway can return a safe application error
before its 30-second integration limit.

### Use your own model provider

`POST /v1/chat` also accepts a stateless `provider` object. The provider credentials are used only
for that request. They are not written to Postgres, Storage, logs, or error responses. Omitting
`provider` uses the managed NVIDIA fallback chain above. A failed BYOK request never falls back to
the managed key.

```json
{
  "pairingToken": "<PAIRING_TOKEN>",
  "messages": [{ "role": "user", "content": "What am I looking at?", "imageIds": [] }],
  "provider": {
    "type": "openai",
    "apiKey": "<USER_API_KEY>",
    "model": "gpt-4.1-mini"
  }
}
```

Supported provider types are `openai`, `anthropic`, `google`, `azure`, `aws-bedrock`, `nvidia`,
`openrouter`, `groq`, `mistral`, `xai`, `together`, `fireworks`, `deepseek`, `perplexity`, and
`cerebras`. All except Azure and AWS use the `apiKey` and `model` fields shown above. Each provider
uses a fixed API host to prevent requests to arbitrary servers.

Azure OpenAI and Azure AI Foundry also require the resource endpoint. The `model` value is the
deployment name for Azure OpenAI:

```json
{
  "type": "azure",
  "endpoint": "https://<RESOURCE>.openai.azure.com",
  "apiKey": "<USER_API_KEY>",
  "model": "<DEPLOYMENT_NAME>"
}
```

AWS Bedrock uses SigV4 credentials supplied by the client:

```json
{
  "type": "aws-bedrock",
  "region": "us-east-1",
  "accessKeyId": "<AWS_ACCESS_KEY_ID>",
  "secretAccessKey": "<AWS_SECRET_ACCESS_KEY>",
  "sessionToken": "<OPTIONAL_SESSION_TOKEN>",
  "model": "<BEDROCK_MODEL_ID>"
}
```

Provider failures return a stable error code and safe diagnostic context. The client can show the
top-level `detail` immediately and use `error.context.suggested_action` for recovery. The response
also contains a `request_id` that maps to a structured server log without exposing credentials.
Common codes include `provider_configuration_invalid`, `provider_auth_rejected`,
`provider_model_not_found`, `provider_rate_limited`, `provider_request_rejected`,
`model_request_failed`, and `model_invalid_response`.

The API forwards only the user and assistant messages supplied in `messages`. It does not add a
system prompt or inject server-side context.

## Postman

The canonical MetaGlasses Postman collection and environments live in the separate
[`Adipat2003/metaglasses-postman`](https://github.com/Adipat2003/metaglasses-postman) repository.
Use that repository to import the collection and duplicate the selected environment before adding
test-user credentials. Do not commit populated environments here.

After each successful CI run for a merge to `main`, GitHub dispatches the exact backend revision to
the canonical Postman repository. Its contract workflow verifies route alignment and opens a PR
only when the API source contract has changed. This backend intentionally does not carry generated
Postman exports or environments.

## Local development

See [local development](docs/local-development.md) for repository checks, the Python reference
service, and the AWS integration smoke test. The reference service does not reproduce the AWS API.

## CI and deployment

CI validates the Python reference implementation, TypeScript API, database configuration, and
tests. After a push to `main`, `aws-deploy.yml` builds and deploys the API container to AWS using
GitHub OIDC and SSM, and applies pending RDS migrations before restarting the service.

AWS infrastructure is managed separately through CloudFormation. See
[AWS deployment and operations](docs/aws-deployment.md) for setup, release, and recovery.

## Local Python reference implementation

The Python API under `app/` remains available for local development and contract tests. It is
not a hosted deployment target. Hosted requests go through API Gateway to the Deno API container
on EC2.

Run the reference service locally:

```bash
cp config/env/python-local.env.example .env.local
uv sync --all-groups
uv run uvicorn app.main:app --reload --env-file .env.local
```

## Validate the repository

Run the pinned checks documented in [local development](docs/local-development.md#validation).

## Documentation

- [AWS deployment and operations](docs/aws-deployment.md)
- [Backend and frontend integration handoff](docs/backend-frontend-handoff.md)
- [Local development and validation](docs/local-development.md)
- [Task-plan validation and live guidance design](docs/task-plan-validation.md)
- [Repository contribution guidance](AGENTS.md)
