# Local development and validation

The hosted API is the Deno service on AWS. Its source is under `supabase/functions/` for historical
path compatibility. It requires Cognito, RDS, S3, and AWS credentials and is not reproduced by the
old Supabase local stack. Do not use the Python reference service as a substitute for hosted API
contract testing.

## Prerequisites

- Python 3.12 and `uv` for the reference app and repository configuration tests.
- Docker for the pinned Deno 2.5.2 checks and application image build.
- An AWS environment, Cognito test account, and access token for the optional integration smoke test.

Install the locked Python environment with `uv sync --locked --all-groups`.

## Local Python reference

```bash
cp config/env/python-local.env.example .env.local
uv run uvicorn app.main:app --reload --env-file .env.local
curl --fail http://127.0.0.1:8000/healthz
```

This local service runs without authentication, stores pairing state in process memory, and loses it
when restarted. Add a development NVIDIA credential to the ignored `.env.local` only when testing
model requests. It is not a deployment target and does not implement every hosted feature.

## Validation

Run the same checks as CI:

```bash
uv run ruff check .
uv run python -m pytest
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno fmt --config supabase/functions/deno.json \
  --check supabase/functions
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno check --config supabase/functions/deno.json \
  supabase/functions/api/index.ts supabase/functions/cleanup-pairing-images/index.ts
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno test --allow-env --config supabase/functions/deno.json \
  supabase/functions/api/nvidia_test.ts supabase/functions/api/providers_test.ts \
  supabase/functions/api/task_plan_test.ts
bash -n scripts/smoke-task-guidance-api.sh
```

The Docker image builds with `docker build -t metaglasses-api .`. Building does not verify AWS
connectivity. See [AWS deployment and operations](aws-deployment.md) for infrastructure, runtime
configuration, migrations, and deployment.

## AWS integration smoke test

`scripts/smoke-task-guidance-api.sh` creates a pairing and task records, changes lens display state,
uploads an image, and calls paid models. Use a dedicated Cognito test user and pairing. Set these
values in your local environment without committing or sharing them:

```bash
export EDGE_API_BASE="<CONFIRMED_API_BASE>"
export EDGE_API_ACCESS_TOKEN="<COGNITO_ACCESS_TOKEN>"
export PAIRING_TOKEN="<32_HEX_CHARACTERS>"
export TASK_GUIDANCE_TEST_CONFIRM=yes
bash scripts/smoke-task-guidance-api.sh
```

The test attempts to stop the run and delete its image on exit, but audit records remain. A pass
ends with `Task-guidance smoke test passed.` Do not run it against another user's pairing.

The [frontend handoff](backend-frontend-handoff.md) documents authentication, endpoint contracts,
limits, and client flows. The [canonical Postman repository](https://github.com/Adipat2003/metaglasses-postman)
contains reusable requests and environment templates.
