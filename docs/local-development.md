# Local development and Docker

Local development supports two modes:

- FastAPI on the host with authentication disabled.
- A full local Supabase stack plus the FastAPI service, either on the host or in Docker.

Real environment files, generated signing keys, OAuth credentials, and local Supabase state
are ignored by Git.

## Prerequisites

- Python 3.12
- `uv`
- Docker Desktop or another Docker-compatible runtime
- Node.js for the pinned Supabase CLI command

This repository uses Supabase CLI `2.116.0` in documented commands. Keep the version
pinned so local behavior does not change unexpectedly.

## FastAPI only

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

## Full local Supabase stack

Generate a developer-only ES256 signing key before the first start:

```bash
cp supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
npx --yes supabase@2.116.0 start
```

Supabase applies the checked-in migrations and local Storage configuration. The generated
`supabase/signing_keys.json` must remain local.

The CLI prints the local publishable key. Copy it into the ignored environment file used by
the API.

### Run FastAPI on the host

```bash
cp .env.local-auth.example .env.local-auth
# Set SUPABASE_PUBLISHABLE_KEY and NVIDIA_API_KEY in .env.local-auth.
uv run uvicorn app.main:app --reload --env-file .env.local-auth
```

The host process connects to Supabase at `127.0.0.1`.

### Run FastAPI in Docker

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

## Local Docker environment

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
| FastAPI | `http://127.0.0.1:8000` |
| FastAPI docs | `http://127.0.0.1:8000/docs` |
| Supabase API and Auth | `http://127.0.0.1:54321` |
| Supabase Postgres | `127.0.0.1:54322` |
| Supabase Studio | `http://127.0.0.1:54323` |
| Mailpit | `http://127.0.0.1:54324` |

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
```

Verify the Docker service:

```bash
curl --fail http://127.0.0.1:8000/healthz
docker compose ps
docker compose logs api
```

The health response should report `local` and `required` for the full-stack setup.

For an authenticated smoke test, sign up through local Supabase, obtain an access token,
register a pairing with `/v1/state`, upload a small JPEG or PNG, and send the returned
`imageId` to `/v1/chat`.

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

### FastAPI cannot reach Supabase

- Confirm `supabase status` reports all local services.
- Confirm the API container uses `host.docker.internal`, not `127.0.0.1`, for Supabase
  and Postgres.
- Confirm port 54321 and 54322 are not blocked or already occupied.

### JWT issuer mismatch

Keep `SUPABASE_JWT_ISSUER=http://127.0.0.1:54321/auth/v1` in the Docker environment. The
container fetches keys through `host.docker.internal`, but the token issuer remains the
host-facing URL.

### Image upload returns 503

- Confirm `SUPABASE_PUBLISHABLE_KEY` matches the current local stack.
- Confirm the private `Images` bucket exists in Studio.
- Confirm all migrations were applied.

### Chat returns 503

Confirm `NVIDIA_API_KEY` is populated. Health, Auth, pairing, and Storage can work without
a model request, so a healthy process does not prove the NVIDIA credential is present.

## References

- [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase local development with schema migrations](https://supabase.com/docs/guides/local-development)
- [Docker Compose](https://docs.docker.com/compose/)
