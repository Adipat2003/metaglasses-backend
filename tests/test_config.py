import pytest

from app.config import ConfigurationError, Settings


def test_local_environment_explicitly_allows_auth_bypass() -> None:
    settings = Settings.from_env(
        {"APP_ENV": "local", "AUTH_MODE": "disabled", "CORS_ORIGINS": "*"}
    )

    assert settings.auth_mode == "disabled"
    assert settings.supabase_url is None
    assert settings.database_url is None


@pytest.mark.parametrize("app_env", ["trial", "prod"])
def test_non_local_environments_reject_auth_bypass(app_env: str) -> None:
    with pytest.raises(ConfigurationError, match="only be disabled"):
        Settings.from_env({"APP_ENV": app_env, "AUTH_MODE": "disabled"})


@pytest.mark.parametrize("app_env", ["trial", "prod"])
def test_hosted_environments_reject_wildcard_cors(app_env: str) -> None:
    with pytest.raises(ConfigurationError, match="wildcard"):
        Settings.from_env(
            {
                "APP_ENV": app_env,
                "AUTH_MODE": "required",
                "SUPABASE_URL": f"https://{app_env}.supabase.co",
                "CORS_ORIGINS": "*",
            }
        )


def test_auth_enabled_requires_a_supabase_url() -> None:
    with pytest.raises(ConfigurationError, match="SUPABASE_URL"):
        Settings.from_env(
            {
                "APP_ENV": "local",
                "AUTH_MODE": "required",
                "CORS_ORIGINS": "http://localhost:3000",
            }
        )


def test_environment_must_be_selected_explicitly() -> None:
    with pytest.raises(ConfigurationError, match="APP_ENV"):
        Settings.from_env({})


def test_removed_dev_environment_is_rejected() -> None:
    with pytest.raises(ConfigurationError, match="local, trial, prod"):
        Settings.from_env({"APP_ENV": "dev"})


def test_production_supabase_must_use_https() -> None:
    with pytest.raises(ConfigurationError, match="HTTPS"):
        Settings.from_env(
            {
                "APP_ENV": "prod",
                "AUTH_MODE": "required",
                "SUPABASE_URL": "http://prod.supabase.co",
                "CORS_ORIGINS": "https://glance.example",
            }
        )


@pytest.mark.parametrize(
    "database_url",
    ["mysql://localhost/metaglasses", "postgresql:///metaglasses", "postgresql://db.test"],
)
def test_database_url_requires_postgres_host_and_database(database_url: str) -> None:
    with pytest.raises(ConfigurationError, match="DATABASE_URL"):
        Settings.from_env(
            {
                "APP_ENV": "local",
                "AUTH_MODE": "disabled",
                "CORS_ORIGINS": "*",
                "DATABASE_URL": database_url,
            }
        )


def test_database_url_accepts_postgresql_connection_string() -> None:
    database_url = "postgresql://backend:password@db.example.test:5432/postgres?sslmode=require"

    settings = Settings.from_env(
        {
            "APP_ENV": "local",
            "AUTH_MODE": "disabled",
            "CORS_ORIGINS": "*",
            "DATABASE_URL": database_url,
        }
    )

    assert settings.database_url == database_url


def test_hosted_database_url_requires_ssl() -> None:
    with pytest.raises(ConfigurationError, match="require SSL"):
        Settings.from_env(
            {
                "APP_ENV": "trial",
                "AUTH_MODE": "required",
                "SUPABASE_URL": "https://trial.supabase.co",
                "CORS_ORIGINS": "https://trial.glance.example",
                "DATABASE_URL": "postgresql://backend:test-password@db.example.test/postgres",
            }
        )
