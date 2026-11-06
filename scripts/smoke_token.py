"""Get a Cognito access token for the dedicated smoke-test user.

  login    Set the test user's password (hidden prompt) and save its tokens. Needs AWS
           credentials that can call cognito-idp:AdminSetUserPassword, chosen with AWS_PROFILE.
  refresh  Mint a fresh access token from the saved refresh token. Needs no password and no
           AWS credentials, because the Cognito call is unsigned.

Tokens are written with mode 0600 to SMOKE_TOKEN_DIR (default ~/.metaglasses-smoke), never to
stdout and never inside the repository. Access tokens last 15 minutes, so run `refresh` before
each smoke test:

  uv run --with boto3 python scripts/smoke_token.py refresh
  EDGE_API_ACCESS_TOKEN="$(cat ~/.metaglasses-smoke/access_token)" ...
"""

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

import boto3
from botocore import UNSIGNED
from botocore.config import Config

TOKEN_DIR = Path(os.environ.get("SMOKE_TOKEN_DIR", Path.home() / ".metaglasses-smoke"))
ACCESS_TOKEN_FILE = TOKEN_DIR / "access_token"
REFRESH_FILE = TOKEN_DIR / "refresh.json"
REGION = os.environ.get("AWS_REGION", "us-east-1")
EMAIL = os.environ.get("SMOKE_TEST_EMAIL", "smoke-test@example.com")


def write_private(path: Path, text: str) -> None:
    TOKEN_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def login() -> None:
    # pycognito is only needed here, for the SRP sign-in the app client requires.
    from pycognito import Cognito

    session = boto3.Session(region_name=REGION)
    stack = session.client("cloudformation").describe_stacks(StackName="metaglasses-auth")
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stack["Stacks"][0]["Outputs"]}
    pool_id, client_id = outputs["UserPoolId"], outputs["MobileAppClientId"]

    password = getpass.getpass(
        f"New password for {EMAIL} (12+ chars, upper, lower, number, symbol): "
    )
    if password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords did not match.")
    session.client("cognito-idp").admin_set_user_password(
        UserPoolId=pool_id, Username=EMAIL, Password=password, Permanent=True
    )

    user = Cognito(pool_id, client_id, user_pool_region=REGION, username=EMAIL)
    user.authenticate(password=password)
    write_private(ACCESS_TOKEN_FILE, user.access_token)
    write_private(
        REFRESH_FILE,
        json.dumps({"client_id": client_id, "region": REGION, "refresh_token": user.refresh_token}),
    )
    print(f"Access and refresh tokens saved in {TOKEN_DIR} (not printed).")


def refresh() -> None:
    try:
        saved = json.loads(REFRESH_FILE.read_text())
    except FileNotFoundError:
        sys.exit(f"No saved refresh token in {TOKEN_DIR}. Run `login` once first.")

    client = boto3.client(
        "cognito-idp", region_name=saved["region"], config=Config(signature_version=UNSIGNED)
    )
    # The pool rotates refresh tokens, which InitiateAuth REFRESH_TOKEN_AUTH rejects.
    try:
        result = client.get_tokens_from_refresh_token(
            ClientId=saved["client_id"], RefreshToken=saved["refresh_token"]
        )["AuthenticationResult"]
    except Exception as error:  # report Cognito's error, never the token
        sys.exit(f"Refresh failed: {error}")

    write_private(ACCESS_TOKEN_FILE, result["AccessToken"])
    rotated = "RefreshToken" in result
    if rotated:  # the old refresh token stops working once a new one is issued
        saved["refresh_token"] = result["RefreshToken"]
        write_private(REFRESH_FILE, json.dumps(saved))
    print(
        f"Fresh access token saved (expires in {result.get('ExpiresIn')} seconds); "
        f"refresh token rotated: {rotated}."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["login", "refresh"])
    {"login": login, "refresh": refresh}[parser.parse_args().command]()
