import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, urlparse

AppEnvironment = Literal["local", "trial", "prod"]
AuthMode = Literal["disabled", "required"]


class ConfigurationError(RuntimeError):
    """The application environment is missing or unsafe."""


@dataclass(frozen=True)
class Settings:
    app_env: AppEnvironment
    auth_mode: AuthMode
    supabase_url: str | None
    supabase_jwt_issuer: str | None
    supabase_jwt_audience: str
    cors_origins: tuple[str, ...]
    database_url: str | None = None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        values = os.environ if environ is None else environ
        app_env = values.get("APP_ENV")
        if app_env not in {"local", "trial", "prod"}:
            raise ConfigurationError("APP_ENV must be one of: local, trial, prod")

        auth_mode = values.get("AUTH_MODE", "required")
        if auth_mode not in {"disabled", "required"}:
            raise ConfigurationError("AUTH_MODE must be either disabled or required")
        if auth_mode == "disabled" and app_env != "local":
            raise ConfigurationError("Authentication can only be disabled when APP_ENV=local")

        supabase_url = values.get("SUPABASE_URL", "").strip().rstrip("/") or None
        if auth_mode == "required" and not supabase_url:
            raise ConfigurationError("SUPABASE_URL is required when authentication is enabled")
        if supabase_url:
            parsed_url = urlparse(supabase_url)
            if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
                raise ConfigurationError("SUPABASE_URL must be an absolute HTTP(S) URL")
            if app_env in {"trial", "prod"} and parsed_url.scheme != "https":
                raise ConfigurationError("Hosted environments require an HTTPS SUPABASE_URL")

        supabase_jwt_issuer = values.get("SUPABASE_JWT_ISSUER", "").strip().rstrip("/") or None
        if supabase_jwt_issuer:
            parsed_issuer = urlparse(supabase_jwt_issuer)
            if parsed_issuer.scheme not in {"http", "https"} or not parsed_issuer.netloc:
                raise ConfigurationError("SUPABASE_JWT_ISSUER must be an absolute HTTP(S) URL")
            if app_env in {"trial", "prod"} and parsed_issuer.scheme != "https":
                raise ConfigurationError("Hosted environments require an HTTPS SUPABASE_JWT_ISSUER")

        origins = tuple(
            origin.strip()
            for origin in values.get("CORS_ORIGINS", "*").split(",")
            if origin.strip()
        )
        if not origins:
            raise ConfigurationError("CORS_ORIGINS must contain at least one origin")
        if app_env in {"trial", "prod"} and "*" in origins:
            raise ConfigurationError("Hosted environments cannot use a wildcard CORS origin")

        database_url = values.get("DATABASE_URL", "").strip() or None
        if database_url:
            parsed_database_url = urlparse(database_url)
            if parsed_database_url.scheme not in {"postgres", "postgresql"}:
                raise ConfigurationError("DATABASE_URL must use the postgres or postgresql scheme")
            if not parsed_database_url.hostname or not parsed_database_url.path.lstrip("/"):
                raise ConfigurationError("DATABASE_URL must include a host and database name")
            ssl_mode = parse_qs(parsed_database_url.query).get("sslmode", [None])[0]
            if app_env in {"trial", "prod"} and ssl_mode not in {
                "require",
                "verify-ca",
                "verify-full",
            }:
                raise ConfigurationError("Hosted DATABASE_URL must require SSL")

        return cls(
            app_env=app_env,
            auth_mode=auth_mode,
            supabase_url=supabase_url,
            supabase_jwt_issuer=supabase_jwt_issuer,
            supabase_jwt_audience=values.get("SUPABASE_JWT_AUDIENCE", "authenticated"),
            cors_origins=origins,
            database_url=database_url,
        )
