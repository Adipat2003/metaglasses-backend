import asyncio
import json
from collections.abc import Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.auth import AuthenticatedUser, TokenVerifier, build_current_user_dependency
from app.config import Settings
from app.image_storage import (
    ImageStorageError,
    ImageStorageProtocol,
    SupabaseImageStorage,
    UnavailableImageStorage,
)
from app.models import (
    ChatRequest,
    ChatResponse,
    ConversationMessage,
    DisplayResponse,
    ErrorResponse,
    HealthResponse,
    ImageUploadResponse,
    StateRequest,
)
from app.service import ChatService, ModelProviderError, NvidiaChatService, RateLimitedError
from app.store import (
    PairingImage,
    PairingImageLimitError,
    PairingImageNotFoundError,
    PairingNotFoundError,
    PairingOwnershipError,
    PairingStore,
    PairingStoreProtocol,
    PostgresPairingStore,
)

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
    payload = [message.model_dump(mode="json") for message in messages]
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def create_app(
    chat_service: ChatService | None = None,
    settings: Settings | None = None,
    token_verifier: TokenVerifier | None = None,
    pairing_store: PairingStoreProtocol | None = None,
    image_storage: ImageStorageProtocol | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    store = pairing_store or _build_pairing_store(resolved_settings)
    images = image_storage or _build_image_storage(resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if isinstance(store, PostgresPairingStore):
            await store.open()
        try:
            yield
        finally:
            if isinstance(store, PostgresPairingStore):
                await store.close()

    app = FastAPI(
        title="MetaGlasses API",
        version="0.1.0",
        description=(
            "Backend for the MetaGlasses phone-to-lens text loop. The phone authenticates "
            "with Supabase, submits conversation context and activity state, and the paired "
            "lens polls for the newest short instruction. Pairing state uses PostgreSQL when "
            "DATABASE_URL is configured and otherwise remains process-local."
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
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_credentials=False,
        allow_methods=["DELETE", "GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    service = chat_service or NvidiaChatService()
    current_user = build_current_user_dependency(resolved_settings, token_verifier)

    @app.get(
        "/healthz",
        tags=["System"],
        summary="Check process health",
        description=(
            "Confirms that the FastAPI process is responding and reports the selected "
            "application environment and authentication mode. This is a liveness check; "
            "it does not test NVIDIA or Supabase connectivity."
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

        image_ids = list(
            dict.fromkeys(
                image_id for message in request.messages for image_id in message.image_ids
            )
        )
        if len(image_ids) > resolved_settings.max_images_per_pairing:
            await store.set_state(request.pairing_token, "idle", user.id)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Too many images are attached to this chat request.",
            )
        try:
            stored_images = await store.get_images(request.pairing_token, user.id, image_ids)
            signed_urls = await asyncio.gather(
                *(
                    images.signed_url(
                        image.object_path,
                        min(
                            resolved_settings.image_signed_url_ttl_seconds,
                            resolved_settings.pairing_ttl_seconds,
                        ),
                        user.access_token,
                    )
                    for image in stored_images
                )
            )
            image_urls = {
                image.id: signed_url
                for image, signed_url in zip(stored_images, signed_urls, strict=True)
            }
        except PairingImageNotFoundError as error:
            await store.set_state(request.pairing_token, "idle", user.id)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="One or more images do not belong to this active pairing.",
            ) from error
        except ImageStorageError as error:
            await store.set_state(request.pairing_token, "idle", user.id)
            raise _image_storage_unavailable() from error
        try:
            text = await service.generate(request.messages, image_urls)
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

    @app.post(
        "/v1/images",
        tags=["Phone"],
        summary="Upload a temporary pairing image",
        description=(
            "Stores a JPEG or PNG in the private pairing bucket. Send the image bytes as "
            "the request body and identify the active pairing with the pairingToken query."
        ),
        status_code=status.HTTP_201_CREATED,
        response_model=ImageUploadResponse,
        operation_id="uploadPairingImage",
        responses={
            401: error_response("The bearer token or pairing token is invalid or expired."),
            403: error_response("The pairing token belongs to another authenticated user."),
            413: error_response("The image exceeds the configured byte limit."),
            415: error_response("The request is not a supported JPEG or PNG image."),
            429: error_response("The active pairing already contains the maximum images."),
            503: error_response("Supabase Storage is unavailable or not configured."),
        },
    )
    async def upload_image(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
        pairing_token: str = Query(
            alias="pairingToken",
            min_length=32,
            max_length=32,
            pattern=r"^[0-9a-fA-F]{32}$",
        ),
    ) -> ImageUploadResponse:
        try:
            await store.assert_active(pairing_token, user.id)
        except PairingNotFoundError as error:
            raise _pairing_missing() from error
        except PairingOwnershipError as error:
            raise _pairing_forbidden() from error

        content = await _read_image_body(request, resolved_settings.max_image_bytes)
        content_type, extension = _validated_image_type(
            request.headers.get("content-type", ""), content
        )
        image_id = uuid4()
        pairing_digest = sha256(pairing_token.encode("utf-8")).hexdigest()
        object_path = f"{user.id}/{pairing_digest}/{image_id}.{extension}"
        image = PairingImage(
            id=image_id,
            object_path=object_path,
            content_type=content_type,
            byte_size=len(content),
            created_at=datetime.now(UTC),
        )

        try:
            await store.register_image(
                pairing_token,
                user.id,
                image,
                resolved_settings.max_images_per_pairing,
            )
        except (PairingNotFoundError, PairingOwnershipError, PairingImageLimitError) as error:
            if isinstance(error, PairingNotFoundError):
                raise _pairing_missing() from error
            if isinstance(error, PairingOwnershipError):
                raise _pairing_forbidden() from error
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="This pairing already contains the maximum number of images.",
            ) from error

        try:
            await images.upload(object_path, content, content_type, user.access_token)
        except ImageStorageError as error:
            try:
                await store.remove_image(pairing_token, user.id, image_id)
            except (PairingNotFoundError, PairingOwnershipError, PairingImageNotFoundError):
                pass
            raise _image_storage_unavailable() from error

        return ImageUploadResponse(
            imageId=image.id,
            contentType=image.content_type,
            byteSize=image.byte_size,
            createdAt=image.created_at,
        )

    @app.delete(
        "/v1/images/{image_id}",
        tags=["Phone"],
        summary="Delete a temporary pairing image",
        description="Deletes one image owned by the authenticated user and active pairing.",
        status_code=status.HTTP_204_NO_CONTENT,
        operation_id="deletePairingImage",
        responses={
            401: error_response("The bearer token or pairing token is invalid or expired."),
            403: error_response("The pairing token belongs to another authenticated user."),
            404: error_response("The image does not belong to this active pairing."),
            503: error_response("Supabase Storage is unavailable or not configured."),
        },
    )
    async def delete_image(
        image_id: UUID,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
        pairing_token: str = Query(
            alias="pairingToken",
            min_length=32,
            max_length=32,
            pattern=r"^[0-9a-fA-F]{32}$",
        ),
    ) -> Response:
        try:
            image = (await store.get_images(pairing_token, user.id, [image_id]))[0]
            await images.delete(image.object_path, user.access_token)
            await store.remove_image(pairing_token, user.id, image_id)
        except PairingNotFoundError as error:
            raise _pairing_missing() from error
        except PairingOwnershipError as error:
            raise _pairing_forbidden() from error
        except PairingImageNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Image not found for this active pairing.",
            ) from error
        except ImageStorageError as error:
            raise _image_storage_unavailable() from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

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
                detail="Unknown or expired pairing token. Re-pair on the phone.",
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


def _build_pairing_store(settings: Settings) -> PairingStoreProtocol:
    if settings.database_url:
        return PostgresPairingStore(settings.database_url, settings.pairing_ttl_seconds)
    return PairingStore(settings.pairing_ttl_seconds)


def _build_image_storage(settings: Settings) -> ImageStorageProtocol:
    if settings.supabase_url and settings.supabase_publishable_key:
        return SupabaseImageStorage(
            settings.supabase_url,
            settings.supabase_publishable_key,
            settings.pairing_image_bucket,
        )
    return UnavailableImageStorage()


def _pairing_forbidden() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This pairing token belongs to another user.",
    )


def _pairing_missing() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unknown or expired pairing token. Re-pair on the phone.",
    )


def _image_storage_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Image storage unavailable.",
    )


async def _read_image_body(request: Request, max_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail="Image too large.",
                )
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid Content-Length header.",
            ) from error

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Image too large.",
            )
    if not body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image body must not be empty.",
        )
    return bytes(body)


def _validated_image_type(declared_type: str, content: bytes) -> tuple[str, str]:
    normalized_type = declared_type.split(";", 1)[0].strip().lower()
    signatures = {
        "image/jpeg": (content.startswith(b"\xff\xd8\xff"), "jpg"),
        "image/png": (content.startswith(b"\x89PNG\r\n\x1a\n"), "png"),
    }
    signature = signatures.get(normalized_type)
    if signature is None or not signature[0]:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Only valid JPEG and PNG images are supported.",
        )
    return normalized_type, signature[1]


app = create_app()
