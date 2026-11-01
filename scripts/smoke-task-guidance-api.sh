#!/usr/bin/env bash

set -euo pipefail

if [ "${TASK_GUIDANCE_TEST_CONFIRM:-}" != "yes" ]; then
  printf '%s\n' 'Set TASK_GUIDANCE_TEST_CONFIRM=yes to run this state-changing smoke test.' >&2
  exit 2
fi

: "${EDGE_API_BASE:?Set EDGE_API_BASE to the API base URL.}"
: "${EDGE_API_ACCESS_TOKEN:?Set EDGE_API_ACCESS_TOKEN to a Cognito access token.}"
: "${PAIRING_TOKEN:?Set PAIRING_TOKEN to a dedicated 32-character hexadecimal pairing token.}"

if ! [[ "$PAIRING_TOKEN" =~ ^[0-9a-fA-F]{32}$ ]]; then
  printf '%s\n' 'PAIRING_TOKEN must be 32 hexadecimal characters.' >&2
  exit 2
fi

smoke_dir=$(mktemp -d)
task_run_id=""
state_version=""
image_id=""

uuid() {
  node -e 'console.log(crypto.randomUUID())'
}

expect_status() {
  if [ "$1" != "$2" ]; then
    printf 'Expected HTTP %s, got %s. Response follows:\n' "$2" "$1" >&2
    sed -n '1,120p' "$3" >&2
    exit 1
  fi
}

json_request() {
  local method=$1
  local path=$2
  local payload=$3
  local output=$4

  curl --silent --show-error --output "$output" --write-out '%{http_code}' \
    --request "$method" "$EDGE_API_BASE$path" \
    --header "Authorization: Bearer $EDGE_API_ACCESS_TOKEN" \
    --header 'Content-Type: application/json' \
    --data "$payload"
}

cleanup() {
  local exit_code=$?

  if [ -n "$task_run_id" ] && [ -n "$state_version" ]; then
    json_request POST "/v1/task-runs/$task_run_id/stop" \
      "{\"clientRequestId\":\"$(uuid)\",\"expectedStateVersion\":$state_version}" \
      "$smoke_dir/cleanup-stop.json" >/dev/null || true
  fi
  if [ -n "$image_id" ]; then
    curl --silent --show-error --output "$smoke_dir/cleanup-delete.json" --write-out '%{http_code}' \
      --request DELETE "$EDGE_API_BASE/v1/images/$image_id?pairingToken=$PAIRING_TOKEN" \
      --header "Authorization: Bearer $EDGE_API_ACCESS_TOKEN" >/dev/null || true
  fi
  rm -rf "$smoke_dir"
  trap - EXIT
  exit "$exit_code"
}

trap cleanup EXIT

state_code=$(json_request POST /v1/state \
  "{\"pairingToken\":\"$PAIRING_TOKEN\",\"state\":\"listening\"}" \
  "$smoke_dir/state.json")
expect_status "$state_code" 204 "$smoke_dir/state.json"

plan_request_id=$(uuid)
plan_code=$(json_request POST /v1/task-plans \
  "{\"pairingToken\":\"$PAIRING_TOKEN\",\"clientRequestId\":\"$plan_request_id\",\"title\":\"Place a cup on a table\",\"steps\":[{\"instruction\":\"Place the cup on the table.\"}]}" \
  "$smoke_dir/plan.json")
expect_status "$plan_code" 201 "$smoke_dir/plan.json"
task_plan_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).taskPlanId)' \
  "$smoke_dir/plan.json")

validation_code=$(json_request POST "/v1/task-plans/$task_plan_id/validate" '{}' \
  "$smoke_dir/validation.json")
expect_status "$validation_code" 200 "$smoke_dir/validation.json"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
  if (value.status !== "awaiting_approval" || value.validationStatus !== "validated") process.exit(1);
' "$smoke_dir/validation.json"

approval_code=$(json_request POST "/v1/task-plans/$task_plan_id/approve" '{}' \
  "$smoke_dir/approval.json")
expect_status "$approval_code" 200 "$smoke_dir/approval.json"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
  if (value.status !== "approved") process.exit(1);
' "$smoke_dir/approval.json"

run_request_id=$(uuid)
run_code=$(json_request POST /v1/task-runs \
  "{\"taskPlanId\":\"$task_plan_id\",\"clientRequestId\":\"$run_request_id\"}" \
  "$smoke_dir/run.json")
expect_status "$run_code" 201 "$smoke_dir/run.json"
task_run_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).taskRunId)' \
  "$smoke_dir/run.json")
state_version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).stateVersion)' \
  "$smoke_dir/run.json")

# Nova rejects a 1x1 image, so send a small 64x64 checkerboard.
image_code=$(node -e 'process.stdout.write(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYklEQVR42u3ZwQkAMAgDQAdz/3m6QTtDhEKhJ76D9wzW7o52hXM7vwAAAAAAAAAAAAAAxoDXDkrzAQAAAAAAAAAAAADmAI0MAAAAAAAAAAAAwH9AIwMAAAAAAAAAAAD4DnAAqlM5/w+L0OcAAAAASUVORK5CYII=", "base64"))' \
  | curl --silent --show-error --output "$smoke_dir/image.json" --write-out '%{http_code}' \
    --request POST "$EDGE_API_BASE/v1/images?pairingToken=$PAIRING_TOKEN" \
    --header "Authorization: Bearer $EDGE_API_ACCESS_TOKEN" \
    --header 'Content-Type: image/png' \
    --data-binary @-)
expect_status "$image_code" 201 "$smoke_dir/image.json"
image_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).imageId)' \
  "$smoke_dir/image.json")
captured_at=$(node -e 'console.log(new Date().toISOString())')

window_request_id=$(uuid)
window_code=$(json_request POST "/v1/task-runs/$task_run_id/inference-windows" \
  "{\"clientRequestId\":\"$window_request_id\",\"sequenceNumber\":1,\"expectedStateVersion\":$state_version,\"frames\":[{\"imageId\":\"$image_id\",\"capturedAt\":\"$captured_at\"}]}" \
  "$smoke_dir/window.json")
expect_status "$window_code" 202 "$smoke_dir/window.json"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
  if (value.outcome !== "accepted" || value.status !== "queued") process.exit(1);
' "$smoke_dir/window.json"

observed=false
for attempt in $(seq 1 15); do
  curl --silent --show-error --output "$smoke_dir/display.json" \
    "$EDGE_API_BASE/v1/display?token=$PAIRING_TOKEN"
  if node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
    process.exit(typeof value.responseId === "string" && value.responseId.startsWith("task_observation_") ? 0 : 1);
  ' "$smoke_dir/display.json"; then
    observed=true
    break
  fi
  sleep 2
done
if [ "$observed" != true ]; then
  printf '%s\n' 'Nova observation did not update the display within 30 seconds.' >&2
  exit 1
fi

repeat_code=$(json_request POST "/v1/task-runs/$task_run_id/commands" \
  "{\"clientRequestId\":\"$(uuid)\",\"command\":\"repeat\",\"expectedStateVersion\":$state_version}" \
  "$smoke_dir/repeat.json")
expect_status "$repeat_code" 200 "$smoke_dir/repeat.json"
next_state_version=$(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1]));
  if (value.outcome !== "applied" || !Number.isSafeInteger(value.stateVersion)) process.exit(1);
  console.log(value.stateVersion);
' "$smoke_dir/repeat.json")
state_version=$next_state_version

stop_code=$(json_request POST "/v1/task-runs/$task_run_id/stop" \
  "{\"clientRequestId\":\"$(uuid)\",\"expectedStateVersion\":$next_state_version}" \
  "$smoke_dir/stop.json")
expect_status "$stop_code" 200 "$smoke_dir/stop.json"
task_run_id=""

delete_code=$(curl --silent --show-error --output "$smoke_dir/delete.json" --write-out '%{http_code}' \
  --request DELETE "$EDGE_API_BASE/v1/images/$image_id?pairingToken=$PAIRING_TOKEN" \
  --header "Authorization: Bearer $EDGE_API_ACCESS_TOKEN")
expect_status "$delete_code" 204 "$smoke_dir/delete.json"
image_id=""

printf '%s\n' 'Task-guidance smoke test passed.'
