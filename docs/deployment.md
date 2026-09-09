# Deployment and operations

The hosted API is deployed to Supabase Edge Functions. Trial deployment follows every
successful `main` CI run. Production deployment is a manual GitHub Actions operation guarded
by the `production` GitHub environment.

Render is a temporary rollback target during client cutover. The current CD workflow does
not update Render.

## Environment map

| Environment | Project reference | API base URL | Image bucket |
| --- | --- | --- | --- |
| Trial | `uitdzmwfqtsohgffhuom` | `https://uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api` | `Images` |
| Production | `hxtdfghufjjmeltarffl` | `https://hxtdfghufjjmeltarffl.supabase.co/functions/v1/api` | `images` |

Bucket names are case-sensitive. The function selects the hosted bucket from its Supabase
project URL. Local development can override the bucket with `PAIRING_IMAGE_BUCKET`.

## Supabase function secrets

Add this secret under **Edge Functions > Secrets** in both projects:

| Secret | Trial | Production |
| --- | --- | --- |
| `NVIDIA_API_KEY` | Trial or shared server credential | Production or shared server credential |

`NVIDIA_MODEL` and `NVIDIA_BASE_URL` are optional overrides. Defaults are
`moonshotai/kimi-k3` and `https://integrate.api.nvidia.com/v1`.

Supabase automatically injects the project URL, database URL, publishable keys, and secret
keys into its function environment. Do not add database URLs, database passwords, user
tokens, publishable keys, or secret keys as custom function secrets.

## GitHub environment secrets

Create these secrets independently in the `trial` and `production` GitHub environments:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authorizes the CLI to deploy Edge Functions and manage the project |
| `SUPABASE_DB_PASSWORD` | Authenticates `supabase db push` to the matching database |

The personal access token can be shared between environments if it is authorized for both
projects. The database passwords must match their respective projects. Never paste these
values into source control, workflow logs, issues, or chat.

The former `RENDER_TRIAL_DEPLOY_HOOK_URL` and `RENDER_PROD_DEPLOY_HOOK_URL` secrets may remain
during the observation window, but the workflow no longer reads them. Delete them after
Render is retired.

## CI behavior

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

1. Install the locked Python environment.
2. Run Ruff.
3. Run Pytest contract and configuration tests.
4. Check Deno formatting and TypeScript types for both Edge Functions.
5. Build the legacy Docker image as a rollback validation.

CI does not deploy anything.

## Trial deployment

After a successful `main` push CI run, `.github/workflows/cd.yml`:

1. Checks out the exact revision validated by CI.
2. Links the CLI to project `uitdzmwfqtsohgffhuom`.
3. Applies unapplied database migrations.
4. Deploys all Edge Functions.
5. verifies the trial `/healthz` endpoint.

The trial API base URL is:

```text
https://uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api
```

## Production deployment

Production never runs from the automatic `workflow_run` path.

1. Open the repository’s **Actions** tab.
2. Select **CD**.
3. Select **Run workflow** from `main`.
4. Approve the `production` environment when prompted.
5. Wait for migration, function deployment, and health verification to complete.

The workflow first confirms that the selected `main` revision passed CI. It then applies the
same migrations and function sources to project `hxtdfghufjjmeltarffl`.

## API health checks

Trial:

```bash
curl --fail \
  https://uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api/healthz
```

Production:

```bash
curl --fail \
  https://hxtdfghufjjmeltarffl.supabase.co/functions/v1/api/healthz
```

Expected hosted responses identify `trial` or `prod`, use `"status":"ok"`, and report
`"auth":"required"`.

## CORS policy

The Edge API currently sends `Access-Control-Allow-Origin: *` and does not allow credentialed
browser cookies. Supabase bearer authentication is still required for phone operations.
This permits JavaScript from any origin to call the API when it possesses a valid user token.

Replace the wildcard with an explicit allowlist before introducing a browser client that
handles sensitive sessions.

## Client cutover

Keep the Render services available while moving clients:

1. Deploy and validate the trial Edge API.
2. Change the trial client base URL to the trial Supabase URL.
3. Test Auth, pairing, chat, image upload, image-assisted chat, deletion, and expiry.
4. Run and approve the manual production workflow.
5. Change the production client base URL.
6. Observe production before removing Render.

The route suffixes remain `/v1/...`; only the base URL changes.

## Rollback

During migration, restore the client’s previous Render base URL. Render keeps the last
deployed FastAPI release because Supabase CD does not modify it.

For an Edge Function code regression, revert the offending commit and let trial deploy from
`main`. For production, manually run and approve CD for the reverted `main` revision.

Database migrations must be forward-compatible. Do not roll back a migration by deleting its
history row or resetting a hosted database. Create a new corrective migration instead.

## Render retirement checklist

Do not delete Render until all items are complete:

- Trial client has passed the full API and image lifecycle.
- Production CD has succeeded with manual approval.
- Production client uses the Supabase API base URL.
- Monitoring shows no client requests reaching Render.
- The rollback observation period has ended.

Afterward, remove both Render services, both Render deploy-hook secrets, `render.yaml`, the
FastAPI fallback, and the Docker application files in a separate cleanup change.

## References

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Function routing](https://supabase.com/docs/guides/functions/routing)
- [GitHub Actions function deployment](https://supabase.com/docs/guides/functions/examples/github-actions)
- [Managing Supabase environments](https://supabase.com/docs/guides/deployment/managing-environments)
- [Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction)
