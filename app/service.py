import os
from collections.abc import Sequence
from typing import Protocol

import httpx

from app.models import ConversationMessage

SYSTEM_PROMPT = """You are the MetaGlasses step-by-step voice assistant.
Answer the user's latest request with exactly one practical next step in one short,
plain-text sentence. Keep the answer concise enough to fit on a small wearable lens.
Do not use markdown, preambles, or follow-up questions unless essential for safety."""


class RateLimitedError(Exception):
    """The model provider rejected the request due to rate limiting."""


class ModelProviderError(Exception):
    """The model provider is unavailable or returned no usable text."""


class ChatService(Protocol):
    async def generate(
        self, messages: Sequence[ConversationMessage], pairing_token: str
    ) -> str: ...


class NvidiaChatService:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def generate(
        self, messages: Sequence[ConversationMessage], pairing_token: str
    ) -> str:
        api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not api_key:
            raise ModelProviderError("NVIDIA_API_KEY is not configured")

        payload = {
            "model": os.getenv("NVIDIA_MODEL", "moonshotai/kimi-k3"),
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                *[message.model_dump() for message in messages],
            ],
            "max_tokens": 160,
            "temperature": 1,
            "stream": False,
            "reasoning_effort": "max",
        }
        client = self._client or httpx.AsyncClient(timeout=60)
        try:
            response = await client.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                },
                json=payload,
            )
            if response.status_code == 429:
                raise RateLimitedError
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise ModelProviderError from error
        finally:
            if self._client is None:
                await client.aclose()

        try:
            text = response.json()["choices"][0]["message"]["content"].strip()
        except (AttributeError, IndexError, KeyError, TypeError, ValueError) as error:
            raise ModelProviderError("NVIDIA returned an invalid response") from error
        if not text:
            raise ModelProviderError("NVIDIA returned no text")
        return text
