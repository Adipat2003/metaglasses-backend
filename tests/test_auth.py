from app.auth import SupabaseTokenVerifier
from app.config import Settings


def test_containerized_auth_uses_gateway_for_jwks_and_host_issuer_for_tokens() -> None:
    settings = Settings.from_env(
        {
            "APP_ENV": "local",
            "AUTH_MODE": "required",
            "SUPABASE_URL": "http://host.docker.internal:54321",
            "SUPABASE_JWT_ISSUER": "http://127.0.0.1:54321/auth/v1",
            "CORS_ORIGINS": "http://localhost:3000",
        }
    )

    verifier = SupabaseTokenVerifier(settings)

    assert verifier._issuer == "http://127.0.0.1:54321/auth/v1"
    assert verifier._jwks.uri == (
        "http://host.docker.internal:54321/auth/v1/.well-known/jwks.json"
    )
