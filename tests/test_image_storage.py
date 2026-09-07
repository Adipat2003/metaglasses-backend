import asyncio
import json

import httpx

from app.image_storage import SupabaseImageStorage


def test_supabase_storage_uses_user_session_for_upload_sign_and_delete() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if "/object/sign/" in str(request.url):
            return httpx.Response(
                200,
                json={"signedURL": "/object/sign/Images/user/image.png?token=signed"},
            )
        return httpx.Response(200, json={})

    async def invoke() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            storage = SupabaseImageStorage(
                "https://trial.supabase.co", "publishable-key", "Images", client
            )
            await storage.upload("user/image.png", b"png", "image/png", "user-token")
            signed_url = await storage.signed_url("user/image.png", 60, "user-token")
            await storage.delete("user/image.png", "user-token")
            return signed_url

    signed_url = asyncio.run(invoke())

    assert signed_url == (
        "https://trial.supabase.co/storage/v1/object/sign/Images/user/image.png?token=signed"
    )
    assert [request.method for request in requests] == ["POST", "POST", "DELETE"]
    assert all(request.headers["authorization"] == "Bearer user-token" for request in requests)
    assert all(request.headers["apikey"] == "publishable-key" for request in requests)
    assert requests[0].headers["content-type"] == "image/png"
    assert json.loads(requests[1].content) == {"expiresIn": 60}
    assert json.loads(requests[2].content) == {"prefixes": ["user/image.png"]}
