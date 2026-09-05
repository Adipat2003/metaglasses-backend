# MetaGlasses backend

FastAPI service for the v0.1 phone-to-lens text loop. Phone endpoints use
Supabase access tokens outside local unit tests. It exposes these endpoints:

- `POST /v1/chat`: accepts a full text transcript, calls GPT-5.6 Sol, and stores only
  the newest response for the paired lens.
- `GET /v1/display?token=...`: returns the newest response and phone-driven state.
- `POST /v1/state`: updates the lens state without blocking the phone voice loop.
- `GET /healthz`: reports the running environment and authentication mode.

The service never accepts, stores, or returns audio. Conversation history remains
on the phone. The in-memory pairing record expires one hour after the last phone
request, so deploy v0.1 as one application instance. Use a shared TTL store before
running more than one instance.

## Environments

The Free Supabase tier supports two hosted projects. This repository uses them for
`trial` and `prod`; `dev` uses the local Supabase CLI stack. Pure local development
and unit tests use `APP_ENV=local` with the explicit authentication bypass.

| Environment | Supabase | Authentication | Purpose |
| --- | --- | --- | --- |
| `local` | None | Disabled | Fast unit tests and local API work |
| `dev` | Local CLI at port 54321 | Required | Auth integration and schema development |
| `trial` | Hosted project 1 | Required | TestFlight and external trials |
| `prod` | Hosted project 2 | Required | Production users |

Authentication cannot be disabled in `dev`, `trial`, or `prod`. Trial and production
also reject wildcard CORS configuration. The backend only needs the public Supabase
project URL to validate JWTs against its JWKS endpoint. Do not give it a service-role
key for authentication.

Copy the appropriate committed template to an ignored environment file:

```powershell
Copy-Item .env.local.example .env.local
```

Replace placeholders in trial and production with the corresponding project URL and
web client origin. Keep `OPENAI_API_KEY` and all future secrets in the untracked file
or the deployment platform's secret manager.

See [Supabase setup](docs/supabase.md) for the dashboard, signing-key, mobile-client,
provider, Postman testing, bearer-token, and deployment checklists. The importable
Postman collection and safe dev, trial, and production environment templates are in
[`postman/`](postman/).

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

Use `.env.dev` with `supabase start`, or the trial/production environment file in its
deployment. The mobile app signs in directly with Supabase and sends its access token:

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
optionally `OPENAI_MODEL` and `PAIRING_TTL_SECONDS` there. Run exactly one replica
until the in-memory pairing store is replaced with a shared TTL store.

## Pairing lifecycle

The phone generates a 32-character hexadecimal token and sends it in its first
`POST /v1/state` or `POST /v1/chat`. That registers the ephemeral pairing record.
Lens polling with an unknown or expired token receives `401` and should request
re-pairing on the phone.
