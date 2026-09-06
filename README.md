# MetaGlasses backend

FastAPI service for the v0.1 phone-to-lens text loop. Phone endpoints use
Supabase access tokens outside local unit tests. It exposes these endpoints:

- `POST /v1/chat`: accepts a full text transcript, calls GPT-5.6 Sol, and stores only
  the newest response for the paired lens.
- `GET /v1/display?token=...`: returns the newest response and phone-driven state.
- `POST /v1/state`: updates the lens state without blocking the phone voice loop.
- `GET /healthz`: reports the running environment and authentication mode.

The service never accepts, stores, or returns audio. Conversation history remains
on the phone. When `DATABASE_URL` is configured, pairing state is shared through a
private PostgreSQL table and expires one hour after the last phone request. Without
`DATABASE_URL`, the app uses the process-local store for local development.

## Environments

The Free Supabase tier supports two hosted projects. This repository uses them for
`trial` and `prod`. Local development uses `APP_ENV=local`, either with an explicit
authentication bypass or with the local Supabase CLI stack.

| Environment | Supabase | Authentication | Purpose |
| --- | --- | --- | --- |
| `local` | None or local CLI at port 54321 | Disabled or required | Local API and auth integration work |
| `trial` | Hosted project 1 | Required | TestFlight and external trials |
| `prod` | Hosted project 2 | Required | Production users |

Authentication can be disabled only in `local`. Trial and production also reject
wildcard CORS configuration. The backend uses the public Supabase project URL to
validate JWTs against its JWKS endpoint and `DATABASE_URL` for shared pairing state.
Do not give it a service-role API key for authentication.

Copy the appropriate committed template to an ignored environment file:

```powershell
Copy-Item .env.local.example .env.local
```

Replace placeholders in trial and production with the corresponding project URL and
web client origin. Keep `OPENAI_API_KEY` and all future secrets in the untracked file
or the deployment platform's secret manager.

See [Supabase setup](docs/supabase.md) for the dashboard, signing-key, mobile-client,
provider, Postman testing, bearer-token, and deployment checklists. Postman exports
are intentionally kept outside this public repository because populated environments
can contain user access and refresh tokens.

## Run locally without auth

Local bypass is explicit in `.env.local`; no bearer token is needed:

```powershell
cd C:\Github\metaglasses-backend
uv sync --all-groups
uv run uvicorn app.main:app --reload --env-file .env.local
```

The API is available at `http://127.0.0.1:8000`; FastAPI's interactive API page is
at `http://127.0.0.1:8000/docs`.

The default model is `gpt-5.6-sol`. Set `OPENAI_MODEL` to select another compatible
OpenAI model after testing its latency and response quality.

Set `CORS_ORIGINS` to the web app's deployed origin or a comma-separated allowlist
before deployment. The local default is `*` to permit the separate web client during
initial integration.

## Run against Supabase Auth

Use `.env.local-auth` with `supabase start`, `.env.docker` with `docker compose up`, or
the trial/production environment file in its deployment. The mobile app signs in directly
with Supabase and sends its access token:

```http
Authorization: Bearer <supabase-access-token>
```

`POST /v1/chat` and `POST /v1/state` require that header. `GET /v1/display` uses the
pairing token as its capability credential and remains available to the separate lens
web client. Pairing tokens are bound to the authenticated user that first registers
them.

The current Glance mobile client still needs to replace its temporary backend
`/v1/auth/login` and `/v1/auth/signup` calls with the Supabase client, keep the
refresh token in the iOS Keychain, and include its pairing token in phone requests.
Only the environment-specific publishable key belongs in the mobile build. Never put
a Supabase secret or service-role key in the app.

## Check the project

```powershell
uv run ruff check .
uv run python -m pytest
```

## CI and container publishing

GitHub Actions runs linting, tests, and a production container build for every pull
request and every push to `main`. After validation succeeds on `main`, the workflow
publishes immutable commit and `latest` images to GitHub Container Registry:

```text
ghcr.io/adipat2003/metaglasses-backend:latest
ghcr.io/adipat2003/metaglasses-backend:COMMIT_SHA
```

GitHub stores and builds the image but does not run persistent web services. Deploy
the published image to a container host and configure `APP_ENV`, `AUTH_MODE`,
`SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE`, `CORS_ORIGINS`, `OPENAI_API_KEY`, and
`DATABASE_URL` there. `OPENAI_MODEL` and `PAIRING_TTL_SECONDS` are optional. Use the
Supabase session pooler on IPv4-only persistent hosts and require SSL. Percent-encode
special characters in the database password before constructing the URL.

## Render deployment environments

The repository's default branch is `main`. The Render Blueprint defines two Docker
services that track it:

| Service | Environment | Deployment policy |
| --- | --- | --- |
| `metaglasses-backend` | Trial | Deploy after the GitHub checks pass |
| `metaglasses-backend-prod` | Production | Automatic deploys disabled |

Sync `render.yaml` in the Render dashboard to create or update both services. Configure
the four secret values separately on each service: `SUPABASE_URL`, `CORS_ORIGINS`,
`DATABASE_URL`, and `OPENAI_API_KEY`. Trial and production must use their corresponding
Supabase projects and must not share database credentials.

Production can be released in either of two explicit ways:

1. In Render, select `metaglasses-backend-prod`, choose **Manual Deploy**, and deploy
   the latest `main` commit.
2. In GitHub Actions, run the `CI/CD` workflow from `main` with
   `deploy_production=true`. Add the production service's Render deploy-hook URL as the
   `RENDER_PROD_DEPLOY_HOOK_URL` secret in a GitHub environment named `production`.
   Configure required reviewers on that environment if the repository plan supports
   them.

The deploy-hook URL is a secret. Never add it to `render.yaml`, a workflow file, or an
untracked local environment file that might later be committed.

## Pairing lifecycle

The phone generates a 32-character hexadecimal token and sends it in its first
`POST /v1/state` or `POST /v1/chat`. That registers the ephemeral pairing record.
Lens polling with an unknown or expired token receives `401` and should request
re-pairing on the phone.
