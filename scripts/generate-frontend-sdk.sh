#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

generator="frontend-sdk/node_modules/.bin/openapi-typescript"
if [[ -x "$generator" ]]; then
  "$generator" docs/api-openapi.yaml --output frontend-sdk/api-types.d.ts
else
  npx --yes openapi-typescript@7.13.0 docs/api-openapi.yaml \
    --output frontend-sdk/api-types.d.ts
fi
