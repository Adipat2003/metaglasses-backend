# Repository Guidelines

## Project Structure & Module Organization

The hosted API lives in `supabase/functions/api/`; its TypeScript handler owns routing, authentication, pairing operations, image Storage, and NVIDIA NIM integration. Database changes live in `supabase/migrations/`, while `cleanup-pairing-images` performs scheduled object cleanup. The Python code under `app/` is a temporary FastAPI rollback implementation and remains covered by tests during migration. Operational setup notes belong in `docs/`. Use committed example environment files as templates, but keep real environment files untracked.

## Build, Test, and Development Commands

- `uv sync --all-groups`: create or update the local environment from `uv.lock`, including development tools.
- `uv run uvicorn app.main:app --reload --env-file .env.local`: run the API with hot reload at `http://127.0.0.1:8000`.
- `uv run ruff check .`: run import, style, and modernization checks.
- `uv run python -m pytest`: run the complete unit test suite.
- `npx --yes supabase@2.116.0 start`: run the local Supabase stack and Edge API.
- `bash scripts/smoke-edge-api.sh`: exercise local Auth, pairing, Storage, and API behavior.
- `docker run --rm --volume "$PWD:/work" --workdir /work denoland/deno:2.5.2 deno check --config supabase/functions/deno.json supabase/functions/api/index.ts supabase/functions/cleanup-pairing-images/index.ts`: type-check Edge Functions.

Create the ignored signing-key and function environment files before local Supabase development. Copy `.env.local.example` only when exercising the FastAPI fallback. See `docs/local-development.md` for both workflows.

## Coding Style & Naming Conventions

Use Deno formatting with a 100-character line width for Edge Functions. Keep routed handlers small, validate every untrusted request field, and restrict privileged database RPCs to `service_role`. Target Python 3.12 for the fallback. Ruff enforces `E`, `F`, `I`, and `UP` rules with a 100-character line limit. Use `snake_case` for Python modules, functions, variables, and tests; use `PascalCase` for classes and Pydantic models.

## Testing Guidelines

Pytest is configured to discover tests under `tests/`. Name files `test_*.py` and tests `test_<expected_behavior>`. Keep unit tests deterministic: `tests/conftest.py` disables authentication locally, while protected-route tests inject a fake verifier. Add regression coverage for status codes, response contracts, configuration validation, and provider error mapping. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case subjects such as `Add Supabase authentication environments`. Keep each commit focused and include related tests or documentation. Pull requests should explain the behavior change, note configuration or security impact, link the relevant issue, and list validation commands run. Include screenshots only for changes affecting generated API documentation or another visible interface.

## Security & Configuration

Never commit API keys, access tokens, generated signing keys, or populated `.env` files. The backend validates public Supabase JWKS data and should not receive service-role credentials. Authentication bypass is valid only with `APP_ENV=local`; hosted environments must use HTTPS and explicit CORS origins.
