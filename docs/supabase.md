# Supabase setup and security

Supabase hosts the routed MetaGlasses Edge API and provides Auth, Postgres, private temporary
image Storage, and scheduled cleanup. Trial and production use separate projects so users,
tokens, database rows, redirects, quotas, functions, secrets, and logs cannot cross
environment boundaries.

## Project map

| Setting | Trial | Production |
| --- | --- | --- |
| Project reference | `uitdzmwfqtsohgffhuom` | `hxtdfghufjjmeltarffl` |
| API URL | `https://uitdzmwfqtsohgffhuom.supabase.co` | `https://hxtdfghufjjmeltarffl.supabase.co` |
| Database | `postgres` | `postgres` |
| Storage bucket | `Images` | `images` |
| Bucket visibility | Private | Private |
| File limit | 8 MiB | 8 MiB |
| MIME types | `image/jpeg`, `image/png` | `image/jpeg`, `image/png` |
| Cleanup schedule | Every minute | Every minute |
| Edge API | `/functions/v1/api` | `/functions/v1/api` |

Bucket names are case-sensitive. Mobile builds must use the API URL and publishable key from
the same project as their environment.

## Credentials and trust boundaries

The Edge API uses:

- The incoming user token with the project publishable key to resolve the authenticated user.
- A publishable key plus the current user's bearer token for user-authorized Storage calls.
- A runtime-provided secret key for service-role-only pairing RPCs.

Supabase injects the URL, database connection, publishable keys, and secret keys into hosted
Edge Functions. These values are not custom secrets and never leave the trusted runtime.

The mobile app may contain its environment's project URL and publishable key. It must never
contain the database URL, database password, Supabase secret key, service-role key, Vault
values, or a Supabase personal access token.

## Auth configuration

Configure each hosted project independently:

1. Enable email/password authentication.
2. Require email confirmation for production.
3. Set the exact site URL and redirect allowlist for the matching application environment.
4. Use an asymmetric signing key such as ES256.
5. Enable leaked-password protection for production.
6. Keep access-token lifetimes appropriate for the application's risk.

The Edge API sends the bearer token to the matching project’s Auth user endpoint. Auth
validates the token before the function trusts the returned user ID:

```text
https://PROJECT_REF.supabase.co/auth/v1/user
```

Hosted tokens are required for `/v1/state`, `/v1/chat`, and `/v1/images`. The lens
`/v1/display` endpoint uses the random pairing token as a capability credential.

### Optional Google and Apple sign-in

Create separate OAuth clients for trial and production. Register this Supabase callback in
the provider:

```text
https://PROJECT_REF.supabase.co/auth/v1/callback
```

Add only the matching app callback to each Supabase redirect allowlist, for example
`glance-trial://auth/callback` for trial and `glance://auth/callback` for production.
Keep provider secrets and Apple private keys outside the repository and mobile app.

For native iOS Sign in with Apple, send the Apple identity token and nonce to Supabase. Apple
provides the user's name only on the first sign-in, so save it then if needed.

## Database schema

The repository uses imperative SQL migrations under `supabase/migrations`. Apply them in
filename order to every Supabase project.

The migrations create:

- `app_private.pairings` for hashed pairing tokens, owner, state, expiry, and latest text.
- `public.pairing_images` for temporary object metadata.
- Supporting indexes and cleanup functions.
- Service-role-only RPCs used by the routed Edge API.
- Storage RLS policies.
- `pg_cron` and `pg_net` extensions.

`app_private` is not exposed by the Data API. `public.pairing_images` has RLS enabled and
forced, direct `anon` and `authenticated` metadata access is denied, and only the runtime
service role can call API and cleanup RPCs. Every privileged RPC fixes its `search_path` and
has its default public execution grant revoked.

The checked-in migration versions are the source of truth. Before and after a database
change, compare both remote histories with:

```bash
npx --yes supabase@2.116.0 migration list
```

Create new migrations with the Supabase CLI, review the SQL, apply the same file to trial
first, verify it, then apply it to production. Never edit an already-applied migration.

## Database deployment

Edge Functions receive database connectivity from Supabase and require no custom
`DATABASE_URL`. GitHub Actions uses `SUPABASE_DB_PASSWORD` only while applying migrations
with `supabase db push`. Keep the trial and production database passwords in their matching
protected GitHub environments.

Application requests access private pairing data only through the service-role-only RPCs in
`20260909032038_add_edge_api_rpcs.sql`. User-facing Data API roles cannot execute them.

## Temporary image lifecycle

One user can upload up to ten images for one active pairing. The Edge API registers metadata
before allowing Storage upload.
Storage policies require all of the following:

- The request uses the `authenticated` role.
- The first object-path folder equals `auth.uid()`.
- The object path matches pre-registered metadata.
- The same user owns the active, unexpired pairing.
- The metadata row is active and unexpired.

The Edge API passes a signed URL to NVIDIA only during the model request. The URL lasts 60
seconds, while the underlying object remains bound to the pairing expiry.

The `cleanup-pairing-images` Edge Function:

1. Confirms the configured `Images` or `images` bucket exists.
2. Reapplies private visibility, the 8 MiB limit, and the JPEG/PNG allowlist.
3. Claims expired metadata rows in bounded batches.
4. Deletes the corresponding objects through the Storage API.
5. Deletes metadata only after object deletion succeeds.

Deploy the function with JWT verification enabled:

```bash
npx --yes supabase@2.116.0 functions deploy cleanup-pairing-images --project-ref PROJECT_REF
```

Do not set `SUPABASE_SERVICE_ROLE_KEY` manually. Supabase provides it to the function
runtime.

## Cleanup schedule

Each project stores two values in Vault:

- `pairing_cleanup_project_url`
- `pairing_cleanup_publishable_key`

Cron runs `cleanup-pairing-images-every-minute` with schedule `* * * * *`. The command
reads both values from Vault and calls:

```text
https://PROJECT_REF.supabase.co/functions/v1/cleanup-pairing-images
```

The publishable key is passed as the bearer credential so the function gateway can verify
the scheduled request. Never place a populated key in a migration.

Verify the scheduler:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'cleanup-pairing-images-every-minute';

select status_code, error_msg, created
from net._http_response
order by id desc
limit 5;
```

Healthy scheduled calls return HTTP 200.

## Security verification

After any schema, policy, Auth, or Storage change:

1. Confirm `pairing_images` has RLS enabled and forced.
2. Confirm exactly three pairing-image policies exist on `storage.objects`.
3. Confirm the bucket is private with the expected size and MIME restrictions.
4. Confirm the API function is active with explicit in-function authentication and the
   cleanup function is active with gateway JWT verification.
5. Confirm the Cron job is active and the latest HTTP response is 200.
6. Run Supabase security and performance advisors.
7. Exercise an authenticated owner upload and verify a different user cannot read it.

Unused-index notices are expected immediately after provisioning and should be evaluated
again after representative traffic. Security warnings should be resolved before public
production traffic.

## Mobile integration

The mobile app authenticates directly with Supabase. The Edge API accepts access tokens but
must never receive the user's password.

1. Sign in with the Supabase client.
2. Store refresh tokens in Keychain.
3. Refresh sessions through the Supabase client.
4. Send the current access token as `Authorization: Bearer <TOKEN>`.
5. Use separate project URLs and publishable keys for trial and production builds.
6. Handle confirmation, reset, and social-login callbacks with the matching deep link.
7. Generate a random 32-character hexadecimal pairing token.
8. Register the pairing, upload images, and attach returned image IDs to chat messages.

Use these API base URLs:

```text
Trial: https://uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api
Production: https://hxtdfghufjjmeltarffl.supabase.co/functions/v1/api
```

A token from one Supabase project cannot authenticate against the other environment.

## Local Supabase and Docker

Local development uses the checked-in `supabase/config.toml`, migrations, routed API and
cleanup functions, seed file, and private `Images` bucket. Full startup, port mapping,
environment, OAuth, and fallback FastAPI instructions are in
[local-development.md](local-development.md).

## References

- [Supabase JWTs](https://supabase.com/docs/guides/auth/jwts)
- [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Storage bucket restrictions](https://supabase.com/docs/guides/storage/buckets/creating-buckets)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [NVIDIA Kimi-K3 multimodal endpoint](https://docs.api.nvidia.com/nim/re/reference/moonshotai-kimi-k3-infer)
