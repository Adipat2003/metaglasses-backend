# Repository Guidelines

## Sources of Truth

Use this map before searching the repository:

| Concern | Source of truth |
| --- | --- |
| Hosted API routes, auth, errors, and Storage | `supabase/functions/api/index.ts` |
| NVIDIA submission, polling, and tests | `supabase/functions/api/nvidia.ts`, `nvidia_test.ts` |
| Database schema, RLS, RPCs, and schedules | `supabase/migrations/` |
| Cleanup worker | `supabase/functions/cleanup-pairing-images/index.ts` |
| Local Python reference API | `app/` and `tests/` |
| Environment templates | `config/env/` |
| Canonical Postman collection and environments | `Adipat2003/metaglasses-postman` |
| Local setup, deployment, and security | `docs/` |

Trial and production run only the Supabase Edge API. Treat `app/` as a local reference, not a
deployment target. Never edit an applied migration. Canonical Postman assets live in the separate
`Adipat2003/metaglasses-postman` repository and are not duplicated here.

## Efficient Navigation

Search the smallest relevant area first. Skip `uv.lock` unless it is directly relevant.

```bash
rg -n 'routePath|Deno.serve' supabase/functions/api
rg -n 'NVIDIA|model_' supabase/functions/api docs
rg -n 'create or replace function|create policy' supabase/migrations
rg -n 'operationId|@app\.' app tests
rg -n 'PROJECT_REF|SUPABASE_' .github docs supabase
```

When behavior and documentation disagree, verify the implementation and tests, then update the
documentation in the same change.

## Development and Validation

- `uv sync --locked --all-groups`: install the Python 3.12 environment.
- `uv run ruff check .`: lint Python.
- `uv run python -m pytest`: run Python and repository configuration tests.
- `npx --yes supabase@2.116.0 start`: run local Supabase.
- `bash scripts/smoke-edge-api.sh`: test local Auth, pairing, Storage, and API behavior.

Run the pinned Deno formatting, type-checking, and test commands from
`docs/local-development.md`.

## Style and Tests

Format TypeScript with the Deno config at a 100-character width. Keep handlers small, validate
untrusted fields, and limit privileged RPCs to `service_role`. Python uses Ruff rules `E`, `F`,
`I`, and `UP`, `snake_case` names, and `PascalCase` classes. Name tests
`test_<expected_behavior>`. Cover response contracts, configuration, security boundaries, and
provider error mapping.

## Engineering Quality Bar

This backend prioritizes deterministic behavior, complete verification, useful observability, and
small stable contracts. Apply these requirements to every change without waiting for them to be
restated in an issue or review.

### Determinism and explicit behavior

- Given the same validated inputs and controlled dependencies, code must produce the same result.
  Use stable ordering, explicit defaults, fixed provider fallback order, and canonical
  serialization where output order affects behavior or tests.
- Keep time, randomness, generated identifiers, network calls, and environment reads at explicit
  boundaries. Make them injectable or controllable in tests when they affect an outcome.
- Pin runtime and tool versions. Do not depend on implicit platform defaults, ambient machine
  state, unordered collection iteration, or timing-sensitive sleeps.
- Bound every external operation with an explicit timeout. Retries must be limited, classified by
  retryable failure, and covered by tests. Never retry authentication, validation, or other
  deterministic client failures.
- Make retryable writes idempotent or protect them with stable request or resource identifiers so
  a repeated request cannot create unintended duplicate state.

### Complete testing

- Every behavior change must include automated tests for the success path, validation failures,
  dependency failures, authorization boundaries, and relevant edge cases. Every bug fix must add
  a regression test that fails without the fix.
- Exercise each meaningful branch and state transition. A coverage percentage alone is not proof
  of adequate testing, and no changed production branch should remain untested without a written
  justification in the pull request.
- Prefer deterministic fakes and fixed clocks over flaky waits or live provider calls in CI. Keep
  contract tests at external boundaries and focused unit tests around parsing, mapping, fallback,
  retry, and redaction logic.
- Test negative security properties, including cross-user access, missing authentication,
  malformed input, secret redaction, SSRF restrictions, and least-privilege database access.
- Keep tests independent and order-insensitive. A test must not require state leaked from another
  test or depend on the wall clock, network availability, or a hosted service unless it is an
  explicitly labeled integration or smoke test.
- Run the smallest relevant tests during development and the full repository validation before
  committing. Do not weaken, skip, or delete a failing test merely to make CI pass.

### Structured logging and observability

- Log meaningful lifecycle stages for requests and background work, including acceptance,
  validation outcome, dependency attempts, retries or fallbacks, persistence outcome, and final
  completion or failure where applicable. Avoid noisy per-line logging.
- Emit structured JSON with stable event names and fields. Include `request_id`, operation, route
  or job name, environment, outcome, duration, provider and model when relevant, upstream status,
  retry or fallback count, and a stable error code.
- Propagate one correlation ID across internal stages and dependency attempts. Return the request
  ID to the caller so a user-visible failure can be matched directly to logs.
- Log enough context to identify the failed stage and next operational action, but never log API
  keys, authorization headers, session tokens, signed URLs, raw request bodies, image bytes, or
  unnecessary personal data. Redaction is a backup control, not permission to log secrets.
- Record unexpected failures at error level, expected client failures at warning level, and
  successful completion at info level. Do not swallow exceptions or fail silently.
- Logging must not change application behavior. A logging failure must not break the user request,
  and logs must remain bounded in size.

### Error contracts

- Return concise user-facing error text, a stable machine-readable code, the `request_id`, and only
  safe context that helps the caller recover. Include a short `suggested_action` when the next step
  is not obvious.
- Distinguish validation, authentication, authorization, not-found, conflict, rate-limit,
  dependency, timeout, and internal failures with appropriate HTTP statuses and codes.
- Never return stack traces, credentials, raw provider bodies, internal URLs, database details, or
  implementation-specific exception text. Preserve detailed safe diagnostics in structured logs.
- Keep existing error codes and response shapes backward compatible. Treat any change to them as
  an API contract change with tests, documentation, and Postman synchronization.

### Reliability, security, and maintainability

- Validate and normalize all untrusted input at the boundary. Use allowlists for provider hosts,
  redirect targets, content types, state transitions, and externally selected capabilities.
- Apply least privilege to credentials, database functions, Storage, and service roles. Keep
  secrets out of source control and persist user credentials only when the product explicitly
  requires it and an approved encryption and deletion design exists.
- Set explicit limits for payload size, transcript size, image bytes, concurrency, retries, and
  external response size. A feature described as unlimited must still have documented safety
  bounds imposed by infrastructure or abuse protection.
- Keep functions cohesive and provider-specific behavior behind narrow adapters. Avoid duplicated
  validation, error mapping, redaction, and logging logic.
- Preserve backward compatibility by default. For intentional breaking changes, document the
  migration path, update every consumer contract, and make rollout and rollback steps explicit.
- For operationally significant changes, document how to detect failure, how to roll back safely,
  and which metric or log event confirms recovery.

## Security and Configuration

Copy the required template from `config/env/` to the ignored runtime path documented in
`docs/local-development.md`. Never commit populated environment files, access tokens, API keys,
database passwords, signing keys, or private URLs. Authentication bypass is valid only with
`APP_ENV=local`. Hosted environments require HTTPS and explicit CORS origins.

## Cross-repository Postman contract sync

`Adipat2003/metaglasses-postman` is the canonical Postman workspace. After CI succeeds on a
`main` commit that changes `supabase/functions/api/` or the Edge Function environment contract,
the backend dispatches that exact commit to the Postman repository through the configured
Postman-sync GitHub App. Its sync workflow automatically opens or updates a PR there; it never
pushes Postman changes directly to `main`.

When creating a backend PR that changes routes, HTTP methods, authentication, request or response
contracts, or Edge Function environment variables, expect a linked Postman contract-sync PR after
merge. Update the Native Git Postman requests and environments in that PR and merge it only after
its validation passes.

## Git and Pull Requests

Never commit directly to `main`. Create a scoped branch, make focused imperative commits, push,
and open a pull request. Summarize behavior, configuration or security impact, linked issues when
available, and validation commands. Include screenshots only for visible interface changes.
