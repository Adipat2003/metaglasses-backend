from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PairingState = Literal["idle", "listening", "thinking", "speaking"]


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class ChatRequest(ApiModel):
    pairing_token: str = Field(
        alias="pairingToken", min_length=32, max_length=32, pattern=r"^[0-9a-fA-F]{32}$"
    )
    messages: list[ConversationMessage] = Field(min_length=1)


class StateRequest(ApiModel):
    pairing_token: str = Field(
        alias="pairingToken", min_length=32, max_length=32, pattern=r"^[0-9a-fA-F]{32}$"
    )
    state: PairingState


class ChatResponse(ApiModel):
    response_id: str = Field(alias="responseId")
    text: str
    created_at: datetime = Field(alias="createdAt")


class DisplayResponse(ApiModel):
    response_id: str | None = Field(default=None, alias="responseId")
    text: str | None = None
    state: PairingState
    created_at: datetime | None = Field(default=None, alias="createdAt")
