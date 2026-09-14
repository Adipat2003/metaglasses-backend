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
| Generated API client artifacts | `scripts/generate-postman-collection.mjs` |
| Local setup, deployment, and security | `docs/` |

Trial and production run only the Supabase Edge API. Treat `app/` as a local reference, not a
deployment target. Never edit an applied migration or hand-edit generated Postman JSON.

## Efficient Navigation

Search the smallest relevant area first. Skip `uv.lock` and generated `postman/*.json` unless
they are directly relevant.

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
- `node scripts/generate-postman-collection.mjs --check`: verify generated Postman files.
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

## Security and Configuration

Copy the required template from `config/env/` to the ignored runtime path documented in
`docs/local-development.md`. Never commit populated environment files, access tokens, API keys,
database passwords, signing keys, or private URLs. Authentication bypass is valid only with
`APP_ENV=local`. Hosted environments require HTTPS and explicit CORS origins.

## Git and Pull Requests

Never commit directly to `main`. Create a scoped branch, make focused imperative commits, push,
and open a pull request. Summarize behavior, configuration or security impact, linked issues when
available, and validation commands. Include screenshots only for visible interface changes.
