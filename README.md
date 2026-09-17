# MetaGlasses backend

The hosted MetaGlasses API runs as a routed Supabase Edge Function. Supabase also provides
Postgres, Auth, private image Storage, and scheduled image cleanup. All hosted backend
environments run on Supabase.

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
- `GET /v1/video-stream` (WebSocket upgrade)

Phone routes require a Supabase user access token in `Authorization: Bearer <token>`. The
lens display route uses the random pairing token as its capability credential. The Edge API
returns permissive CORS headers. CORS does not replace authentication or pairing ownership
enforcement.

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

The Edge Function creates a 10-minute signed Storage URL for the NVIDIA request. Images and
metadata expire with their pairing and are deleted by the scheduled cleanup function.

## Ephemeral video streaming

After registering a pairing, connect to the video endpoint with `wss://`, the Supabase access
token in the `Authorization` header, and the pairing token in the query string. Send a JSON
`start` control message followed by binary encoded-video chunks. The API acknowledges and then
discards every chunk. It does not record video or send frames to a model.

The endpoint requests a reconnect after two minutes so a stream does not depend on one Edge
Function worker living indefinitely. See [the video stream protocol](docs/supabase.md#ephemeral-video-streams)
for message formats, limits, and reconnect behavior.

## Postman

Import the generated collection and the trial or production example environment from
[`postman/`](postman/). The environments use the matching Supabase project for both Auth and
Edge API requests. Duplicate the selected environment inside Postman before adding the project
publishable key or test-user credentials.

Regenerate the collection after changing the Edge API routes:

```bash
node scripts/generate-postman-collection.mjs
```

CI runs the generator in check mode. It fails when an Edge API endpoint has no Postman request
template or when the generated files are stale.

## Local Supabase development

Docker is required for the local Supabase stack.

```bash
cp supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
cp config/env/edge-functions.env.example supabase/functions/.env
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
database, and Python reference API instructions.

## CI and deployment

CI validates the Python reference implementation, TypeScript Edge Functions, database
configuration, tests, and generated Postman artifacts.

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

See [Deployment and operations](docs/deployment.md) for setup, release, and recovery.

## Local Python reference implementation

The Python API under `app/` remains available for local development and contract tests. It is
not a hosted deployment target. Trial and production use the Supabase Edge API exclusively.

Run the reference service locally:

```bash
cp config/env/python-local.env.example .env.local
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
docker run --rm --volume "$PWD:/work" --workdir /work \
  denoland/deno:2.5.2 deno test --config supabase/functions/deno.json \
  supabase/functions/api/nvidia_test.ts \
  supabase/functions/api/video_stream_test.ts
```

## Documentation

- [Deployment and operations](docs/deployment.md)
- [Supabase setup and security](docs/supabase.md)
- [Local development and Docker](docs/local-development.md)
- [Repository contribution guidance](AGENTS.md)
