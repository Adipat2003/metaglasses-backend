# Deployment and operations

This document is the source of truth for Render and GitHub Actions deployment. Supabase
database, Auth, and Storage setup is documented separately in [supabase.md](supabase.md).

## Hosted topology

| Setting | Trial | Production |
| --- | --- | --- |
| Render service | `metaglasses-backend` | `metaglasses-backend-prod` |
| Public URL | `https://metaglasses-backend.onrender.com` | `https://metaglasses-backend-prod.onrender.com` |
| Git branch | `main` | `main` |
| Render automatic deploy | Off | Off |
| GitHub environment | `trial` | `production` |
| Release trigger | Validated push to `main` | Manual `CD` workflow plus approval |
| Supabase project | `uitdzmwfqtsohgffhuom` | `hxtdfghufjjmeltarffl` |
| Storage bucket | `Images` | `images` |

Both services build the checked-in `Dockerfile`, listen on Render's injected `PORT`, and
use `/healthz` as the health check. Do not create a `PORT` environment variable.

## Render environment variables

`render.yaml` declares every variable required by both services. Values marked
`sync: false` must be entered independently in each Render service.

| Variable | Trial | Production | Source |
| --- | --- | --- | --- |
| `APP_ENV` | `trial` | `prod` | Blueprint |
| `AUTH_MODE` | `required` | `required` | Blueprint |
| `SUPABASE_URL` | `https://uitdzmwfqtsohgffhuom.supabase.co` | `https://hxtdfghufjjmeltarffl.supabase.co` | Blueprint |
| `SUPABASE_PUBLISHABLE_KEY` | Trial publishable key | Production publishable key | Render value |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | `authenticated` | Blueprint |
| `CORS_ORIGINS` | Exact trial client origins | Exact production client origins | Render value |
| `DATABASE_URL` | Trial session pooler URL | Production session pooler URL | Render secret |
| `NVIDIA_API_KEY` | Trial/server NVIDIA key | Production/server NVIDIA key | Render secret |
| `NVIDIA_MODEL` | `moonshotai/kimi-k3` | `moonshotai/kimi-k3` | Blueprint |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Same | Blueprint |
| `PAIRING_TTL_SECONDS` | `3600` | `3600` | Blueprint |
| `PAIRING_IMAGE_BUCKET` | `Images` | `images` | Blueprint |
| `MAX_IMAGES_PER_PAIRING` | `10` | `10` | Blueprint |
| `MAX_IMAGE_BYTES` | `8388608` | `8388608` | Blueprint |
| `IMAGE_SIGNED_URL_TTL_SECONDS` | `60` | `60` | Blueprint |

Do not add `SUPABASE_SERVICE_ROLE_KEY`, a Supabase secret key, a database password by
itself, or a user access token to Render.

### Database URL

Use the Supabase session pooler connection shown by **Connect** in each project. Render may
not reach the direct database host because the direct endpoint can require IPv6.

Trial format:

```text
postgresql://postgres.uitdzmwfqtsohgffhuom:<PERCENT_ENCODED_PASSWORD>@<TRIAL_SESSION_POOLER_HOST>:5432/postgres?sslmode=require
```

Production format:

```text
postgresql://postgres.hxtdfghufjjmeltarffl:<PERCENT_ENCODED_PASSWORD>@<PROD_SESSION_POOLER_HOST>:5432/postgres?sslmode=require
```

Percent-encode reserved characters in the password. For example, encode `@` as `%40`.
Never paste the populated URL into source control, an issue, or a build log.

### CORS

`CORS_ORIGINS` is a comma-separated list of exact web origins:

```text
https://trial.example.com,https://admin-trial.example.com
```

Do not include paths and do not use `*` in trial or production. Native iOS requests are
not governed by browser CORS, but any browser-based admin or test client must be listed.

## Render setup

1. Open the Render Blueprint backed by this repository and sync `render.yaml`.
2. Confirm both services use branch `main`, runtime Docker, and health path `/healthz`.
3. Confirm automatic deploys are disabled for both services.
4. Enter the four `sync: false` values separately for each service:
   `SUPABASE_PUBLISHABLE_KEY`, `CORS_ORIGINS`, `DATABASE_URL`, and
   `NVIDIA_API_KEY`.
5. Create a deploy hook for each service under **Settings > Deploy Hook**.
6. Store each hook only in its matching GitHub environment.

Changing a Render environment value creates a new deploy. Check the health endpoint after
the deploy completes. Hosted startup fails if `DATABASE_URL`, `NVIDIA_API_KEY`, or
`SUPABASE_PUBLISHABLE_KEY` is missing, which prevents a partially configured release from
appearing healthy. Startup also rejects a legacy Supabase key, the wrong project URL, or a
database URL belonging to the other environment. It also checks the exact case-sensitive
Storage bucket name.

## GitHub configuration

The repository uses two GitHub environments:

| Environment | Required secret | Protection |
| --- | --- | --- |
| `trial` | `RENDER_TRIAL_DEPLOY_HOOK_URL` | Protected branches |
| `production` | `RENDER_PROD_DEPLOY_HOOK_URL` | Protected branches and required approval |

Deploy-hook URLs are secrets. They must not appear in `render.yaml`, workflow files,
environment examples, or documentation.

## CI and CD behavior

The workflows are intentionally separated:

1. `CI` runs for pull requests and pushes to `main`.
2. CI installs locked dependencies, runs Ruff and Pytest, and builds the production image.
3. After a successful `main` push, `CD` publishes:
   - `ghcr.io/adipat2003/metaglasses-backend:latest`
   - `ghcr.io/adipat2003/metaglasses-backend:<COMMIT_SHA>`
4. The same automatic CD run triggers only the trial deploy hook.
5. The production job is skipped on every normal push.

The deploy hook receives the validated commit SHA as its `ref`, preventing an unvalidated
newer commit from being deployed accidentally.

## Release production

1. Confirm the desired commit is on `main`.
2. Confirm its `CI` push run passed.
3. Open **GitHub Actions > CD > Run workflow**.
4. Select `main` and run the workflow.
5. Approve the `production` environment deployment.
6. Wait for the production Render deploy to finish.
7. Verify:

```bash
curl --fail https://metaglasses-backend-prod.onrender.com/healthz
```

The response must report `"environment":"prod"` and `"auth":"required"`.

## Trial verification

After merging to `main`, wait for CI and CD, then verify:

```bash
curl --fail https://metaglasses-backend.onrender.com/healthz
```

The response must report `"environment":"trial"` and `"auth":"required"`.

Use `/docs` to confirm the deployed API includes the image upload and delete operations.
An authenticated end-to-end smoke test should then register a pairing, upload one image,
send its `imageId` to `/v1/chat`, and delete it.

## Rollback

Render retains previous deploys for each service. To roll back:

1. Open the affected service's **Deploys** page.
2. Select the last known-good deploy.
3. Choose **Rollback** or redeploy that commit.
4. Verify `/healthz` and the affected authenticated flow.
5. Fix forward through a pull request so `main` again represents the deployed state.

Database migrations require a separate compatibility review before application rollback.
Do not reverse a migration merely because the application was rolled back.

## Operational checklist

- Both health endpoints return HTTP 200 with the correct environment.
- The latest GitHub CI run for the deployed commit passed.
- Trial deployed automatically and production required manual approval.
- Render automatic deploys remain off.
- Render has all four environment-specific values for each service.
- Supabase migrations match the files under `supabase/migrations`.
- Each Storage bucket is private and limited to JPEG/PNG files up to 8 MiB.
- The cleanup Edge Function requires JWT verification.
- The one-minute cleanup job is active and its latest HTTP response is 200.
- Supabase security advisors contain no unresolved application-schema errors.

## References

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render deploy hooks](https://render.com/docs/deploy-hooks)
- [Render deploy and rollback behavior](https://render.com/docs/deploys)
- [GitHub deployment environments](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
