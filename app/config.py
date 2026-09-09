import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, urlparse

AppEnvironment = Literal["local", "trial", "prod"]
AuthMode = Literal["disabled", "required"]
HOSTED_SUPABASE_URLS = {
    "trial": "https://uitdzmwfqtsohgffhuom.supabase.co",
    "prod": "https://hxtdfghufjjmeltarffl.supabase.co",
}
HOSTED_IMAGE_BUCKETS = {"trial": "Images", "prod": "images"}


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
    supabase_publishable_key: str | None = None
    pairing_image_bucket: str = "Images"
    pairing_ttl_seconds: int = 3600
    max_images_per_pairing: int = 10
    max_image_bytes: int = 8 * 1024 * 1024
    image_signed_url_ttl_seconds: int = 60

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
        parsed_database_url = None
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

        supabase_publishable_key = (
            values.get("SUPABASE_PUBLISHABLE_KEY", "").strip() or None
        )

        if app_env in {"trial", "prod"}:
            missing_hosted_values = [
                name
                for name, configured in (
                    ("DATABASE_URL", database_url),
                    ("NVIDIA_API_KEY", values.get("NVIDIA_API_KEY", "").strip()),
                    ("SUPABASE_PUBLISHABLE_KEY", supabase_publishable_key),
                )
                if not configured
            ]
            if missing_hosted_values:
                raise ConfigurationError(
                    "Hosted environments require: " + ", ".join(missing_hosted_values)
                )
            expected_supabase_url = HOSTED_SUPABASE_URLS[app_env]
            if supabase_url != expected_supabase_url:
                raise ConfigurationError(
                    f"SUPABASE_URL must be {expected_supabase_url} when APP_ENV={app_env}"
                )
            if not supabase_publishable_key.startswith("sb_publishable_"):
                raise ConfigurationError(
                    "Hosted SUPABASE_PUBLISHABLE_KEY must use an active publishable key"
                )
            project_ref = expected_supabase_url.removeprefix("https://").removesuffix(
                ".supabase.co"
            )
            database_identity = (
                f"{parsed_database_url.username}@{parsed_database_url.hostname}"
            )
            if project_ref not in database_identity:
                raise ConfigurationError(
                    f"DATABASE_URL must point to the {app_env} Supabase project"
                )

        pairing_image_bucket = values.get("PAIRING_IMAGE_BUCKET", "Images").strip()
        if not pairing_image_bucket:
            raise ConfigurationError("PAIRING_IMAGE_BUCKET must not be blank")
        if (
            app_env in {"trial", "prod"}
            and pairing_image_bucket != HOSTED_IMAGE_BUCKETS[app_env]
        ):
            raise ConfigurationError(
                f"PAIRING_IMAGE_BUCKET must be {HOSTED_IMAGE_BUCKETS[app_env]} "
                f"when APP_ENV={app_env}"
            )

        pairing_ttl_seconds = _positive_int(values, "PAIRING_TTL_SECONDS", 3600)
        max_images_per_pairing = _positive_int(values, "MAX_IMAGES_PER_PAIRING", 10)
        max_image_bytes = _positive_int(values, "MAX_IMAGE_BYTES", 8 * 1024 * 1024)
        image_signed_url_ttl_seconds = _positive_int(
            values, "IMAGE_SIGNED_URL_TTL_SECONDS", 60
        )

        return cls(
            app_env=app_env,
            auth_mode=auth_mode,
            supabase_url=supabase_url,
            supabase_jwt_issuer=supabase_jwt_issuer,
            supabase_jwt_audience=values.get("SUPABASE_JWT_AUDIENCE", "authenticated"),
            cors_origins=origins,
            database_url=database_url,
            supabase_publishable_key=supabase_publishable_key,
            pairing_image_bucket=pairing_image_bucket,
            pairing_ttl_seconds=pairing_ttl_seconds,
            max_images_per_pairing=max_images_per_pairing,
            max_image_bytes=max_image_bytes,
            image_signed_url_ttl_seconds=image_signed_url_ttl_seconds,
        )


def _positive_int(values: Mapping[str, str], name: str, default: int) -> int:
    try:
        value = int(values.get(name, str(default)))
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise ConfigurationError(f"{name} must be a positive integer")
    return value
