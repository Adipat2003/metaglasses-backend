import json
from collections.abc import Sequence
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.auth import AuthenticatedUser, TokenVerifier, build_current_user_dependency
from app.config import Settings
from app.models import ChatRequest, ChatResponse, ConversationMessage, DisplayResponse, StateRequest
from app.service import ChatService, ModelProviderError, OpenAIChatService, RateLimitedError
from app.store import PairingOwnershipError, PairingStore

MAX_TRANSCRIPT_BYTES = 256_000


def transcript_size(messages: Sequence[ConversationMessage]) -> int:
    payload = [message.model_dump() for message in messages]
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def create_app(
    chat_service: ChatService | None = None,
    settings: Settings | None = None,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    app = FastAPI(
        title="MetaGlasses API",
        version="0.1.0",
        description=(
            "Phone-to-lens text API. Protected phone endpoints accept Supabase access "
            "tokens through the Bearer authentication scheme."
        ),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    store = PairingStore()
    service = chat_service or OpenAIChatService()
    current_user = build_current_user_dependency(resolved_settings, token_verifier)

    @app.get("/healthz", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "environment": resolved_settings.app_env,
            "auth": resolved_settings.auth_mode,
        }

    @app.post("/v1/chat", response_model=ChatResponse)
    async def chat(
        request: ChatRequest,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> ChatResponse:
        if transcript_size(request.messages) > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Transcript too large. Trim the oldest turns and retry.",
            )

        try:
            await store.set_state(request.pairing_token, "thinking", user.id)
        except PairingOwnershipError as error:
            raise _pairing_forbidden() from error
        try:
            text = await service.generate(request.messages, request.pairing_token)
        except RateLimitedError as error:
            await store.set_state(request.pairing_token, "idle", user.id)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Model rate limited. Back off and retry.",
            ) from error
        except ModelProviderError as error:
            await store.set_state(request.pairing_token, "idle", user.id)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Model provider unavailable.",
            ) from error

        display = await store.save_response(request.pairing_token, text, user.id)
        return ChatResponse(
            responseId=display.response_id,
            text=text,
            createdAt=display.created_at,
        )

    @app.get("/v1/display", response_model=DisplayResponse)
    async def display(
        token: str = Query(min_length=32, max_length=32, pattern=r"^[0-9a-fA-F]{32}$"),
    ) -> DisplayResponse:
        current = await store.get_display(token)
        if current is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unknown or expired pairing token. Re-pair on the phone.",
            )
        return current

    @app.post("/v1/state", status_code=status.HTTP_204_NO_CONTENT)
    async def set_state(
        request: StateRequest,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> Response:
        try:
            await store.set_state(request.pairing_token, request.state, user.id)
        except PairingOwnershipError as error:
            raise _pairing_forbidden() from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app


def _pairing_forbidden() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This pairing token belongs to another user.",
    )


app = create_app()
