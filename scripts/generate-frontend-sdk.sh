#!/usr/bin/env bash
set -euo pipefail

npx --yes openapi-typescript@7.13.0 docs/api-openapi.yaml \
  --output frontend-sdk/api-types.d.ts
