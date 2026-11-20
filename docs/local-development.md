# Local development and validation

The hosted API is the Deno service on AWS, with source under `backend/`. It requires Cognito,
RDS, S3, and AWS credentials. The repository does not provide a fully local AWS stack.

## Prerequisites

- Node.js 22.16.0 and npm for SDK generation and validation.
- Python 3.12, `uv`, Bash, and `jq` for repository and release workflow tests.
- Docker for the pinned Deno 2.5.2 checks and application image build.
- An AWS environment, Cognito test account, and access token for the optional integration smoke test.

GitHub Actions use Ubuntu 24.04 and SHA-pinned actions. CI uses the Node.js and Python versions
above and runs Deno formatting, checking, and tests in one pinned Deno container.

Install the locked test environment with `uv sync --locked --all-groups`.

## Validation

Run the same checks as CI:

```bash
npm ci --prefix frontend-sdk
npm run generate --prefix frontend-sdk
git diff --exit-code -- frontend-sdk/api-types.d.ts
npm test --prefix frontend-sdk
node scripts/check-frontend-sdk-package.mjs
uv run ruff check .
uv run python -m pytest
docker run --rm --volume "$PWD:/work" --workdir /work \
  --entrypoint sh denoland/deno:2.5.2 -eu -c '
    deno fmt --config backend/deno.json \
      --check backend frontend-sdk/client.ts scripts/build-frontend-sdk.mjs \
      scripts/check-frontend-sdk-package.mjs
    deno check --config backend/deno.json \
      backend/api/index.ts backend/cleanup-pairing-images/index.ts
    deno test --allow-env --allow-read --config backend/deno.json \
      backend/api/
  '
bash -n scripts/smoke-task-guidance-api.sh
bash scripts/test-task-plan-library-db.sh
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

The [frontend SDK](../frontend-sdk/README.md) provides named calls with typed inputs and outputs.
The [frontend handoff](backend-frontend-handoff.md) documents authentication, limits, and client
flows. The [canonical Postman repository](https://github.com/Adipat2003/metaglasses-postman)
contains reusable requests and environment templates.
