import json
import os
import re
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest

WORKFLOWS = Path(__file__).parents[1] / ".github" / "workflows"
DEPLOY = (WORKFLOWS / "aws-deploy.yml").read_text(encoding="utf-8")
POSTMAN = (WORKFLOWS / "notify-postman-contract.yml").read_text(encoding="utf-8")
SDK = (WORKFLOWS / "publish-frontend-sdk.yml").read_text(encoding="utf-8")
SHA = "a" * 40


def run_step(
    workflow: str, name: str, shell_stubs: str = "", **env: str
) -> subprocess.CompletedProcess[str]:
    step = workflow.split(f"      - name: {name}\n", 1)[1]
    block = re.search(r"(?m)^        run: \|\n((?:^          .*\n)+)", step)
    assert block, f"Missing shell block in {name}"
    return subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", shell_stubs + "\n" + dedent(block[1])],
        check=False,
        capture_output=True,
        text=True,
        env=os.environ | env,
        timeout=10,
    )


@pytest.mark.parametrize("workflow", [DEPLOY, SDK], ids=["deploy", "publish"])
def test_privileged_release_requires_successful_same_repository_main_push_ci(workflow: str) -> None:
    assert "on:\n  workflow_run:\n    workflows: [CI]\n" in workflow
    assert "branches: [main]" in workflow
    assert "types: [completed]" in workflow
    assert "github.event.workflow_run.conclusion == 'success'" in workflow
    assert "github.event.workflow_run.event == 'push'" in workflow
    assert "github.event.workflow_run.head_repository.full_name == github.repository" in workflow
    assert "github.ref == 'refs/heads/main'" in workflow
    assert "queue: max" in workflow
    assert "cancel-in-progress: false" in workflow


def test_postman_receives_only_an_explicit_verified_deploy_sha() -> None:
    assert "verified_sha: ${{ steps.deploy.outputs.verified_sha }}" in DEPLOY
    assert "needs: deploy\n    if: needs.deploy.outputs.verified_sha != ''" in DEPLOY
    assert "backend_sha: ${{ needs.deploy.outputs.verified_sha }}" in DEPLOY
    assert "uses: ./.github/workflows/notify-postman-contract.yml" in DEPLOY
    assert "on:\n  workflow_call:" in POSTMAN
    assert "repositories: metaglasses-postman\n          permission-contents: write" in POSTMAN


@pytest.mark.parametrize(
    ("main_sha", "expected_exit", "expected_output"),
    [(SHA, 0, "current=true\n"), ("b" * 40, 0, ""), ("", 1, "")],
)
def test_aws_skips_superseded_commits(
    tmp_path: Path, main_sha: str, expected_exit: int, expected_output: str
) -> None:
    output = tmp_path / "outputs"
    output.touch()
    result = run_step(
        DEPLOY,
        "Check whether the validated SHA is still main",
        'timeout() { printf "%s" "$MAIN_SHA"; }',
        GITHUB_REPOSITORY="Adipat2003/metaglasses-backend",
        GITHUB_OUTPUT=str(output),
        MAIN_SHA=main_sha,
        BACKEND_SHA=SHA,
    )

    assert result.returncode == expected_exit
    assert output.read_text() == expected_output


@pytest.mark.parametrize(
    ("ecr_lookup", "expected_exit", "builds"),
    [
        ({"images": [{}], "failures": []}, 0, False),
        ({"images": [], "failures": [{"failureCode": "ImageNotFound"}]}, 0, True),
        ({"images": [], "failures": [{"failureCode": "UpstreamUnavailable"}]}, 1, False),
    ],
)
def test_aws_reuses_immutable_image_and_builds_only_when_missing(
    ecr_lookup: dict, expected_exit: int, builds: bool
) -> None:
    result = run_step(
        DEPLOY,
        "Build or reuse the immutable commit image",
        """
        git() { echo "$BACKEND_SHA"; }
        aws() {
          case "$2" in
            batch-get-image) echo "$ECR_LOOKUP" ;;
            get-login-password) echo fake-login-password ;;
            *) return 2 ;;
          esac
        }
        docker() {
          if [[ "$1" == login ]]; then cat >/dev/null; else echo "$*"; fi
        }
        """,
        BACKEND_SHA=SHA,
        ECR_LOOKUP=json.dumps(ecr_lookup),
        REPOSITORY="registry/api",
        REGISTRY="registry",
    )

    assert result.returncode == expected_exit, result.stderr
    assert (f"build --tag registry/api:{SHA} ." in result.stdout) == builds
    assert (f"push registry/api:{SHA}" in result.stdout) == builds


@pytest.mark.parametrize("wait_status", [0, 1])
def test_aws_reports_sha_only_after_ssm_verifies_health(tmp_path: Path, wait_status: int) -> None:
    output = tmp_path / "outputs"
    output.touch()
    result = run_step(
        DEPLOY,
        "Deploy and verify the commit image",
        """
        aws() {
          case "$2" in
            send-command) printf '%s' "$8" > "$PARAMETERS"; echo fake-command-id ;;
            wait) return "$WAIT_STATUS" ;;
            get-command-invocation) echo invocation ;;
            *) return 2 ;;
          esac
        }
        """,
        AWS_REGION="us-east-1",
        BACKEND_SHA=SHA,
        GITHUB_OUTPUT=str(output),
        INSTANCE="fake-instance",
        PARAMETERS=str(tmp_path / "parameters"),
        REGISTRY="registry",
        REPOSITORY="registry/api",
        WAIT_STATUS=str(wait_status),
    )

    assert result.returncode == wait_status, result.stderr
    assert output.read_text() == ("" if wait_status else f"verified_sha={SHA}\n")
    [command] = json.loads((tmp_path / "parameters").read_text())["commands"]
    assert f"image='registry/api:{SHA}'" in command
    assert '[ "$running_image" = "$image" ]' in command
    assert "http://127.0.0.1:8000/healthz" in command
    subprocess.run(["bash", "-n"], input=command, text=True, check=True, timeout=10)


@pytest.mark.parametrize(
    ("app_id", "app_key", "expected"), [("", "key", 1), ("id", "", 1), ("id", "key", 0)]
)
def test_postman_dispatch_fails_visibly_without_app_credentials(
    app_id: str, app_key: str, expected: int
) -> None:
    result = run_step(
        POSTMAN,
        "Check GitHub App configuration",
        POSTMAN_SYNC_APP_ID=app_id,
        POSTMAN_SYNC_APP_PRIVATE_KEY=app_key,
    )

    assert result.returncode == expected
    assert ("::error::" in result.stdout) == bool(expected)


def test_postman_dispatch_preserves_sha_and_run_urls() -> None:
    ci_url = "https://github.com/Adipat2003/metaglasses-backend/actions/runs/123"
    deploy_url = "https://github.com/Adipat2003/metaglasses-backend/actions/runs/124"
    result = run_step(
        POSTMAN,
        "Dispatch canonical Postman sync",
        'curl() { printf "%s\\n" "${@: -3:1}" "${@: -1}"; }',
        BACKEND_SHA=SHA,
        SOURCE_RUN_URL=ci_url,
        DEPLOYMENT_RUN_URL=deploy_url,
        DISPATCH_TOKEN="fake-token",
    )

    assert result.returncode == 0, result.stderr
    url, payload = result.stdout.splitlines()
    assert url == "https://api.github.com/repos/Adipat2003/metaglasses-postman/dispatches"
    assert json.loads(payload) == {
        "event_type": "backend-contract-changed",
        "client_payload": {
            "backend_repository": "Adipat2003/metaglasses-backend",
            "backend_sha": SHA,
            "source_run_url": ci_url,
            "deployment_run_url": deploy_url,
        },
    }


def test_sdk_checks_the_commit_in_provenance_and_the_final_package() -> None:
    assert "github.sha == github.event.workflow_run.head_sha" in SDK
    assert "ref: ${{ github.event.workflow_run.head_sha }}" in SDK
    assert 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"' in SDK
    assert "git diff --exit-code -- frontend-sdk/api-types.d.ts" in SDK
    assert SDK.index("npm version") < SDK.index("check-frontend-sdk-package.mjs")
    assert SDK.index("check-frontend-sdk-package.mjs") < SDK.index("npm publish")
    assert "if: steps.release.outputs.publish == 'true'" in SDK
    assert "npm publish --access public --provenance --tag latest" in SDK


@pytest.mark.parametrize(
    ("version", "latest", "registry_status", "expected"),
    [
        ("0.1.10", "0.1.9", 0, "publish=true\n"),
        ("1.0.1", "0.9.999", 0, "publish=true\n"),
        ("0.9.999", "1.0.1", 0, "publish=false\n"),
        ("0.1.9", "0.1.9", 0, "publish=false\n"),
        ("0.1.9", "0.1.10", 0, "publish=false\n"),
        ("0.1.20", "malformed", 0, ""),
        ("0.1.20", "0.1.19", 1, ""),
    ],
)
def test_sdk_can_only_advance_latest(
    tmp_path: Path, version: str, latest: str, registry_status: int, expected: str
) -> None:
    output = tmp_path / "outputs"
    output.touch()
    result = run_step(
        SDK,
        "Check whether this version advances npm latest",
        'npm() { printf "%s" "$REGISTRY_RESPONSE"; return "$REGISTRY_STATUS"; }',
        GITHUB_OUTPUT=str(output),
        REGISTRY_RESPONSE=json.dumps(latest),
        REGISTRY_STATUS=str(registry_status),
        VERSION=version,
    )

    assert (result.returncode == 0) == bool(expected), result.stderr
    assert output.read_text() == expected
