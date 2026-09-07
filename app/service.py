import os
from collections.abc import Mapping, Sequence
from typing import Protocol
from uuid import UUID

import httpx

from app.models import ConversationMessage

SYSTEM_PROMPT = """You are the MetaGlasses step-by-step voice assistant.
Answer the user's latest request with exactly one practical next step in one short,
plain-text sentence. Keep the answer concise enough to fit on a small wearable lens.
Do not use markdown, preambles, or follow-up questions unless essential for safety."""

DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_NVIDIA_MODEL = "moonshotai/kimi-k3"


class RateLimitedError(Exception):
    """The model provider rejected the request due to rate limiting."""


class ModelProviderError(Exception):
    """The model provider is unavailable or returned no usable text."""


class ChatService(Protocol):
    async def generate(
        self,
        messages: Sequence[ConversationMessage],
        image_urls: Mapping[UUID, str] | None = None,
    ) -> str: ...


class NvidiaChatService:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def generate(
        self,
        messages: Sequence[ConversationMessage],
        image_urls: Mapping[UUID, str] | None = None,
    ) -> str:
        api_key = os.getenv("NVIDIA_API_KEY")
        if not api_key:
            raise ModelProviderError("NVIDIA_API_KEY is not configured")

        base_url = os.getenv("NVIDIA_BASE_URL", DEFAULT_NVIDIA_BASE_URL).rstrip("/")
        request = {
            "model": os.getenv("NVIDIA_MODEL", DEFAULT_NVIDIA_MODEL),
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                *[_model_message(message, image_urls or {}) for message in messages],
            ],
            "max_tokens": 160,
            "stream": False,
            "temperature": 0.2,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }

        try:
            if self._client is None:
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.post(
                        f"{base_url}/chat/completions", headers=headers, json=request
                    )
            else:
                response = await self._client.post(
                    f"{base_url}/chat/completions", headers=headers, json=request
                )
        except httpx.RequestError as error:
            raise ModelProviderError from error

        if response.status_code == 429:
            raise RateLimitedError
        try:
            response.raise_for_status()
            payload = response.json()
            text = payload["choices"][0]["message"]["content"].strip()
        except (
            AttributeError,
            httpx.HTTPStatusError,
            IndexError,
            KeyError,
            TypeError,
            ValueError,
        ) as error:
            raise ModelProviderError from error

        if not text:
            raise ModelProviderError("NVIDIA returned no text")
        return text


def _model_message(
    message: ConversationMessage, image_urls: Mapping[UUID, str]
) -> dict[str, object]:
    if not message.image_ids:
        return {"role": message.role, "content": message.content}
    content: list[dict[str, object]] = [{"type": "text", "text": message.content}]
    for image_id in message.image_ids:
        try:
            image_url = image_urls[image_id]
        except KeyError as error:
            raise ModelProviderError("An image URL was not resolved") from error
        content.append({"type": "image_url", "image_url": {"url": image_url}})
    return {"role": message.role, "content": content}
