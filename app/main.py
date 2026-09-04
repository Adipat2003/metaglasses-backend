import json
from collections.abc import Sequence
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.auth import AuthenticatedUser, TokenVerifier, build_current_user_dependency
from app.config import Settings
from app.models import (
    ChatRequest,
    ChatResponse,
    ConversationMessage,
    DisplayResponse,
    ErrorResponse,
    HealthResponse,
    StateRequest,
)
from app.service import ChatService, ModelProviderError, OpenAIChatService, RateLimitedError
from app.store import PairingOwnershipError, PairingStore

MAX_TRANSCRIPT_BYTES = 256_000

OPENAPI_TAGS = [
    {
        "name": "System",
        "description": "Process health and runtime configuration visibility.",
    },
    {
        "name": "Phone",
        "description": (
            "Authenticated operations called by the phone. Supply a valid Supabase "
            "access token with the bearer authentication scheme."
        ),
    },
    {
        "name": "Lens",
        "description": (
            "Capability-protected polling used by the paired lens. The random pairing "
            "token is the credential for these operations."
        ),
    },
]


def error_response(description: str) -> dict[str, object]:
    return {"model": ErrorResponse, "description": description}


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
            "Backend for the MetaGlasses phone-to-lens text loop. The phone authenticates "
            "with Supabase, submits conversation context and activity state, and the paired "
            "lens polls for the newest short instruction. Pairing state is process-local in "
            "v0.1, so deployments must use one application replica."
        ),
        openapi_tags=OPENAPI_TAGS,
        servers=[{"url": "/", "description": "Current environment"}],
        swagger_ui_parameters={
            "displayRequestDuration": True,
            "docExpansion": "list",
            "filter": True,
            "operationsSorter": "method",
            "persistAuthorization": True,
            "tagsSorter": "alpha",
        },
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

    @app.get(
        "/healthz",
        tags=["System"],
        summary="Check process health",
        description=(
            "Confirms that the FastAPI process is responding and reports the selected "
            "application environment and authentication mode. This is a liveness check; "
            "it does not test OpenAI or Supabase connectivity."
        ),
        response_description="Current process health and runtime mode.",
        response_model=HealthResponse,
        operation_id="getHealth",
    )
    async def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            environment=resolved_settings.app_env,
            auth=resolved_settings.auth_mode,
        )

    @app.post(
        "/v1/chat",
        tags=["Phone"],
        summary="Generate the next lens instruction",
        description=(
            "Accepts the complete phone-maintained conversation transcript, marks the paired "
            "lens as thinking, and asks the configured model for one short next step. The "
            "successful response is cached as the newest display content for the pairing."
        ),
        response_description="Generated instruction cached for the phone and lens.",
        response_model=ChatResponse,
        operation_id="createChatResponse",
        responses={
            401: error_response("The Supabase bearer token is missing, expired, or invalid."),
            403: error_response("The pairing token belongs to another authenticated user."),
            413: error_response("The serialized transcript exceeds 256,000 UTF-8 bytes."),
            429: error_response("The model provider rate limited the request."),
            503: error_response("The model provider is unavailable or not configured."),
        },
    )
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
            text = await service.generate(
                request.messages, request.pairing_token, system=request.system
            )
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

    @app.get(
        "/v1/display",
        tags=["Lens"],
        summary="Get the newest paired-lens display",
        description=(
            "Returns the current phone-driven state and newest generated instruction for a "
            "pairing. This operation does not use Supabase authentication because the random "
            "32-character pairing token acts as a capability credential."
        ),
        response_description="Newest response and current state for the pairing.",
        response_model=DisplayResponse,
        operation_id="getDisplay",
        responses={
            401: error_response("The pairing token is unknown or has expired."),
        },
    )
    async def display(
        token: str = Query(
            min_length=32,
            max_length=32,
            pattern=r"^[0-9a-fA-F]{32}$",
            description="Random 32-character hexadecimal capability generated by the phone.",
            examples=["a3f9d1e2c3b4a5f60718293a4b5c6d7e"],
        ),
    ) -> DisplayResponse:
        current = await store.get_display(token)
        if current is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=(
                    "This pairing has no recent activity. It will resume automatically the "
                    "next time the paired phone sends a request."
                ),
            )
        return current

    @app.post(
        "/v1/state",
        tags=["Phone"],
        summary="Update the paired-lens activity state",
        description=(
            "Registers a new pairing for the authenticated user or updates an existing pairing "
            "to idle, listening, thinking, or speaking. An active pairing cannot be claimed by "
            "a different user."
        ),
        status_code=status.HTTP_204_NO_CONTENT,
        operation_id="updatePairingState",
        responses={
            401: error_response("The Supabase bearer token is missing, expired, or invalid."),
            403: error_response("The pairing token belongs to another authenticated user."),
        },
    )
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
