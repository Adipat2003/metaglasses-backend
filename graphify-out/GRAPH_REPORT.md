# Graph Report - metaglasses-backend  (2026-09-13)

## Corpus Check
- Corpus is ~20,288 words - fits in a single context window. You may not need a graph.

## Summary
- 350 nodes · 781 edges · 18 communities (12 shown, 3 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 80 edges (avg confidence: 0.94)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Chat API Service
- Pairing Image Store
- Edge API Foundation
- Python API Routes
- Python Auth and Config
- Storage Client
- Postman Generator
- Supabase Architecture
- CI CD Operations
- NVIDIA Integration
- Local Development Stack
- Deno Tooling
- Package Metadata
- Edge API Smoke Test
- Project Repository

## God Nodes (most connected - your core abstractions)
1. `create_app()` - 50 edges
2. `Settings` - 34 edges
3. `ConfigurationError` - 21 edges
4. `ConversationMessage` - 21 edges
5. `ApiError` - 21 edges
6. `PostgresPairingStore` - 17 edges
7. `DisplayResponse` - 16 edges
8. `PairingStore` - 16 edges
9. `FakeChatService` - 16 edges
10. `SupabaseImageStorage` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Trial and Production Environment Isolation` --semantically_similar_to--> `Protected Production Release`  [INFERRED] [semantically similar]
  docs/deployment.md → .github/workflows/cd.yml
- `Scheduled Image Cleanup` --semantically_similar_to--> `Temporary Image Lifecycle`  [INFERRED] [semantically similar]
  docs/supabase.md → README.md
- `Pairing Image Access Control` --semantically_similar_to--> `Temporary Image Lifecycle`  [INFERRED] [semantically similar]
  docs/supabase.md → README.md
- `Hosted Edge API Priority` --semantically_similar_to--> `Hosted Edge API Exclusivity`  [INFERRED] [semantically similar]
  AGENTS.md → README.md
- `FakeTokenVerifier` --uses--> `AuthenticatedUser`  [INFERRED]
  tests/test_api.py → app/auth.py

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Deployment Release Assurance** — github_workflows_ci_ci_validation, github_workflows_cd_trial_deployment, github_workflows_cd_production_deployment, github_workflows_cd_deployment_health_check [EXTRACTED 1.00]
- **Temporary Image Security Lifecycle** — readme_temporary_image_lifecycle, docs_supabase_pairing_image_access_control, docs_supabase_cleanup_lifecycle, docs_supabase_nvidia_async_polling [EXTRACTED 1.00]
- **Local Full Stack Validation** — docs_local_development_local_edge_api, docs_local_development_docker_reference_api, docs_local_development_smoke_testing, docker_compose_python_api_service [EXTRACTED 1.00]

## Communities (18 total, 3 thin omitted)

### Community 0 - "Chat API Service"
Cohesion: 0.07
Nodes (45): AccessTokenError, Exception, The supplied access token could not be trusted., create_app(), ConversationMessage, One turn from the phone-maintained conversation transcript., ChatService, _model_message() (+37 more)

### Community 1 - "Pairing Image Store"
Cohesion: 0.08
Nodes (23): _build_pairing_store(), DisplayResponse, Newest instruction and current activity visible to a paired lens., PairingImage, PairingImageLimitError, PairingImageNotFoundError, PairingNotFoundError, PairingOwnershipError (+15 more)

### Community 2 - "Edge API Foundation"
Cohesion: 0.11
Nodes (46): adminHeaders(), ApiError, authenticate(), AuthenticatedUser, clientErrorContext(), compactStack(), ConversationMessage, corsHeaders (+38 more)

### Community 3 - "Python API Routes"
Cohesion: 0.09
Nodes (38): AuthenticatedUser, build_current_user_dependency(), current_user(), HTTPException, Protocol, TokenVerifier, _unauthorized(), chat() (+30 more)

### Community 4 - "Python Auth and Config"
Cohesion: 0.18
Nodes (28): Verify Supabase access tokens locally with the project's public JWKS., SupabaseTokenVerifier, ConfigurationError, _positive_int(), The application environment is missing or unsafe., Settings, parametrize, RuntimeError (+20 more)

### Community 5 - "Storage Client"
Cohesion: 0.11
Nodes (15): ImageStorageError, ImageStorageProtocol, AsyncClient, Exception, Protocol, Reject image operations until Supabase Storage is configured., Use a phone user's JWT for private Supabase Storage operations., Supabase Storage could not complete an image operation. (+7 more)

### Community 6 - "Postman Generator"
Cohesion: 0.14
Nodes (14): apiKeyHeader, apiRequests, authHeader, authRequests(), backendSourcePath, collection(), collectionPath, hostedEnvironments (+6 more)

### Community 7 - "Supabase Architecture"
Cohesion: 0.13
Nodes (16): Hosted Edge API Priority, Repository Sources of Truth, CORS Policy, Forward-Compatible Migrations, Local Development Security Boundary, Scheduled Image Cleanup, Credentials and Trust Boundaries, NVIDIA Asynchronous Polling (+8 more)

### Community 8 - "CI CD Operations"
Cohesion: 0.24
Nodes (10): Deployment and Operations, Trial and Production Environment Isolation, Deployment Health Check, Production Deployment, Protected Production Release, Trial Deployment, CI Validation Workflow, Edge Function Validation (+2 more)

### Community 9 - "NVIDIA Integration"
Cohesion: 0.36
Nodes (4): Fetcher, NvidiaPendingResponseError, PollOptions, resolveNvidiaResponse()

### Community 10 - "Local Development Stack"
Cohesion: 0.33
Nodes (6): Python API Compose Service, Docker Python Reference API, Local Supabase Edge API, Local Runtime Modes, Local Smoke Testing, Local Supabase Development

### Community 12 - "Deno Tooling"
Cohesion: 0.50
Nodes (3): fmt, lineWidth, proseWrap

## Knowledge Gaps
- **32 isolated node(s):** `metaglasses-backend`, `root`, `backendSourcePath`, `collectionPath`, `hostedEnvironments` (+27 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 112 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `create_app()` connect `Chat API Service` to `Pairing Image Store`, `Python API Routes`, `Python Auth and Config`, `Storage Client`?**
  _High betweenness centrality (0.113) - this node is a cross-community bridge._
- **Why does `Settings` connect `Python Auth and Config` to `Chat API Service`, `Pairing Image Store`, `Python API Routes`, `Storage Client`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `SupabaseImageStorage` connect `Storage Client` to `Python API Routes`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Are the 18 inferred relationships involving `create_app()` (e.g. with `AuthenticatedUser` and `TokenVerifier`) actually correct?**
  _`create_app()` has 18 INFERRED edges - model-reasoned connections that need verification._
- **Are the 25 inferred relationships involving `Settings` (e.g. with `build_current_user_dependency()` and `SupabaseTokenVerifier`) actually correct?**
  _`Settings` has 25 INFERRED edges - model-reasoned connections that need verification._
- **Are the 15 inferred relationships involving `ConfigurationError` (e.g. with `test_auth_enabled_requires_a_supabase_url()` and `test_database_url_requires_postgres_host_and_database()`) actually correct?**
  _`ConfigurationError` has 15 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `ConversationMessage` (e.g. with `transcript_size()` and `ChatService`) actually correct?**
  _`ConversationMessage` has 6 INFERRED edges - model-reasoned connections that need verification._