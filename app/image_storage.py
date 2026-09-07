from typing import Protocol
from urllib.parse import quote

import httpx


class ImageStorageError(Exception):
    """Supabase Storage could not complete an image operation."""


class ImageStorageProtocol(Protocol):
    async def upload(
        self,
        object_path: str,
        content: bytes,
        content_type: str,
        access_token: str | None,
    ) -> None: ...

    async def signed_url(
        self,
        object_path: str,
        expires_in: int,
        access_token: str | None,
    ) -> str: ...

    async def delete(self, object_path: str, access_token: str | None) -> None: ...


class UnavailableImageStorage:
    """Reject image operations until Supabase Storage is configured."""

    async def upload(
        self,
        object_path: str,
        content: bytes,
        content_type: str,
        access_token: str | None,
    ) -> None:
        raise ImageStorageError("Supabase Storage is not configured")

    async def signed_url(
        self,
        object_path: str,
        expires_in: int,
        access_token: str | None,
    ) -> str:
        raise ImageStorageError("Supabase Storage is not configured")

    async def delete(self, object_path: str, access_token: str | None) -> None:
        raise ImageStorageError("Supabase Storage is not configured")


class SupabaseImageStorage:
    """Use a phone user's JWT for private Supabase Storage operations."""

    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        bucket: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._storage_url = f"{supabase_url.rstrip('/')}/storage/v1"
        self._publishable_key = publishable_key
        self._bucket = bucket
        self._client = client

    def _headers(self, access_token: str | None) -> dict[str, str]:
        if not access_token:
            raise ImageStorageError("An authenticated Supabase session is required")
        return {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {access_token}",
        }

    def _object_path(self, object_path: str) -> str:
        return f"{quote(self._bucket, safe='')}/{quote(object_path, safe='/')}"

    async def _request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        try:
            if self._client is not None:
                response = await self._client.request(method, url, **kwargs)
            else:
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.request(method, url, **kwargs)
            response.raise_for_status()
            return response
        except (httpx.HTTPError, ValueError) as error:
            raise ImageStorageError from error

    async def upload(
        self,
        object_path: str,
        content: bytes,
        content_type: str,
        access_token: str | None,
    ) -> None:
        headers = {
            **self._headers(access_token),
            "Content-Type": content_type,
            "Cache-Control": "max-age=0",
            "x-upsert": "false",
        }
        await self._request(
            "POST",
            f"{self._storage_url}/object/{self._object_path(object_path)}",
            headers=headers,
            content=content,
        )

    async def signed_url(
        self,
        object_path: str,
        expires_in: int,
        access_token: str | None,
    ) -> str:
        response = await self._request(
            "POST",
            f"{self._storage_url}/object/sign/{self._object_path(object_path)}",
            headers=self._headers(access_token),
            json={"expiresIn": expires_in},
        )
        try:
            signed_path = response.json()["signedURL"]
        except (KeyError, TypeError, ValueError) as error:
            raise ImageStorageError from error
        if not isinstance(signed_path, str) or not signed_path:
            raise ImageStorageError("Supabase Storage returned no signed URL")
        if signed_path.startswith("http://") or signed_path.startswith("https://"):
            return signed_path
        return f"{self._storage_url}{signed_path}"

    async def delete(self, object_path: str, access_token: str | None) -> None:
        await self._request(
            "DELETE",
            f"{self._storage_url}/object/{quote(self._bucket, safe='')}",
            headers=self._headers(access_token),
            json={"prefixes": [object_path]},
        )
