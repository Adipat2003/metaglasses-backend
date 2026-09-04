from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PairingState = Literal["idle", "listening", "thinking", "speaking"]


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ConversationMessage(BaseModel):
    """One turn from the phone-maintained conversation transcript."""

    role: Literal["user", "assistant"] = Field(
        description="Speaker that produced this conversation turn."
    )
    content: str = Field(
        min_length=1,
        description="Plain-text content for this conversation turn.",
        examples=["How do I change a bike tire?"],
    )

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class ChatRequest(ApiModel):
    """Conversation context used to generate the next lens instruction."""

    pairing_token: str = Field(
        alias="pairingToken",
        min_length=32,
        max_length=32,
        pattern=r"^[0-9a-fA-F]{32}$",
        description="Random 32-character hexadecimal capability shared with the paired lens.",
        examples=["a3f9d1e2c3b4a5f60718293a4b5c6d7e"],
    )
    messages: list[ConversationMessage] = Field(
        min_length=1,
        description="Complete conversation transcript maintained by the phone.",
    )


class StateRequest(ApiModel):
    """Phone-driven state update for a paired lens."""

    pairing_token: str = Field(
        alias="pairingToken",
        min_length=32,
        max_length=32,
        pattern=r"^[0-9a-fA-F]{32}$",
        description="Random 32-character hexadecimal capability shared with the paired lens.",
        examples=["a3f9d1e2c3b4a5f60718293a4b5c6d7e"],
    )
    state: PairingState = Field(
        description="Current phone activity that the lens should represent.",
        examples=["listening"],
    )


class ChatResponse(ApiModel):
    """Generated instruction returned to the phone and cached for the lens."""

    response_id: str = Field(
        alias="responseId",
        description="Unique identifier for this generated response.",
        examples=["r_183872e67d09416d9744cb1e78bd50f5"],
    )
    text: str = Field(
        description="Short plain-text instruction generated for the user.",
        examples=["Use your tire levers to lift one side of the bead over the rim."],
    )
    created_at: datetime = Field(
        alias="createdAt",
        description="UTC time when the response was created.",
    )


class DisplayResponse(ApiModel):
    """Newest instruction and current activity visible to a paired lens."""

    response_id: str | None = Field(
        default=None,
        alias="responseId",
        description="Newest response identifier, or null before the first generated response.",
    )
    text: str | None = Field(
        default=None,
        description="Newest generated instruction, or null while no response is available.",
    )
    state: PairingState = Field(description="Current phone-driven state.")
    created_at: datetime | None = Field(
        default=None,
        alias="createdAt",
        description="UTC creation time of the newest response, or null when none exists.",
    )


class HealthResponse(BaseModel):
    """Process health and active security configuration."""

    status: Literal["ok"] = Field(description="Process liveness status.", examples=["ok"])
    environment: Literal["local", "dev", "trial", "prod"] = Field(
        description="Selected application environment.", examples=["local"]
    )
    auth: Literal["disabled", "required"] = Field(
        description="Active authentication mode.", examples=["disabled"]
    )


class ErrorResponse(BaseModel):
    """Stable error envelope returned for application-level failures."""

    detail: str = Field(
        description="Human-readable explanation of the request failure.",
        examples=["Missing or invalid access token."],
    )
