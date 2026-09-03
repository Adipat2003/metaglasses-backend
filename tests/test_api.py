import asyncio
from collections.abc import Sequence
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import MAX_TRANSCRIPT_BYTES, create_app
from app.models import ConversationMessage
from app.service import ModelProviderError, OpenAIChatService, RateLimitedError

TOKEN = "a3f9d1e2c3b4a5f60718293a4b5c6d7e"


class FakeChatService:
    def __init__(self, result: str = "Pry the tire off the rim with your levers.") -> None:
        self.result = result
        self.messages: list[ConversationMessage] | None = None

    async def generate(self, messages: Sequence[ConversationMessage], pairing_token: str) -> str:
        self.messages = list(messages)
        return self.result


class FailingChatService:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def generate(self, messages: Sequence[ConversationMessage], pairing_token: str) -> str:
        raise self.error


class FakeResponsesClient:
    def __init__(self) -> None:
        self.request: dict[str, object] | None = None

    async def create(self, **kwargs: object) -> SimpleNamespace:
        self.request = kwargs
        return SimpleNamespace(output_text="Use your tire levers to lift the bead off the rim.")


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.responses = FakeResponsesClient()


def test_unknown_display_token_requires_repair() -> None:
    client = TestClient(create_app(FakeChatService()))

    response = client.get(f"/v1/display?token={TOKEN}")

    assert response.status_code == 401


def test_phone_state_registers_pairing_and_updates_display() -> None:
    client = TestClient(create_app(FakeChatService()))

    response = client.post("/v1/state", json={"pairingToken": TOKEN, "state": "listening"})
    display = client.get(f"/v1/display?token={TOKEN}")

    assert response.status_code == 204
    assert display.status_code == 200
    assert display.json() == {
        "responseId": None,
        "text": None,
        "state": "listening",
        "createdAt": None,
    }


def test_chat_returns_and_caches_the_same_text_for_the_lens() -> None:
    service = FakeChatService()
    client = TestClient(create_app(service))
    payload = {
        "pairingToken": TOKEN,
        "messages": [{"role": "user", "content": "how do I change a bike tire"}],
    }

    chat = client.post("/v1/chat", json=payload)
    display = client.get(f"/v1/display?token={TOKEN}")

    assert chat.status_code == 200
    assert chat.json()["text"] == "Pry the tire off the rim with your levers."
    assert chat.json()["responseId"].startswith("r_")
    assert display.status_code == 200
    assert display.json()["text"] == chat.json()["text"]
    assert display.json()["responseId"] == chat.json()["responseId"]
    assert display.json()["state"] == "speaking"
    expected_messages = [
        ConversationMessage(role="user", content="how do I change a bike tire")
    ]
    assert service.messages == expected_messages


def test_large_transcript_is_rejected_with_413() -> None:
    client = TestClient(create_app(FakeChatService()))
    payload = {
        "pairingToken": TOKEN,
        "messages": [{"role": "user", "content": "x" * (MAX_TRANSCRIPT_BYTES + 1)}],
    }

    response = client.post("/v1/chat", json=payload)

    assert response.status_code == 413


def test_rate_limit_and_provider_errors_are_mapped_to_contract_statuses() -> None:
    rate_limited = TestClient(create_app(FailingChatService(RateLimitedError())))
    unavailable = TestClient(create_app(FailingChatService(ModelProviderError())))
    payload = {
        "pairingToken": TOKEN,
        "messages": [{"role": "user", "content": "help"}],
    }

    assert rate_limited.post("/v1/chat", json=payload).status_code == 429
    assert unavailable.post("/v1/chat", json=payload).status_code == 503


def test_openai_service_uses_sol_with_ephemeral_response_storage(monkeypatch) -> None:
    client = FakeOpenAIClient()
    service = OpenAIChatService()
    service._client = client
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    text = asyncio.run(
        service.generate([ConversationMessage(role="user", content="help")], TOKEN)
    )

    assert text == "Use your tire levers to lift the bead off the rim."
    assert client.responses.request is not None
    assert client.responses.request["model"] == "gpt-5.6-sol"
    assert client.responses.request["reasoning"] == {"effort": "low"}
    assert client.responses.request["store"] is False
