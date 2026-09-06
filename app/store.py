import asyncio
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Protocol
from uuid import uuid4

from psycopg_pool import AsyncConnectionPool

from app.models import DisplayResponse, PairingState


@dataclass
class PairingRecord:
    owner_id: str
    state: PairingState
    last_phone_activity: datetime
    response_id: str | None = None
    text: str | None = None
    created_at: datetime | None = None


class PairingOwnershipError(Exception):
    """A pairing token is already owned by another authenticated user."""


class PairingStoreProtocol(Protocol):
    async def set_state(self, token: str, state: PairingState, owner_id: str) -> None: ...

    async def save_response(
        self, token: str, text: str, owner_id: str
    ) -> DisplayResponse: ...

    async def get_display(self, token: str) -> DisplayResponse | None: ...


class PairingStore:
    """Ephemeral, process-local pairing state for the v0.1 deployment."""

    def __init__(self, ttl_seconds: int | None = None) -> None:
        configured_ttl = ttl_seconds or int(os.getenv("PAIRING_TTL_SECONDS", "3600"))
        self._ttl = timedelta(seconds=configured_ttl)
        self._records: dict[str, PairingRecord] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    def _purge_expired(self, now: datetime) -> None:
        expired = [
            token
            for token, record in self._records.items()
            if now - record.last_phone_activity >= self._ttl
        ]
        for token in expired:
            del self._records[token]

    async def set_state(self, token: str, state: PairingState, owner_id: str) -> None:
        """Create or update a pairing record from a phone request."""
        async with self._lock:
            now = self._now()
            self._purge_expired(now)
            record = self._records.get(token)
            if record is None:
                self._records[token] = PairingRecord(
                    owner_id=owner_id,
                    state=state,
                    last_phone_activity=now,
                )
                return
            if record.owner_id != owner_id:
                raise PairingOwnershipError
            record.state = state
            record.last_phone_activity = now

    async def save_response(self, token: str, text: str, owner_id: str) -> DisplayResponse:
        async with self._lock:
            now = self._now()
            self._purge_expired(now)
            record = self._records.get(token)
            if record is None:
                record = PairingRecord(
                    owner_id=owner_id,
                    state="speaking",
                    last_phone_activity=now,
                )
                self._records[token] = record
            elif record.owner_id != owner_id:
                raise PairingOwnershipError

            record.state = "speaking"
            record.last_phone_activity = now
            record.response_id = f"r_{uuid4().hex}"
            record.text = text
            record.created_at = now
            return self._display_response(record)

    async def get_display(self, token: str) -> DisplayResponse | None:
        async with self._lock:
            now = self._now()
            self._purge_expired(now)
            record = self._records.get(token)
            if record is None:
                return None
            return self._display_response(record)

    @staticmethod
    def _display_response(record: PairingRecord) -> DisplayResponse:
        return DisplayResponse(
            responseId=record.response_id,
            text=record.text,
            state=record.state,
            createdAt=record.created_at,
        )


class PostgresPairingStore:
    """Shared pairing state backed by the private Supabase Postgres schema."""

    def __init__(self, database_url: str, ttl_seconds: int | None = None) -> None:
        configured_ttl = ttl_seconds or int(os.getenv("PAIRING_TTL_SECONDS", "3600"))
        self._ttl_seconds = configured_ttl
        self._pool = AsyncConnectionPool(
            conninfo=database_url,
            min_size=1,
            max_size=5,
            open=False,
            kwargs={"autocommit": True},
        )

    async def open(self) -> None:
        await self._pool.open(wait=True)

    async def close(self) -> None:
        await self._pool.close()

    @staticmethod
    def _token_hash(token: str) -> bytes:
        return sha256(token.encode("utf-8")).digest()

    async def set_state(self, token: str, state: PairingState, owner_id: str) -> None:
        query = """
            insert into app_private.pairings (
                token_hash, owner_id, state, last_phone_activity, expires_at
            )
            values (%s, %s::uuid, %s, statement_timestamp(),
                    statement_timestamp() + make_interval(secs => %s))
            on conflict (token_hash) do update
            set owner_id = excluded.owner_id,
                state = excluded.state,
                last_phone_activity = excluded.last_phone_activity,
                expires_at = excluded.expires_at,
                response_id = case
                    when pairings.expires_at <= statement_timestamp() then null
                    else pairings.response_id
                end,
                response_text = case
                    when pairings.expires_at <= statement_timestamp() then null
                    else pairings.response_text
                end,
                response_created_at = case
                    when pairings.expires_at <= statement_timestamp() then null
                    else pairings.response_created_at
                end
            where pairings.owner_id = excluded.owner_id
               or pairings.expires_at <= statement_timestamp()
            returning token_hash
        """
        async with self._pool.connection() as connection:
            async with connection.cursor() as cursor:
                await cursor.execute(
                    query,
                    (self._token_hash(token), owner_id, state, self._ttl_seconds),
                )
                if await cursor.fetchone() is None:
                    raise PairingOwnershipError

    async def save_response(self, token: str, text: str, owner_id: str) -> DisplayResponse:
        response_id = f"r_{uuid4().hex}"
        query = """
            insert into app_private.pairings (
                token_hash, owner_id, state, last_phone_activity, expires_at,
                response_id, response_text, response_created_at
            )
            values (%s, %s::uuid, 'speaking', statement_timestamp(),
                    statement_timestamp() + make_interval(secs => %s),
                    %s, %s, statement_timestamp())
            on conflict (token_hash) do update
            set owner_id = excluded.owner_id,
                state = excluded.state,
                last_phone_activity = excluded.last_phone_activity,
                expires_at = excluded.expires_at,
                response_id = excluded.response_id,
                response_text = excluded.response_text,
                response_created_at = excluded.response_created_at
            where pairings.owner_id = excluded.owner_id
               or pairings.expires_at <= statement_timestamp()
            returning response_id, response_text, state, response_created_at
        """
        async with self._pool.connection() as connection:
            async with connection.cursor() as cursor:
                await cursor.execute(
                    query,
                    (
                        self._token_hash(token),
                        owner_id,
                        self._ttl_seconds,
                        response_id,
                        text,
                    ),
                )
                row = await cursor.fetchone()
        if row is None:
            raise PairingOwnershipError
        return DisplayResponse(
            responseId=row[0],
            text=row[1],
            state=row[2],
            createdAt=row[3],
        )

    async def get_display(self, token: str) -> DisplayResponse | None:
        query = """
            select response_id, response_text, state, response_created_at
            from app_private.pairings
            where token_hash = %s and expires_at > statement_timestamp()
        """
        async with self._pool.connection() as connection:
            async with connection.cursor() as cursor:
                await cursor.execute(query, (self._token_hash(token),))
                row = await cursor.fetchone()
        if row is None:
            return None
        return DisplayResponse(
            responseId=row[0],
            text=row[1],
            state=row[2],
            createdAt=row[3],
        )
