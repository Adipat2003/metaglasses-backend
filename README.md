# MetaGlasses backend

The hosted MetaGlasses API runs as a routed Supabase Edge Function. Supabase also provides
Postgres, Auth, private image Storage, and scheduled image cleanup. The previous FastAPI and
Render deployment remains in the repository temporarily as a rollback path during client
cutover.

## Hosted API

| Environment | API base URL | Storage bucket |
| --- | --- | --- |
| Trial | `https://uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api` | `Images` |
| Production | `https://hxtdfghufjjmeltarffl.supabase.co/functions/v1/api` | `images` |

Append the existing route to the environment base URL:

- `GET /healthz`
- `POST /v1/state`
- `GET /v1/display`
- `POST /v1/chat`
- `POST /v1/images`
- `DELETE /v1/images/{image_id}`

Phone routes require a Supabase user access token in `Authorization: Bearer <token>`. The
lens display route uses the random pairing token as its capability credential. All routes
currently return permissive CORS headers as requested. CORS does not replace authentication
or pairing ownership enforcement.

## Temporary images

Register an active pairing with `POST /v1/state`, then upload JPEG or PNG bytes:

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

The Edge Function creates a 60-second signed Storage URL for the NVIDIA request. Images and
metadata expire with their pairing and are deleted by the scheduled cleanup function.

## Local Supabase development

Docker is required for the local Supabase stack.

```bash
cp supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
cp supabase/functions/.env.example supabase/functions/.env
npx --yes supabase@2.116.0 start
```

Add a development NVIDIA credential to `supabase/functions/.env` only when exercising chat.
The local API base URL is:

```text
http://127.0.0.1:54321/functions/v1/api
```

Reset the local database and replay every migration:

```bash
npx --yes supabase@2.116.0 db reset --local --yes
```

Run the local authenticated API and image smoke test:

```bash
bash scripts/smoke-edge-api.sh
```

See [Local development and Docker](docs/local-development.md) for local Auth, Storage,
database, and legacy FastAPI instructions.

## CI and deployment

CI validates the Python rollback service, TypeScript Edge Functions, database configuration,
tests, and the fallback container build.

After successful CI on `main`, CD automatically applies migrations and deploys functions to
the trial Supabase project. Production is never deployed by a normal push. Run the `CD`
workflow manually from `main`, then approve the protected `production` GitHub environment.

Each GitHub environment requires:

- `SUPABASE_ACCESS_TOKEN`: a current Supabase personal access token
- `SUPABASE_DB_PASSWORD`: the database password for that environment

Each Supabase project requires this Edge Function secret:

- `NVIDIA_API_KEY`

Supabase provides `SUPABASE_URL`, database connectivity, publishable keys, and secret keys to
Edge Functions automatically. Do not copy those values into GitHub.

See [Deployment and operations](docs/deployment.md) for setup, release, rollback, and cutover.

## Legacy FastAPI fallback

The `app/`, `Dockerfile`, Compose files, and `render.yaml` remain available during migration.
They are not deployed by the current CD workflow. Remove the Render services and fallback
code only after trial and production clients have been cut over and observed successfully.

Run the fallback service locally:

```bash
cp .env.local.example .env.local
uv sync --all-groups
uv run uvicorn app.main:app --reload --env-file .env.local
```

## Validate the repository

```bash
uv run ruff check .
uv run python -m pytest
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno fmt --config supabase/functions/deno.json \
  --check supabase/functions
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno check --config supabase/functions/deno.json \
  supabase/functions/api/index.ts \
  supabase/functions/cleanup-pairing-images/index.ts
```

## Documentation

- [Deployment and operations](docs/deployment.md)
- [Supabase setup and security](docs/supabase.md)
- [Local development and Docker](docs/local-development.md)
- [Repository contribution guidance](AGENTS.md)
