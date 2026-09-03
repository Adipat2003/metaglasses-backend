# MetaGlasses backend

FastAPI service for the v0.1 phone-to-lens text loop. It exposes exactly three
application endpoints:

- `POST /v1/chat`: accepts a full text transcript, calls GPT-5.6 Sol, and stores only
  the newest response for the paired lens.
- `GET /v1/display?token=...`: returns the newest response and phone-driven state.
- `POST /v1/state`: updates the lens state without blocking the phone voice loop.

The service never accepts, stores, or returns audio. Conversation history remains
on the phone. The in-memory pairing record expires one hour after the last phone
request, so deploy v0.1 as one application instance. Use a shared TTL store before
running more than one instance.

## Run locally

Open a new PowerShell terminal so the recently installed `python` and `uv` commands
are available, then run:

```powershell
cd C:\Github\fastapi-backend
$env:OPENAI_API_KEY = "your-api-key"
uv sync --all-groups
uv run uvicorn app.main:app --reload
```

The API is available at `http://127.0.0.1:8000`; FastAPI's interactive API page is
at `http://127.0.0.1:8000/docs`.

The default model is `gpt-5.6-sol`. Set `OPENAI_MODEL` to select another compatible
OpenAI model after testing its latency and response quality.

Set `CORS_ORIGINS` to the web app's deployed origin or a comma-separated allowlist
before deployment. The local default is `*` to permit the separate web client during
initial integration.

## Check the project

```powershell
uv run ruff check .
uv run pytest
```

## Pairing lifecycle

The phone generates a 32-character hexadecimal token and sends it in its first
`POST /v1/state` or `POST /v1/chat`. That registers the ephemeral pairing record.
Lens polling with an unknown or expired token receives `401` and should request
re-pairing on the phone.
