from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Protocol

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError, PyJWKClient, PyJWKClientError

from app.config import Settings


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    email: str | None = None


class AccessTokenError(Exception):
    """The supplied access token could not be trusted."""


class TokenVerifier(Protocol):
    def verify(self, token: str) -> AuthenticatedUser: ...


class SupabaseTokenVerifier:
    """Verify Supabase access tokens locally with the project's public JWKS."""

    def __init__(self, settings: Settings) -> None:
        if not settings.supabase_url:
            raise ValueError("Supabase URL is required to construct a token verifier")
        self._issuer = f"{settings.supabase_url}/auth/v1"
        self._audience = settings.supabase_jwt_audience
        self._jwks = PyJWKClient(
            f"{self._issuer}/.well-known/jwks.json",
            cache_keys=True,
            lifespan=600,
        )

    def verify(self, token: str) -> AuthenticatedUser:
        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iat", "sub"]},
            )
        except (InvalidTokenError, PyJWKClientError, ValueError) as error:
            raise AccessTokenError from error

        subject = claims.get("sub")
        role = claims.get("role")
        if not isinstance(subject, str) or not subject or role != "authenticated":
            raise AccessTokenError

        email = claims.get("email")
        return AuthenticatedUser(
            id=subject,
            email=email if isinstance(email, str) else None,
        )


def build_current_user_dependency(
    settings: Settings,
    token_verifier: TokenVerifier | None = None,
) -> Callable[..., AuthenticatedUser]:
    bearer = HTTPBearer(
        auto_error=False,
        scheme_name="SupabaseBearer",
        description=(
            "Supabase access token issued to the signed-in phone user. "
            "Use the token value without adding another Bearer prefix."
        ),
    )
    verifier = token_verifier
    if settings.auth_mode == "required" and verifier is None:
        verifier = SupabaseTokenVerifier(settings)

    def current_user(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> AuthenticatedUser:
        if settings.auth_mode == "disabled":
            return AuthenticatedUser(id="local-test-user", email="local@example.test")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise _unauthorized()

        try:
            if verifier is None:
                raise AccessTokenError
            return verifier.verify(credentials.credentials)
        except AccessTokenError as error:
            raise _unauthorized() from error

    return current_user


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing or invalid access token.",
        headers={"WWW-Authenticate": "Bearer"},
    )
