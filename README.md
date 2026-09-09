# MetaGlasses backend

FastAPI backend for the MetaGlasses phone-to-lens assistant. The phone owns the
conversation, authenticates with Supabase, and sends text plus optional temporary images.
The backend calls NVIDIA NIM and stores only the latest short response and pairing state
for the lens.

## Current architecture

- FastAPI serves the phone and lens endpoints.
- Supabase Auth issues phone access tokens. The API validates them through the project's
  public JWKS endpoint.
- Supabase Postgres stores shared pairing state and temporary image metadata.
- Supabase Storage holds private JPEG and PNG objects while a pairing is active.
- A Supabase Edge Function and Cron job purge expired image objects every minute.
- NVIDIA NIM provides text and image understanding through the configured model endpoint.
- Render runs isolated trial and production services.
- GitHub Actions validates every change, deploys trial after a validated `main` push, and
  deploys production only through an approved manual workflow.

The backend does not store audio or conversation transcripts. It must not receive a
Supabase secret key or service-role key.

## API

| Method and path | Caller | Purpose |
| --- | --- | --- |
| `GET /healthz` | Monitoring | Report process health, environment, and auth mode |
| `POST /v1/state` | Authenticated phone | Register a pairing or update lens state |
| `POST /v1/chat` | Authenticated phone | Generate and cache the next lens instruction |
| `POST /v1/images?pairingToken=...` | Authenticated phone | Upload a temporary JPEG or PNG |
| `DELETE /v1/images/{imageId}?pairingToken=...` | Authenticated phone | Delete a temporary image early |
| `GET /v1/display?token=...` | Paired lens | Read the latest response and state |

Interactive API documentation is available at `/docs` on every running service.

## Environments

| Environment | Supabase project | Storage bucket | Backend |
| --- | --- | --- | --- |
| Local | Supabase CLI or none | `Images` | `http://127.0.0.1:8000` |
| Trial | `uitdzmwfqtsohgffhuom` | `Images` | `https://metaglasses-backend.onrender.com` |
| Production | `hxtdfghufjjmeltarffl` | `images` | `https://metaglasses-backend-prod.onrender.com` |

Bucket names are case-sensitive. Authentication can be disabled only with
`APP_ENV=local`. Trial and production require HTTPS, explicit CORS origins, and separate
Supabase credentials.

## Local development

Create a local environment file and install the locked dependencies:

```bash
cp .env.local.example .env.local
uv sync --all-groups
uv run uvicorn app.main:app --reload --env-file .env.local
```

The local template disables authentication and uses process-local pairing state. Add a
valid `NVIDIA_API_KEY` to exercise real chat requests.

For local Supabase Auth, Postgres, and Storage:

```bash
cp supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
npx --yes supabase@2.116.0 start
cp .env.local-auth.example .env.local-auth
uv run uvicorn app.main:app --reload --env-file .env.local-auth
```

See [Local development and Docker](docs/local-development.md) for the complete Compose,
port, OAuth, and troubleshooting runbook.

## Configuration

Use `.env.trial.example` and `.env.prod.example` as safe templates. Real values belong in
Render or an ignored local environment file.

Required hosted values:

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | Select `trial` or `prod` |
| `AUTH_MODE` | Must be `required` when hosted |
| `SUPABASE_URL` | Project API URL and JWT issuer base |
| `SUPABASE_PUBLISHABLE_KEY` | Project publishable key used with user-authorized Storage calls |
| `SUPABASE_JWT_AUDIENCE` | Expected token audience, normally `authenticated` |
| `DATABASE_URL` | Supabase Postgres connection with `sslmode=require` |
| `CORS_ORIGINS` | Comma-separated allowlist of deployed client origins |
| `NVIDIA_API_KEY` | Server-side NVIDIA credential |
| `NVIDIA_MODEL` | Model identifier, currently `moonshotai/kimi-k3` |
| `NVIDIA_BASE_URL` | NVIDIA NIM base URL |
| `PAIRING_TTL_SECONDS` | Pairing and image lifetime, currently 3600 seconds |
| `PAIRING_IMAGE_BUCKET` | Exact case-sensitive Storage bucket name |
| `MAX_IMAGES_PER_PAIRING` | Maximum active images per pairing |
| `MAX_IMAGE_BYTES` | Maximum image size in bytes |
| `IMAGE_SIGNED_URL_TTL_SECONDS` | Lifetime of model-facing signed image URLs |

Use the Supabase session pooler for Render because the direct database endpoint may require
IPv6. Percent-encode special characters in the database password. Never commit a populated
connection string.

The complete environment-by-environment values and deployment runbook are in
[Deployment](docs/deployment.md).

## Temporary images

Register the pairing with `POST /v1/state`, then upload raw image bytes:

```http
POST /v1/images?pairingToken=<PAIRING_TOKEN>
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
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

The API creates a short-lived signed Storage URL only for the NVIDIA request. Storage
objects and metadata expire with the pairing and are removed by the cleanup job.

## CI and deployment

`CI` runs linting, tests, and a production container build for every pull request and every
push to `main`. After a successful `main` run, `CD` publishes commit-tagged and `latest`
images to GitHub Container Registry and triggers the trial Render deploy.

Production is never deployed by a normal push. Run the `CD` workflow manually from `main`,
then approve the `production` GitHub environment. Both Render services have automatic
deploys disabled so GitHub remains the deployment gate.

See [Deployment](docs/deployment.md) for Render variables, GitHub secrets, release checks,
and rollback steps.

## Validate the repository

```bash
uv run ruff check .
uv run python -m pytest
docker build --tag metaglasses-backend:test .
```

## Documentation

- [Deployment and operations](docs/deployment.md)
- [Supabase setup and security](docs/supabase.md)
- [Local development and Docker](docs/local-development.md)
- [Repository contribution guidance](AGENTS.md)
