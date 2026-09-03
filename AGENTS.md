# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `app/`. `main.py` defines the FastAPI routes and app factory, `models.py` contains request and response models, `service.py` integrates with OpenAI, `auth.py` validates Supabase tokens, and `store.py` manages ephemeral pairing state. Tests live in `tests/` and mirror behavior at the API and configuration boundaries. Supabase development files are under `supabase/`; operational setup notes belong in `docs/`. Use the committed `.env.*.example` files as configuration templates, but keep real environment files untracked.

## Build, Test, and Development Commands

- `uv sync --all-groups`: create or update the local environment from `uv.lock`, including development tools.
- `uv run uvicorn app.main:app --reload --env-file .env.local`: run the API with hot reload at `http://127.0.0.1:8000`.
- `uv run ruff check .`: run import, style, and modernization checks.
- `uv run python -m pytest`: run the complete unit test suite.

Copy `.env.local.example` to `.env.local` before local development. See `docs/supabase.md` when testing authenticated flows against the local Supabase stack.

## Coding Style & Naming Conventions

Target Python 3.12 and use four-space indentation. Ruff enforces `E`, `F`, `I`, and `UP` rules with a 100-character line limit. Use `snake_case` for modules, functions, variables, and tests; use `PascalCase` for classes and Pydantic models. Keep route handlers thin, put provider behavior in services, and inject fakes through `create_app` for testability. Add type annotations to public functions and asynchronous boundaries.

## Testing Guidelines

Pytest is configured to discover tests under `tests/`. Name files `test_*.py` and tests `test_<expected_behavior>`. Keep unit tests deterministic: `tests/conftest.py` disables authentication locally, while protected-route tests inject a fake verifier. Add regression coverage for status codes, response contracts, configuration validation, and provider error mapping. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case subjects such as `Add Supabase authentication environments`. Keep each commit focused and include related tests or documentation. Pull requests should explain the behavior change, note configuration or security impact, link the relevant issue, and list validation commands run. Include screenshots only for changes affecting generated API documentation or another visible interface.

## Security & Configuration

Never commit API keys, access tokens, generated signing keys, or populated `.env` files. The backend validates public Supabase JWKS data and should not receive service-role credentials. Authentication bypass is valid only with `APP_ENV=local`; hosted environments must use HTTPS and explicit CORS origins.
