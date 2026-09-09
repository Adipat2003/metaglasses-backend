import tomllib
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_local_supabase_enables_google_and_apple_with_environment_credentials() -> None:
    config_path = ROOT / "supabase" / "config.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))

    assert config["auth"]["additional_redirect_urls"] == ["glance-local://auth/callback"]

    google = config["auth"]["external"]["google"]
    assert google["enabled"] is True
    assert google["client_id"] == "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
    assert google["secret"] == "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"

    apple = config["auth"]["external"]["apple"]
    assert apple["enabled"] is True
    assert apple["client_id"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID)"
    assert apple["secret"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"
    assert apple["redirect_uri"] == "env(SUPABASE_AUTH_EXTERNAL_APPLE_REDIRECT_URI)"


def test_edge_api_uses_explicit_authentication_and_permissive_cors() -> None:
    config = tomllib.loads((ROOT / "supabase" / "config.toml").read_text(encoding="utf-8"))
    source = (ROOT / "supabase" / "functions" / "api" / "index.ts").read_text(
        encoding="utf-8"
    )

    assert config["functions"]["api"]["verify_jwt"] is False
    assert '"Access-Control-Allow-Origin": "*"' in source
    assert 'fetch(`${supabaseUrl()}/auth/v1/user`' in source
    assert 'requiredEnvironment("NVIDIA_API_KEY")' in source
    assert "SUPABASE_SERVICE_ROLE_KEY" in source


def test_edge_api_database_functions_are_service_role_only() -> None:
    migration = (
        ROOT / "supabase" / "migrations" / "20260909032038_add_edge_api_rpcs.sql"
    ).read_text(encoding="utf-8")
    function_names = {
        "edge_api_set_state",
        "edge_api_save_response",
        "edge_api_get_display",
        "edge_api_pairing_access",
        "edge_api_register_image",
        "edge_api_get_images",
        "edge_api_remove_image",
    }

    for function_name in function_names:
        assert f"function public.{function_name}" in migration
        assert f"grant execute on function public.{function_name}" in migration
    assert migration.count("security definer") == len(function_names)
    assert migration.count("from public, anon, authenticated") == len(function_names)


def test_cd_deploys_supabase_trial_automatically_and_production_manually() -> None:
    workflow = (ROOT / ".github" / "workflows" / "cd.yml").read_text(encoding="utf-8")

    assert "uitdzmwfqtsohgffhuom.supabase.co/functions/v1/api" in workflow
    assert "hxtdfghufjjmeltarffl.supabase.co/functions/v1/api" in workflow
    assert "supabase@2.116.0 db push" in workflow
    assert "supabase@2.116.0 functions deploy" in workflow
    assert workflow.count(
        "cp supabase/signing_keys.example.json supabase/signing_keys.json"
    ) == 2
    assert "github.event_name == 'workflow_dispatch'" in workflow
    assert "RENDER_" not in workflow
    assert "build-push-action" not in workflow
