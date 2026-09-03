import asyncio
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

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
