# Local development and Docker

Local development supports two application runtimes:

- The production-shaped Supabase Edge API with local Auth, Postgres, and Storage.
- The legacy FastAPI service on the host or in Docker as a temporary rollback path.

Real environment files, generated signing keys, OAuth credentials, and local Supabase state
are ignored by Git.

## Prerequisites

- Python 3.12
- `uv`
- Docker Desktop or another Docker-compatible runtime
- Node.js for the pinned Supabase CLI command

This repository uses Supabase CLI `2.116.0` in documented commands. Keep the version
pinned so local behavior does not change unexpectedly.

## Legacy FastAPI only

Use this mode for unit tests and API work that does not need real Auth, shared Postgres, or
Storage:

```bash
cp .env.local.example .env.local
uv sync --all-groups
uv run uvicorn app.main:app --reload --env-file .env.local
```

`.env.local` sets `APP_ENV=local`, `AUTH_MODE=disabled`, and wildcard CORS. Pairing
state is process-local and disappears when the process restarts. Add `NVIDIA_API_KEY` only
if you need real model requests.

Verify:

```bash
curl --fail http://127.0.0.1:8000/healthz
```

## Full local Supabase Edge API

Generate a developer-only ES256 signing key before the first start:

```bash
cp supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
cp supabase/functions/.env.example supabase/functions/.env
npx --yes supabase@2.116.0 start
```

Supabase applies the checked-in migrations, creates the private local bucket, and serves the
`api` and `cleanup-pairing-images` Edge Functions. The generated signing key and populated
function environment must remain local.

The local API base URL is:

```text
http://127.0.0.1:54321/functions/v1/api
```

Health does not require a token:

```bash
curl --fail http://127.0.0.1:54321/functions/v1/api/healthz
```

Add `NVIDIA_API_KEY` to `supabase/functions/.env` before testing `/v1/chat`. Local Auth,
pairing, display, and image operations do not require an NVIDIA credential.

Reset disposable local data and replay every migration:

```bash
npx --yes supabase@2.116.0 db reset --local --yes
```

### Create a local authenticated session

Create a user through the local Auth endpoint or use the Supabase client in the mobile app.
The CLI prints the local publishable key after `supabase start`. Protected Edge API routes
require the resulting user access token:

```http
POST http://127.0.0.1:54321/functions/v1/api/v1/state
Authorization: Bearer <LOCAL_USER_ACCESS_TOKEN>
Content-Type: application/json

{"pairingToken":"<32_HEX_CHARACTERS>","state":"listening"}
```

## Legacy FastAPI with local Supabase

The CLI prints the local publishable key. Copy it into the ignored environment file used by
the fallback API.

### Run fallback FastAPI on the host

```bash
cp .env.local-auth.example .env.local-auth
# Set SUPABASE_PUBLISHABLE_KEY and NVIDIA_API_KEY in .env.local-auth.
uv run uvicorn app.main:app --reload --env-file .env.local-auth
```

The host process connects to Supabase at `127.0.0.1`.

### Run fallback FastAPI in Docker

```bash
cp .env.docker.example .env.docker
# Set SUPABASE_PUBLISHABLE_KEY and NVIDIA_API_KEY in .env.docker.
docker compose up --build
```

Start Supabase before Compose. The Compose project runs only the FastAPI container and uses
the Supabase containers already created by the CLI.

To use a differently named ignored environment file:

```bash
API_ENV_FILE=.env.docker.local docker compose up --build
```

## Legacy Docker environment

`.env.docker.example` contains the correct container-to-host endpoints:

| Variable | Value or source |
| --- | --- |
| `APP_ENV` | `local` |
| `AUTH_MODE` | `required` |
| `SUPABASE_URL` | `http://host.docker.internal:54321` |
| `SUPABASE_JWT_ISSUER` | `http://127.0.0.1:54321/auth/v1` |
| `SUPABASE_PUBLISHABLE_KEY` | Value printed by `supabase start` |
| `DATABASE_URL` | `postgresql://postgres:postgres@host.docker.internal:54322/postgres` |
| `PAIRING_IMAGE_BUCKET` | `Images` |
| `NVIDIA_API_KEY` | Developer NVIDIA key if chat is tested |

`SUPABASE_URL` uses the Docker host gateway so the container can reach Auth and Storage.
`SUPABASE_JWT_ISSUER` remains the host-facing URL embedded in locally issued tokens.

`docker-compose.yml` includes the Linux `host-gateway` mapping. Docker Desktop provides
`host.docker.internal` on macOS and Windows.

## Ports

| Service | URL or port |
| --- | --- |
| Supabase Edge API | `http://127.0.0.1:54321/functions/v1/api` |
| Supabase API and Auth | `http://127.0.0.1:54321` |
| Supabase Postgres | `127.0.0.1:54322` |
| Supabase Studio | `http://127.0.0.1:54323` |
| Mailpit | `http://127.0.0.1:54324` |
| Legacy FastAPI | `http://127.0.0.1:8000` |
| Legacy FastAPI docs | `http://127.0.0.1:8000/docs` |

## Local OAuth providers

OAuth configuration is optional. Copy the ignored template:

```bash
cp supabase/oauth.env.example supabase/oauth.env
set -a
source supabase/oauth.env
set +a
npx --yes supabase@2.116.0 start
```

For Google, register:

```text
http://127.0.0.1:54321/auth/v1/callback
```

Apple web OAuth does not accept a loopback HTTP callback. Use a public HTTPS tunnel or test
Apple sign-in against the hosted trial project.

## Validation

Run repository checks on the host:

```bash
uv run ruff check .
uv run python -m pytest
docker build --tag metaglasses-backend:test .
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno fmt --config supabase/functions/deno.json \
  --check supabase/functions
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno check --config supabase/functions/deno.json \
  supabase/functions/api/index.ts \
  supabase/functions/cleanup-pairing-images/index.ts
```

Verify the primary Edge API:

```bash
curl --fail http://127.0.0.1:54321/functions/v1/api/healthz
```

Verify the fallback Docker service:

```bash
curl --fail http://127.0.0.1:8000/healthz
docker compose ps
docker compose logs api
```

Both health responses should report `local` and `required` for authenticated full-stack
setups.

For an authenticated smoke test, sign up through local Supabase, obtain an access token,
register a pairing with `/v1/state`, upload a small JPEG or PNG, and send the returned
`imageId` to `/v1/chat`.

The repository automates Auth, state, display, image upload, deletion, unauthorized access,
and CORS checks:

```bash
bash scripts/smoke-edge-api.sh
```

When a local NVIDIA-compatible mock or real development credential is configured, include
the image-assisted chat check:

```bash
EXPECT_CHAT=true bash scripts/smoke-edge-api.sh
```

## Stop and clean up

Stop only FastAPI:

```bash
docker compose down
```

Stop the Supabase stack separately:

```bash
npx --yes supabase@2.116.0 stop
```

Do not add `--no-backup` if you want to keep local database state. A database reset is
destructive and should be used only when disposable local data can be recreated.

## Troubleshooting

### Edge API returns 500 or 503

- Confirm `supabase status` reports Auth, Postgres, Storage, and Edge Runtime as healthy.
- Run `npx --yes supabase@2.116.0 db reset --local --yes` after adding migrations.
- Inspect Edge Runtime logs with
  `docker logs supabase_edge_runtime_metaglasses-backend`.

### Legacy FastAPI cannot reach Supabase

- Confirm `supabase status` reports all local services.
- Confirm the API container uses `host.docker.internal`, not `127.0.0.1`, for Supabase
  and Postgres.
- Confirm port 54321 and 54322 are not blocked or already occupied.

### JWT issuer mismatch

Keep `SUPABASE_JWT_ISSUER=http://127.0.0.1:54321/auth/v1` in the Docker environment. The
container fetches keys through `host.docker.internal`, but the token issuer remains the
host-facing URL.

### Image upload returns 503

- Confirm the private `Images` bucket exists in Studio.
- Confirm all migrations were applied.
- For the legacy FastAPI fallback, confirm `SUPABASE_PUBLISHABLE_KEY` matches the current
  local stack.

### Chat returns 503

Confirm `NVIDIA_API_KEY` is populated in `supabase/functions/.env` for the Edge API or the
selected FastAPI environment file for the fallback. Health, Auth, pairing, and Storage can
work without a model request, so a healthy response does not prove the NVIDIA credential is
present.

## References

- [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase local development with schema migrations](https://supabase.com/docs/guides/local-development)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Docker Compose](https://docs.docker.com/compose/)
