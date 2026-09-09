#!/usr/bin/env bash

set -euo pipefail

edge_api_base="${EDGE_API_BASE:-http://127.0.0.1:54321/functions/v1/api}"
expect_chat="${EXPECT_CHAT:-false}"
smoke_dir=$(mktemp -d)
trap 'rm -rf "$smoke_dir"' EXIT
publishable_key=$(
  npx --yes supabase@2.116.0 status --output env 2>/dev/null \
    | sed -n 's/^PUBLISHABLE_KEY="\([^"]*\)"$/\1/p'
)
test -n "$publishable_key"

smoke_email="edge-smoke-$(date +%s)@example.com"
curl --silent --fail --request POST http://127.0.0.1:54321/auth/v1/signup \
  --header "apikey: $publishable_key" \
  --header "Content-Type: application/json" \
  --data "{\"email\":\"$smoke_email\",\"password\":\"Local-test-password-42!\"}" \
  > "$smoke_dir/signup.json"
access_token=$(
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).access_token)' \
    "$smoke_dir/signup.json"
)
test -n "$access_token"

pairing_token=c3f9d1e2c3b4a5f60718293a4b5c6d7a
state_code=$(curl --silent --output "$smoke_dir/state" --write-out '%{http_code}' \
  --request POST "$edge_api_base/v1/state" \
  --header "Authorization: Bearer $access_token" \
  --header "Content-Type: application/json" \
  --data "{\"pairingToken\":\"$pairing_token\",\"state\":\"listening\"}")
test "$state_code" = 204

display_code=$(curl --silent --output "$smoke_dir/display.json" --write-out '%{http_code}' \
  "$edge_api_base/v1/display?token=$pairing_token")
test "$display_code" = 200
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
  if (value.state !== "listening" || value.responseId !== null) process.exit(1);
' "$smoke_dir/display.json"

image_code=$(printf '\211PNG\r\n\032\nimage-data' | curl --silent \
  --output "$smoke_dir/image.json" --write-out '%{http_code}' \
  --request POST "$edge_api_base/v1/images?pairingToken=$pairing_token" \
  --header "Authorization: Bearer $access_token" \
  --header "Content-Type: image/png" \
  --data-binary @-)
test "$image_code" = 201
image_id=$(
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).imageId)' \
    "$smoke_dir/image.json"
)

if [ "$expect_chat" = true ]; then
  chat_code=$(curl --silent --output "$smoke_dir/chat.json" --write-out '%{http_code}' \
    --request POST "$edge_api_base/v1/chat" \
    --header "Authorization: Bearer $access_token" \
    --header "Content-Type: application/json" \
    --data "{\"pairingToken\":\"$pairing_token\",\"messages\":[{\"role\":\"user\",\"content\":\"What is this?\",\"imageIds\":[\"$image_id\"]}]}")
  test "$chat_code" = 200
  node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
    if (!value.responseId || !value.text || !value.createdAt) process.exit(1);
  ' "$smoke_dir/chat.json"
fi

delete_code=$(curl --silent --output "$smoke_dir/delete" --write-out '%{http_code}' \
  --request DELETE "$edge_api_base/v1/images/$image_id?pairingToken=$pairing_token" \
  --header "Authorization: Bearer $access_token")
test "$delete_code" = 204

unauthorized_code=$(curl --silent --output "$smoke_dir/unauthorized" --write-out '%{http_code}' \
  --request POST "$edge_api_base/v1/state" \
  --header "Content-Type: application/json" \
  --data "{\"pairingToken\":\"$pairing_token\",\"state\":\"idle\"}")
test "$unauthorized_code" = 401

cors_header=$(curl --silent --include --request OPTIONS "$edge_api_base/v1/state" \
  | tr -d '\r' \
  | grep -i '^access-control-allow-origin: \*$')
test -n "$cors_header"

echo "Edge API smoke test passed"
