import asyncio
import json
from collections.abc import Sequence

import httpx
from fastapi.testclient import TestClient

from app.auth import AccessTokenError, AuthenticatedUser
from app.config import Settings
from app.main import MAX_TRANSCRIPT_BYTES, create_app
from app.models import ConversationMessage
from app.service import ModelProviderError, NvidiaChatService, RateLimitedError

TOKEN = "a3f9d1e2c3b4a5f60718293a4b5c6d7e"


class FakeChatService:
    def __init__(self, result: str = "Pry the tire off the rim with your levers.") -> None:
        self.result = result
        self.messages: list[ConversationMessage] | None = None

    async def generate(self, messages: Sequence[ConversationMessage]) -> str:
        self.messages = list(messages)
        return self.result


class FailingChatService:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def generate(self, messages: Sequence[ConversationMessage]) -> str:
        raise self.error


class FakeTokenVerifier:
    def verify(self, token: str) -> AuthenticatedUser:
        users = {
            "alice-token": AuthenticatedUser(id="alice", email="alice@example.test"),
            "bob-token": AuthenticatedUser(id="bob", email="bob@example.test"),
        }
        try:
            return users[token]
        except KeyError as error:
            raise AccessTokenError from error


def protected_settings() -> Settings:
    return Settings(
        app_env="trial",
        auth_mode="required",
        supabase_url="https://trial-project.supabase.co",
        supabase_jwt_issuer=None,
        supabase_jwt_audience="authenticated",
        cors_origins=("https://trial.glance.example",),
    )


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


def test_hosted_environment_requires_a_valid_bearer_token() -> None:
    client = TestClient(
        create_app(FakeChatService(), protected_settings(), FakeTokenVerifier())
    )
    payload = {"pairingToken": TOKEN, "state": "listening"}

    missing = client.post("/v1/state", json=payload)
    invalid = client.post(
        "/v1/state",
        json=payload,
        headers={"Authorization": "Bearer invalid-token"},
    )
    valid = client.post(
        "/v1/state",
        json=payload,
        headers={"Authorization": "Bearer alice-token"},
    )

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert invalid.status_code == 401
    assert valid.status_code == 204


def test_openapi_marks_phone_routes_as_bearer_protected() -> None:
    client = TestClient(
        create_app(FakeChatService(), protected_settings(), FakeTokenVerifier())
    )

    document = client.get("/openapi.json").json()

    assert document["paths"]["/v1/chat"]["post"]["security"] == [{"SupabaseBearer": []}]
    assert document["paths"]["/v1/state"]["post"]["security"] == [{"SupabaseBearer": []}]
    assert "security" not in document["paths"]["/v1/display"]["get"]


def test_openapi_categorizes_and_describes_every_endpoint() -> None:
    client = TestClient(create_app(FakeChatService()))

    document = client.get("/openapi.json").json()

    assert [tag["name"] for tag in document["tags"]] == ["System", "Phone", "Lens"]
    assert set(document["paths"]) == {"/healthz", "/v1/chat", "/v1/display", "/v1/state"}
    expected_operations = {
        ("/healthz", "get"): ("System", "getHealth"),
        ("/v1/chat", "post"): ("Phone", "createChatResponse"),
        ("/v1/display", "get"): ("Lens", "getDisplay"),
        ("/v1/state", "post"): ("Phone", "updatePairingState"),
    }
    for (path, method), (tag, operation_id) in expected_operations.items():
        operation = document["paths"][path][method]
        assert operation["tags"] == [tag]
        assert operation["operationId"] == operation_id
        assert operation["summary"]
        assert operation["description"]

    security_scheme = document["components"]["securitySchemes"]["SupabaseBearer"]
    assert security_scheme["scheme"] == "bearer"
    assert "Supabase access token" in security_scheme["description"]


def test_pairing_tokens_cannot_be_claimed_by_another_user() -> None:
    client = TestClient(
        create_app(FakeChatService(), protected_settings(), FakeTokenVerifier())
    )
    payload = {"pairingToken": TOKEN, "state": "listening"}

    first = client.post(
        "/v1/state",
        json=payload,
        headers={"Authorization": "Bearer alice-token"},
    )
    second = client.post(
        "/v1/state",
        json=payload,
        headers={"Authorization": "Bearer bob-token"},
    )

    assert first.status_code == 204
    assert second.status_code == 403


def test_health_reports_local_auth_bypass() -> None:
    client = TestClient(create_app(FakeChatService()))

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "environment": "local",
        "auth": "disabled",
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


def test_nvidia_service_uses_kimi_chat_completions(monkeypatch) -> None:
    captured_request: httpx.Request | None = None

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal captured_request
        captured_request = request
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "Use your tire levers to lift the bead."}}
                ]
            },
        )

    async def invoke() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = NvidiaChatService(client)
            return await service.generate(
                [ConversationMessage(role="user", content="help")]
            )

    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    text = asyncio.run(invoke())

    assert text == "Use your tire levers to lift the bead."
    assert captured_request is not None
    assert captured_request.url == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert captured_request.headers["authorization"] == "Bearer test-key"
    payload = json.loads(captured_request.content)
    assert payload["model"] == "moonshotai/kimi-k3"
    assert payload["messages"][-1] == {"role": "user", "content": "help"}
    assert payload["stream"] is False
