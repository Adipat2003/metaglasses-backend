import json
import os
from collections.abc import Sequence

from fastapi import FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.models import ChatRequest, ChatResponse, ConversationMessage, DisplayResponse, StateRequest
from app.service import ChatService, ModelProviderError, OpenAIChatService, RateLimitedError
from app.store import PairingStore

MAX_TRANSCRIPT_BYTES = 256_000


def configured_origins() -> list[str]:
    configured = os.getenv("CORS_ORIGINS", "*").split(",")
    return [origin.strip() for origin in configured if origin.strip()]


def transcript_size(messages: Sequence[ConversationMessage]) -> int:
    payload = [message.model_dump() for message in messages]
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def create_app(chat_service: ChatService | None = None) -> FastAPI:
    app = FastAPI(title="MetaGlasses API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=configured_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    store = PairingStore()
    service = chat_service or OpenAIChatService()

    @app.post("/v1/chat", response_model=ChatResponse)
    async def chat(request: ChatRequest) -> ChatResponse:
        if transcript_size(request.messages) > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Transcript too large. Trim the oldest turns and retry.",
            )

        await store.set_state(request.pairing_token, "thinking")
        try:
            text = await service.generate(request.messages, request.pairing_token)
        except RateLimitedError as error:
            await store.set_state(request.pairing_token, "idle")
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Model rate limited. Back off and retry.",
            ) from error
        except ModelProviderError as error:
            await store.set_state(request.pairing_token, "idle")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Model provider unavailable.",
            ) from error

        display = await store.save_response(request.pairing_token, text)
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
    async def set_state(request: StateRequest) -> Response:
        await store.set_state(request.pairing_token, request.state)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app


app = create_app()
