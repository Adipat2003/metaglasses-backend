# Supabase authentication setup

## Environment layout

The Supabase Free plan permits two active hosted projects. Use them as follows:

| App environment | Supabase environment | User data |
| --- | --- | --- |
| `local` | None or Supabase CLI running locally | Local API work and disposable auth users |
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

### Enable Google in each hosted project

Google configuration is separate for `Glance Trial` and `Glance Production`.

1. In Google Cloud Console, create or select a project, configure the OAuth consent
   screen, and create an OAuth 2.0 Client ID of type **Web application**.
2. In the matching Supabase project, open **Authentication > Sign In / Providers >
   Google**. Copy the callback URL shown by Supabase. It has the form
   `https://PROJECT_REF.supabase.co/auth/v1/callback`.
3. Add that exact callback under **Authorized redirect URIs** in the Google client.
4. Paste the Google client ID and client secret into the Supabase Google provider and
   enable it. Never place the client secret in the app or this repository.
5. Under **Authentication > URL Configuration**, add the environment's exact app
   callback: `glance-trial://auth/callback` or `glance://auth/callback`.

Use separate Google OAuth clients for trial and production so that callbacks and
consent-screen configuration cannot be changed across environments accidentally.

### Enable Apple in each hosted project

Apple configuration is also separate for trial and production.

1. In Apple Developer, create an App ID with Sign in with Apple enabled. For a web
   OAuth flow, also create a Services ID and a Sign in with Apple private key.
2. Configure the Services ID website domain as `PROJECT_REF.supabase.co` and its return
   URL as `https://PROJECT_REF.supabase.co/auth/v1/callback`.
3. Generate an Apple client secret from the Team ID, Services ID, Key ID, and `.p8`
   signing key. Do not put the `.p8` file or generated secret in this repository.
4. In Supabase, open **Authentication > Sign In / Providers > Apple**. Enter the
   Services ID as the first client ID, enter the generated secret, and enable Apple.
5. Add the exact environment callback under **Authentication > URL Configuration**.
6. Schedule secret rotation before Apple's generated client secret expires. Apple web
   OAuth secrets must be rotated at least every six months.

For a native iOS application, Apple's native sign-in flow is preferred. The app sends
the Apple identity token and nonce to Supabase. Apple supplies the user's full name
only on the first native sign-in, so the app must save it then if the product needs it.

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

The hosted backend also uses PostgreSQL for short-lived pairing state. Apply the
checked-in migrations to each hosted project, then set `DATABASE_URL` in the hosting
platform's secret manager. The table is in the unexposed `app_private` schema and
contains only a SHA-256 pairing-token hash, owner ID, lens state, expiry, and newest
generated response. It does not contain conversation transcripts or audio.

For a persistent Render service, use the Supabase session pooler connection string
when the direct IPv6 endpoint is unavailable. Keep `sslmode=require` in the URL. The
database password must be percent-encoded, and the full URL must never be committed.

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

The bypass cannot be selected with `APP_ENV=trial` or `prod`; application startup
fails if that combination is attempted.

## Local Supabase integration testing

Install a Docker-compatible runtime. The checked-in configuration was generated with
Supabase CLI 2.116.0. Generate a developer-only signing key, then start the stack with
the same CLI version:

```powershell
Copy-Item supabase/signing_keys.example.json supabase/signing_keys.json
npx --yes supabase@2.116.0 gen signing-key --algorithm ES256 --append
npx --yes supabase@2.116.0 start
Copy-Item .env.local-auth.example .env.local-auth
uv run uvicorn app.main:app --reload --env-file .env.local-auth
```

The generated `supabase/signing_keys.json` is ignored by Git. Each developer and CI
environment must generate its own key rather than sharing private signing material.

The CLI reports the local project URL and publishable key. The default API URL is
`http://127.0.0.1:54321`, which already matches the local-auth template. Integration
requests must obtain a local Supabase access token and send it as a bearer token.

### Local Google and Apple provider credentials

The checked-in `supabase/config.toml` enables both providers and reads all credentials
from process environment variables. Copy the safe template, populate the ignored
file, load its values into the current PowerShell process, and then start Supabase:

```powershell
Copy-Item supabase/oauth.env.example supabase/oauth.env
$oauthConfig = Get-Content supabase/oauth.env | ConvertFrom-StringData
$oauthConfig.GetEnumerator() | ForEach-Object {
    [Environment]::SetEnvironmentVariable($_.Key, $_.Value, "Process")
}
supabase start
```

For Google, register `http://127.0.0.1:54321/auth/v1/callback` as an authorized
redirect URI in the Google web client. Apple does not accept a loopback HTTP return
URL for web OAuth. Set `SUPABASE_AUTH_EXTERNAL_APPLE_REDIRECT_URI` to the public HTTPS
tunnel URL that forwards to the local Supabase Auth callback. Testing Apple in the
hosted trial project is usually simpler.

The local provider credential file is ignored by Git. Do not paste its values into an
issue, commit, chat, Postman export, or shell transcript.

## Simulate signup and retrieve a bearer token in Postman

Keep Postman collections and environments outside the repository because populated
environments contain credentials. Create an environment for the target Supabase
project and define `supabase_url`, `supabase_publishable_key`, `backend_url`,
`test_email`, `test_password`, `access_token`, `refresh_token`, and `pairing_token`.

1. Select the environment in Postman's environment picker.
2. Fill `supabase_publishable_key`, `test_email`, and `test_password`. For trial and
   production, also configure the project and backend URLs.
3. Send **Sign up with email and password**. Local Supabase normally returns a session
   immediately. A hosted project with email confirmation enabled returns a user but
   no session until the link is confirmed.
4. Send **Sign in with password and save bearer token**. A Postman test script can save the
   returned `access_token` and `refresh_token` as values in the selected environment.
5. Send **Get current user** to validate the token, then send **Set paired lens state
   with bearer token** to prove the backend accepts it.

Each Supabase project is a separate issuer and user store. Repeat signup and sign-in
against each environment. A local token cannot authenticate against trial or production,
and a trial token cannot authenticate against production.

The request headers serve different purposes:

```http
apikey: <SUPABASE_PUBLISHABLE_KEY>
Authorization: Bearer <USER_ACCESS_TOKEN>
```

The publishable key identifies the Supabase project and is safe for a public client.
It is not a user bearer token. Never use a Supabase secret key or legacy service-role
key in Postman for these tests. The access token is short-lived; sign in again when it
expires. Treat the refresh token as a credential and never export or commit a populated
Postman environment.

Social login cannot be fully simulated as a password request because Google and Apple
require interactive browser consent. Start the provider authorization request in a
browser or Postman, but complete the flow in an app or browser that can return to the
registered deep link. The resulting Supabase session contains the same kind of access
token that the FastAPI backend accepts.

## Find values and activity in the Supabase dashboard

For each hosted project:

- **Connect** or **Project Settings > API Keys** shows the project URL and publishable
  key used by the Postman environment and mobile app.
- **Authentication > Sign In / Providers** shows whether Email, Google, and Apple are
  enabled and contains the hosted provider credential forms.
- **Authentication > URL Configuration** contains the site URL and allowed redirects.
- **Authentication > Users** lists email/password and social users. Opening a user
  shows identities and metadata.
- **Authentication > Audit Logs** shows signup, sign-in, token refresh, password-reset,
  and logout activity.
- **Logs > Auth** provides lower-level Auth service logs when a callback or token
  exchange fails.

Local Supabase Studio is available at `http://127.0.0.1:54323` after `supabase start`.
Its Authentication section shows local users. Local confirmation and reset emails are
captured by Mailpit at `http://127.0.0.1:54324` instead of being delivered externally.

## Mobile changes required

The mobile application should authenticate directly with the Supabase client. FastAPI
is a resource server and must never receive a user's password.

1. Replace calls to `/v1/auth/login` and `/v1/auth/signup` with Supabase sign-in and
   sign-up calls.
2. Store the refresh token in Keychain and refresh short-lived sessions through the
   Supabase client.
3. Set the API client's bearer token to the current Supabase access token.
4. Use separate project URLs and publishable keys in local, trial, and production builds.
5. Handle deep links for email confirmation, password reset, and later social login.
6. Include the user's lens pairing token in `/v1/chat` and `/v1/state` requests.

The API returns `401` for a missing, expired, or invalid access token and `403` when an
authenticated user attempts to reuse a pairing token owned by someone else.
