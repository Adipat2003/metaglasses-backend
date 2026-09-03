import os
from collections.abc import Sequence
from hashlib import sha256
from typing import Protocol

import openai

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


class OpenAIChatService:
    def __init__(self) -> None:
        self._client: openai.AsyncOpenAI | None = None

    async def generate(
        self, messages: Sequence[ConversationMessage], pairing_token: str
    ) -> str:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ModelProviderError("OPENAI_API_KEY is not configured")

        if self._client is None:
            self._client = openai.AsyncOpenAI(api_key=api_key)

        try:
            response = await self._client.responses.create(
                model=os.getenv("OPENAI_MODEL", "gpt-5.6-sol"),
                instructions=SYSTEM_PROMPT,
                input=[message.model_dump() for message in messages],
                max_output_tokens=160,
                reasoning={"effort": "low"},
                prompt_cache_key="metaglasses-v1",
                safety_identifier=sha256(pairing_token.encode("utf-8")).hexdigest(),
                store=False,
            )
        except openai.RateLimitError as error:
            raise RateLimitedError from error
        except openai.APIError as error:
            raise ModelProviderError from error

        text = response.output_text.strip()
        if not text:
            raise ModelProviderError("OpenAI returned no text")
        return text
