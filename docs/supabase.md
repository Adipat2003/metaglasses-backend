# Supabase authentication setup

## Environment layout

The Supabase Free plan permits two active hosted projects. Use them as follows:

| App environment | Supabase environment | User data |
| --- | --- | --- |
| `local` | None | No auth; deterministic local user |
| `dev` | Supabase CLI running locally | Disposable development users |
| `trial` | Hosted project named `Glance Trial` | TestFlight and trial users only |
| `prod` | Hosted project named `Glance Production` | Production users only |

Never point two deployed environments at the same project. It mixes users, redirect
URLs, rate limits, and audit activity across trust boundaries.

## Hosted project checklist

Create `Glance Trial` and `Glance Production` in the Supabase dashboard. For each:

1. Enable email/password under Authentication providers.
2. Require email confirmation before production users can sign in.
3. Configure the site URL and allowed redirect URLs for that environment.
4. Use an asymmetric JWT signing key, preferably ES256. The FastAPI service verifies
   tokens through the public JWKS endpoint and deliberately does not accept legacy
   HS256 tokens.
5. Record the project URL for the backend and the project URL plus publishable key for
   the corresponding mobile build.
6. Keep the secret key, service-role key, database password, and personal access token
   out of the mobile app and repository.

Suggested native callback schemes are `glance-trial://auth/callback` and
`glance://auth/callback`. Register the matching URL scheme in each iOS target and add
the exact callback to the corresponding Supabase project's redirect allowlist.

## Backend configuration

The backend validates access tokens locally against:

```text
https://PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
```

It validates the signature, algorithm, issuer, audience, expiry, issued-at time,
subject, and authenticated role. It does not need a Supabase secret to do this.

Copy the appropriate template and supply its real values through your deployment
platform:

```powershell
Copy-Item .env.trial.example .env.trial
Copy-Item .env.prod.example .env.prod
```

Do not commit either resulting file. For deployments, configure the same variables in
the platform's secret and environment settings instead of uploading the files.

## Local unit tests without auth

Pytest forces `APP_ENV=local` and `AUTH_MODE=disabled` inside the test process. Tests
never contact Supabase and can inject a fake token verifier when exercising protected
routes:

```powershell
.venv\Scripts\python.exe -m pytest
```

The bypass cannot be selected with `APP_ENV=dev`, `trial`, or `prod`; application
startup fails if that combination is attempted.

## Local Supabase integration testing

Install a Docker-compatible runtime. The checked-in configuration was generated with
Supabase CLI 2.116.0. Generate a developer-only signing key, then start the stack with
the same CLI version:

```powershell
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
npx --yes supabase@2.116.0 start
Copy-Item .env.dev.example .env.dev
uv run uvicorn app.main:app --reload --env-file .env.dev
```

The generated `supabase/signing_keys.json` is ignored by Git. Each developer and CI
environment must generate its own key rather than sharing private signing material.

The CLI reports the local project URL and publishable key. The default API URL is
`http://127.0.0.1:54321`, which already matches the development template. Integration
requests must obtain a local Supabase access token and send it as a bearer token.

## Mobile changes required

The mobile application should authenticate directly with the Supabase client. FastAPI
is a resource server and must never receive a user's password.

1. Replace calls to `/v1/auth/login` and `/v1/auth/signup` with Supabase sign-in and
   sign-up calls.
2. Store the refresh token in Keychain and refresh short-lived sessions through the
   Supabase client.
3. Set the API client's bearer token to the current Supabase access token.
4. Use separate project URLs and publishable keys in dev, trial, and production builds.
5. Handle deep links for email confirmation, password reset, and later social login.
6. Include the user's lens pairing token in `/v1/chat` and `/v1/state` requests.

The API returns `401` for a missing, expired, or invalid access token and `403` when an
authenticated user attempts to reuse a pairing token owned by someone else.
