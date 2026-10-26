import tomllib
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_environment_templates_are_centralized() -> None:
    template_directory = ROOT / "config" / "env"
    assert sorted(path.name for path in template_directory.glob("*.env.example")) == [
        "edge-functions.env.example",
        "oauth.env.example",
        "python-authenticated.env.example",
        "python-docker.env.example",
        "python-local.env.example",
    ]
    assert not list(ROOT.glob(".env*.example"))
    assert not (ROOT / "supabase" / "functions" / ".env.example").exists()
    assert not (ROOT / "supabase" / "oauth.env.example").exists()


def test_aws_runtime_template_has_one_pairing_image_bucket() -> None:
    template = (ROOT / "config" / "env" / "edge-functions.env.example").read_text(
        encoding="utf-8"
    )

    assert template.count("PAIRING_IMAGE_BUCKET=") == 1


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


def test_api_uses_cognito_authentication_and_permissive_cors() -> None:
    config = tomllib.loads((ROOT / "supabase" / "config.toml").read_text(encoding="utf-8"))
    source = (ROOT / "supabase" / "functions" / "api" / "index.ts").read_text(
        encoding="utf-8"
    )

    assert config["functions"]["api"]["verify_jwt"] is False
    assert '"Access-Control-Allow-Origin": "*"' in source
    assert 'CognitoJwtVerifier.create' in source
    assert 'tokenUse: "access"' in source
    assert 'NVIDIA_SECRET_ARN' in source
    assert "SUPABASE_SERVICE_ROLE_KEY" not in source
    assert 'role: "system"' not in source
    assert "systemPrompt" not in source
    assert "/v1/video-stream" not in source
    assert "upgradeWebSocket" not in source


def test_edge_api_supports_stateless_byok_without_system_injection() -> None:
    api_directory = ROOT / "supabase" / "functions" / "api"
    source = (api_directory / "index.ts").read_text(encoding="utf-8")
    providers = (api_directory / "providers.ts").read_text(encoding="utf-8")

    assert 'from "./providers.ts"' in source
    assert "parseExternalProvider(payload.provider)" in source
    assert 'role: "system"' not in providers
    assert "systemPrompt" not in providers
    assert "insert(" not in providers
    assert "upsert(" not in providers
    request_log_source = source[
        source.index("function requestLog") : source.index("function responseWithRequestId")
    ]
    assert "apiKey" not in request_log_source


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


def test_hosted_edge_api_does_not_limit_images_per_pairing() -> None:
    source = (ROOT / "supabase" / "functions" / "api" / "index.ts").read_text(
        encoding="utf-8"
    )
    migration = (
        ROOT
        / "supabase"
        / "migrations"
        / "20260929030609_remove_pairing_image_limit.sql"
    ).read_text(encoding="utf-8")

    assert "maxImagesPerPairing" not in source
    assert "p_max_images: null" in source
    assert "active_image_count" not in migration
    assert "return 'registered';" in migration


def test_cd_deploys_to_ec2_through_oidc_and_ssm() -> None:
    workflow = (ROOT / ".github" / "workflows" / "aws-deploy.yml").read_text(
        encoding="utf-8"
    )

    assert "id-token: write" in workflow
    assert "configure-aws-credentials" in workflow
    assert "METAGLASSES_AWS_DEPLOY_ROLE_ARN" in workflow
    assert "docker push" in workflow
    assert "aws ssm send-command" in workflow
    assert "aws ssm wait command-executed" in workflow
    assert "-p 8000:8000" in workflow
    assert "http://127.0.0.1:8000/healthz" in workflow
    assert "supabase@2.116.0" not in workflow


def test_aurora_migration_is_marked_after_its_first_successful_run() -> None:
    migration = (ROOT / "supabase" / "functions" / "migrate.ts").read_text(encoding="utf-8")

    assert "app.schema_migrations" in migration
    assert "database_migration_skipped" in migration
    assert "begin;" in migration
    assert "commit;" in migration


def test_compute_bootstrap_writes_non_secret_runtime_configuration() -> None:
    template = (ROOT / "infrastructure" / "aws" / "compute-foundation.yaml").read_text(
        encoding="utf-8"
    )

    assert "NVIDIA_SECRET_ARN=${NvidiaSecretArn}" in template
    assert "DATABASE_HOST=${DatabaseHost}" in template
    assert "COGNITO_USER_POOL_ID=${CognitoUserPoolId}" in template
    assert "chmod 600 /opt/metaglasses/runtime.env" in template
    assert (
        "repo:Adipat2003@99374679/metaglasses-backend@1357463095:ref:refs/heads/main"
        in template
    )
    assert not (ROOT / ".github" / "workflows" / "cd.yml").exists()


def test_github_deploy_role_can_push_ecr_images() -> None:
    template = (ROOT / "infrastructure" / "aws" / "compute-foundation.yaml").read_text(
        encoding="utf-8"
    )

    assert (
        "ecr:BatchCheckLayerAvailability, ecr:BatchGetImage, ecr:CompleteLayerUpload"
        in template
    )


def test_aws_database_foundation_has_a_private_cost_optimized_rds_instance() -> None:
    template = (ROOT / "infrastructure" / "aws" / "database-foundation.yaml").read_text(
        encoding="utf-8"
    )

    assert "CostOptimizedDatabase:" in template
    assert "DBInstanceClass: db.t4g.micro" in template
    assert "Engine: postgres" in template
    assert "EnableIAMDatabaseAuthentication: true" in template
    assert "MultiAZ: false" in template
    assert "PubliclyAccessible: false" in template
    assert "StorageEncrypted: true" in template
    assert "DeletionProtection: true" in template
    assert "DatabaseResourceId" in template


def test_compute_iam_policy_targets_one_specific_database_resource() -> None:
    template = (ROOT / "infrastructure" / "aws" / "compute-foundation.yaml").read_text(
        encoding="utf-8"
    )

    assert "DatabaseResourceId:" in template
    assert "${DatabaseResourceId}/metaglasses_api" in template
    assert "DatabaseClusterResourceId" not in template


def test_rds_bootstrap_uses_iam_only_application_authentication() -> None:
    role_sql = (ROOT / "database" / "bootstrap" / "0001_create_application_role.sql").read_text(
        encoding="utf-8"
    )
    grants_sql = (
        ROOT / "database" / "bootstrap" / "0002_grant_application_access.sql"
    ).read_text(encoding="utf-8")

    assert "create role metaglasses_api login" in role_sql
    assert "grant rds_iam to metaglasses_api" in role_sql
    assert "revoke create on schema public from public" in role_sql
    assert "grant usage on schema app to metaglasses_api" in grants_sql
    assert "grant select on table app.schema_migrations to metaglasses_api" in grants_sql
    assert "grant execute on all functions in schema app to metaglasses_api" in grants_sql
    migrator_sql = (
        ROOT / "database" / "bootstrap" / "0003_create_migration_role.sql"
    ).read_text(encoding="utf-8")
    assert "create role metaglasses_migrator login" in migrator_sql
    assert "grant usage, create on schema app to metaglasses_migrator" in migrator_sql
    assert (
        "grant select, insert on table app.schema_migrations to metaglasses_migrator"
        in migrator_sql
    )
    assert "password" not in role_sql.lower()


def test_aws_api_gateway_foundation_keeps_compute_private() -> None:
    template = (
        ROOT / "infrastructure" / "aws" / "public-api-foundation.yaml"
    ).read_text(encoding="utf-8")

    assert "Type: AWS::ApiGatewayV2::Api" in template
    assert "Type: AWS::ApiGatewayV2::VpcLink" in template
    assert "Scheme: internal" in template
    assert "DisableExecuteApiEndpoint: false" in template
    assert "CidrIp: 0.0.0.0/0" not in template
    assert "TimeoutInMillis: 30000" in template
    assert "RouteKey: $default" in template


def test_aws_runtime_uses_a_timeout_inside_api_gateway_limit() -> None:
    api_source = (ROOT / "supabase" / "functions" / "api" / "index.ts").read_text(
        encoding="utf-8"
    )
    provider_source = (
        ROOT / "supabase" / "functions" / "api" / "providers.ts"
    ).read_text(encoding="utf-8")

    assert 'Deno.env.get("APP_ENV") === "aws" ? 20_000' in api_source
    assert 'return Deno.env.get("APP_ENV") === "aws" ? 20_000' in provider_source


def test_task_plan_api_uses_a_fixed_bedrock_validator_and_separate_migrator() -> None:
    api_source = (ROOT / "supabase" / "functions" / "api" / "index.ts").read_text(
        encoding="utf-8"
    )
    validator_source = (
        ROOT / "supabase" / "functions" / "api" / "task_plan.ts"
    ).read_text(encoding="utf-8")
    migration = (ROOT / "database" / "migrations" / "0002_task_plans.sql").read_text(
        encoding="utf-8"
    )
    command_migration = (
        ROOT / "database" / "migrations" / "0003_task_run_commands.sql"
    ).read_text(encoding="utf-8")
    inference_migration = (
        ROOT / "database" / "migrations" / "0004_task_inference_windows.sql"
    ).read_text(encoding="utf-8")
    observation_migration = (
        ROOT / "database" / "migrations" / "0005_task_inference_observations.sql"
    ).read_text(encoding="utf-8")
    start_migration = (
        ROOT / "database" / "migrations" / "0006_publish_task_run_start.sql"
    ).read_text(encoding="utf-8")
    template = (ROOT / "infrastructure" / "aws" / "compute-foundation.yaml").read_text(
        encoding="utf-8"
    )
    workflow = (ROOT / ".github" / "workflows" / "aws-deploy.yml").read_text(encoding="utf-8")

    assert '"us.anthropic.claude-haiku-5-5"' in validator_source
    assert "validateModelPlan" in validator_source
    assert "POST\" && path === \"/v1/task-plans\"" in api_source
    assert "POST\" && path === \"/v1/task-runs\"" in api_source
    assert "create table app.task_plans" in migration
    assert "grant execute on function app.start_task_run" in migration
    assert "create table app.task_run_commands" in command_migration
    assert "create or replace function app.apply_task_run_command" in command_migration
    assert "create table app.task_inference_windows" in inference_migration
    assert "create_task_inference_window" in inference_migration
    assert "claim_task_inference_window" in observation_migration
    assert "complete_task_inference_window" in observation_migration
    assert "publish_task_run_start" in start_migration
    assert "bedrock:InvokeModel" in template
    assert "us.amazon.nova-lite-v1:0" in template
    assert "DATABASE_MIGRATOR_USER=metaglasses_migrator" in template
    assert "supabase/functions/migrate.ts" in workflow
