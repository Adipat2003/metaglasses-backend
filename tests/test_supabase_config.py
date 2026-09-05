import tomllib
from pathlib import Path


def test_local_supabase_enables_google_and_apple_with_environment_credentials() -> None:
    config_path = Path(__file__).parents[1] / "supabase" / "config.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))

    google = config["auth"]["external"]["google"]
    assert google["enabled"] is True
    assert google["client_id"] == "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
    assert google["secret"] == "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"

    apple = config["auth"]["external"]["apple"]
    assert apple["enabled"] is True
    assert apple["client_id"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID)"
    assert apple["secret"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"
    assert apple["redirect_uri"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_REDIRECT_URI)"
