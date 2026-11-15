# Frontend API types

`api-types.d.ts` is generated from [`docs/api-openapi.yaml`](../docs/api-openapi.yaml). It
contains the endpoint paths, methods, parameters, request bodies, response bodies, and shared
schemas as TypeScript types. `client.ts` provides a small typed `fetch` client with bearer
authentication, path and query parameter handling, JSON and raw image uploads, and structured
HTTP errors. It has no runtime dependency.

```ts
import { createClient } from "./frontend-sdk/client.ts";

const api = createClient({ baseUrl: "https://your-api.example", accessToken });
const plans = await api.request("/v1/task-plans", "get", { params: { query: { limit: 50 } } });
```

Regenerate after changing the API contract with `bash scripts/generate-frontend-sdk.sh`. CI checks
that the generated file matches the OpenAPI document and type-checks the client.

For authentication, pairing, error handling, limits, and end-to-end client flows, see the
[backend/frontend handoff](../docs/backend-frontend-handoff.md). Treat the OpenAPI document and
this generated file as the endpoint contract; do not infer routes from database functions.
