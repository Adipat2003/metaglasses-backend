# MetaGlasses AWS walkthrough for an agent

Give this document to an agent working with a teammate who wants to understand the MetaGlasses AWS
environment. The agent's job is to walk through the system in order, explain what each component
does in plain language, and verify live state without changing it.

This is a guide for the deployed AWS environment, not a request to redesign or modify it.

## Agent operating rules

1. Start read-only. Do not create, delete, deploy, update, restart, rotate, or change permissions
   unless the human gives explicit approval for that exact action.
2. Explain the purpose of the next section before running its commands. Show the human what was
   found and ask whether they want to continue after each major section.
3. Never ask the human to paste a password, access token, secret value, private key, database URL,
   or Cognito token into chat. Do not retrieve or print raw Secrets Manager values.
4. Use the configured named profile. If it has expired, ask before opening an interactive AWS sign-in.
5. Treat the CloudFormation templates, current stack outputs, and this repository's deployment
   documentation as the source of truth. Do not infer configuration from a console screenshot.
6. Before proposing an infrastructure change, inspect the relevant template and create a
   CloudFormation change set. Summarize replacements, deletions, IAM changes, network exposure,
   and data-retention effects before asking for approval to execute it.
7. Keep all commands scoped to the account and Region below. Stop if the account or Region differs.

## Scope and expected environment

| Item | Expected value |
| --- | --- |
| AWS account | `995342110760` |
| Region | `us-east-1` |
| CLI profile | `PowerUserAccess-995342110760` |
| Repository | `Adipat2003/metaglasses-backend` |
| Public entry point | API Gateway HTTP API |
| Application runtime | Deno container on one private EC2 instance |
| Database | Private RDS PostgreSQL |
| IaC | CloudFormation YAML in `infrastructure/aws/` |

The expected stack order is:

```text
metaglasses-auth
metaglasses-storage
metaglasses-database
metaglasses-compute
metaglasses-public-api
metaglasses-audit
```

## 0. Establish safe access

Tell the human: "I will first confirm the AWS identity, account, Region, and stack inventory. These
commands are read-only."

Run:

```bash
aws --version
aws sts get-caller-identity --profile PowerUserAccess-995342110760
aws cloudformation list-stacks \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `metaglasses-`)].[StackName,StackStatus,LastUpdatedTime]' \
  --output table
```

Expected result: the account is `995342110760`, and the six stacks above are in a complete state.

If credentials are missing or expired, explain that the named profile must be refreshed. Ask before
running this interactive command:

```bash
aws sso login --profile PowerUserAccess-995342110760
```

## 1. Start with the end-user request path

Explain this architecture before inspecting individual resources:

```text
Mobile app or glasses client
  -> public API Gateway HTTP API
  -> VPC Link
  -> internal Application Load Balancer
  -> private EC2 Deno API container
  -> RDS PostgreSQL, Cognito, S3, Secrets Manager, Bedrock
```

Only API Gateway is public. The load balancer, EC2 instance, database, S3 objects, and runtime
credentials stay private. This separation limits the internet-facing surface area.

Read the public API stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-public-api \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table
```

Explain these outputs:

- `HttpApiUrl`: stable public base URL for clients.
- `HttpApiId`: API Gateway control-plane identifier.
- `InternalLoadBalancerArn`: private target reached through VPC Link.
- `HttpApiAccessLogGroup`: request status and latency logs, without request bodies or credentials.

Run the public health check only after confirming the URL is an expected stack output:

```bash
api_url=$(aws cloudformation describe-stacks \
  --stack-name metaglasses-public-api \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`HttpApiUrl`].OutputValue' \
  --output text)
curl --fail "$api_url/healthz"
```

Expected response fields are `status: ok`, `environment: aws`, and `auth: required`. Health is
public, but all application routes except the lens display capability route require authentication.

## 2. Authentication: `metaglasses-auth`

Explain: Amazon Cognito owns user authentication. The API verifies Cognito access tokens. It does
not use Supabase Auth in the deployed AWS environment.

Inspect read-only outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-auth \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table
```

Explain:

- `UserPoolId`: Cognito directory for MetaGlasses users.
- `MobileAppClientId`: client identifier for the mobile application. It is not a user secret.
- `JwtIssuer`: issuer the API accepts when validating access tokens.

Do not list users, reset passwords, create users, change MFA, or modify app clients unless the
human explicitly asks for that exact operation.

## 3. Image storage: `metaglasses-storage`

Explain: the private S3 bucket stores short-lived pairing images. The API accepts JPEG or PNG
uploads, stores them privately, and supplies short-lived signed URLs only to the inference path.

Inspect the stack and bucket posture:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-storage \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table

bucket_name=$(aws cloudformation describe-stacks \
  --stack-name metaglasses-storage \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`PairingImagesBucketName`].OutputValue' \
  --output text)
aws s3api get-public-access-block --bucket "$bucket_name" \
  --profile PowerUserAccess-995342110760
aws s3api get-bucket-encryption --bucket "$bucket_name" \
  --profile PowerUserAccess-995342110760
```

Expected posture: public access is blocked and encryption is enabled. Do not list or download
customer image objects during an architectural walkthrough. Those objects may contain sensitive
visual data.

## 4. Data layer: `metaglasses-database`

Explain: RDS PostgreSQL is private and holds pairings, task plans, task runs, inference windows,
and bounded observations. The deployed application uses IAM database authentication, not an
application database password.

Inspect outputs and protection settings:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-database \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table

aws rds describe-db-instances \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'DBInstances[].{Identifier:DBInstanceIdentifier,Engine:Engine,Version:EngineVersion,Class:DBInstanceClass,Public:PubliclyAccessible,Encrypted:StorageEncrypted,DeletionProtection:DeletionProtection,MultiAZ:MultiAZ}' \
  --output table
```

Explain the important controls:

- The database is not publicly reachable.
- Storage encryption and deletion protection are enabled.
- It is currently a cost-optimized single-AZ `db.t4g.micro` instance, so it is not a
  high-availability production topology.
- `metaglasses_api` has only the narrow database permissions needed by the API.
- `metaglasses_migrator` is a separate role used only to apply migrations.

For database content inspection, use the existing SSM tunnel and a database client such as DBeaver.
Ask the human to enter database administrator credentials locally if a one-time administration step
is necessary. Never request the credential in chat, never save it in a connection profile, and never
print the master secret value.

## 5. Runtime, image registry, and deployment: `metaglasses-compute`

Explain: the API is a Deno container built in GitHub Actions, stored in ECR, and run on a private
EC2 instance. GitHub does not hold a static AWS key. It assumes a narrow deploy role through OIDC.

Inspect outputs, instance health, and the registry:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-compute \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table

instance_id=$(aws cloudformation describe-stacks \
  --stack-name metaglasses-compute \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiInstanceId`].OutputValue' \
  --output text)
aws ec2 describe-instance-status \
  --instance-ids "$instance_id" \
  --include-all-instances \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --output table
```

Explain:

- `ApiRepositoryUri`: ECR location for immutable commit-tagged application images.
- `ApiInstanceId`: private EC2 host that runs the current API container.
- `ApiRoleArn`: runtime role with narrowly scoped access to RDS IAM auth, S3, Bedrock, and
  required configuration.
- `GitHubDeployRoleArn`: role GitHub Actions assumes through OIDC to publish and deploy images.

The deployment workflow is [aws-deploy.yml](../.github/workflows/aws-deploy.yml). On every merged
`main` commit it builds and pushes the image, applies only unapplied database migrations as the
migrator role, starts the container, and checks `/healthz` locally on EC2.

Do not use SSM to run remote commands, restart the container, or inspect application logs unless the
human specifically authorizes that remote action. Those actions affect a live production host.

## 6. AI inference: Amazon Bedrock

Explain the deliberate split between reasoning and visual observation:

| Use | Fixed Bedrock model | Why |
| --- | --- | --- |
| Validate a user-authored task plan | `us.anthropic.claude-haiku-5-5` | Fast plan normalization, ambiguity detection, and review metadata |
| Observe one to three recent task images | `us.amazon.nova-lite-v1:0` | Low-latency multimodal observation in the live loop |
| Escalate uncertain or high-consequence verification | `us.amazon.nova-2-lite-v1:0` | Use selectively, not on every window |

The models advise only. Code owns the state machine. A model can suggest that a step is complete or
blocked, but it cannot confirm, skip, stop, or advance a task on its own.

Read-only inventory commands:

```bash
aws bedrock list-foundation-models \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'modelSummaries[?contains(modelId, `nova`) || contains(modelId, `claude`)].[modelId,modelName,inputModalities,outputModalities]' \
  --output table

aws bedrock list-inference-profiles \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'inferenceProfileSummaries[].[inferenceProfileId,inferenceProfileName,status]' \
  --output table
```

Then explain these concepts:

- A cross-region inference profile such as `us.` is a routing and data-residency choice. Do not
  replace it with a base model ID without checking availability and IAM coverage.
- The account's current quota is an operational limit, not a promise. Inspect it in the Bedrock
  console before increasing cadence or adding users. Quotas and prices change.
- Every inference request must have an explicit output-token cap and timeout. An unbounded cap can
  reserve far more quota than the response actually uses.
- Bedrock token and image inference pricing is usage-based. Estimate using the current AWS Pricing
  page or Pricing Calculator rather than hard-coding dollar amounts in a design discussion.
- Use `bedrock-runtime` only for inference. `bedrock` is the control plane used for model and
  profile inventory.

Do not invoke a model as part of a walkthrough unless the human explicitly approves the test and
understands that it can incur usage charges and may process test content.

## 7. Public API, task-guidance flow, and safe testing

Explain the normal task-guidance sequence:

```text
Authenticated user submits ordered steps
  -> Claude validates the plan
  -> user reviews and explicitly approves it
  -> user starts a task run
  -> client uploads 1-3 recent images
  -> Nova produces a bounded observation
  -> code displays guidance
  -> user confirms, repeats, pauses, skips, or stops through an allowlisted command
```

The relevant API routes are:

```text
POST /v1/task-plans
POST /v1/task-plans/{taskPlanId}/validate
POST /v1/task-plans/{taskPlanId}/approve
POST /v1/task-runs
POST /v1/task-runs/{taskRunId}/commands
POST /v1/task-runs/{taskRunId}/inference-windows
POST /v1/task-runs/{taskRunId}/stop
```

For a live end-to-end test, use a dedicated Cognito test user and a new pairing token. The guarded
script [smoke-task-guidance-api.sh](../scripts/smoke-task-guidance-api.sh) changes pairing display
state, creates a task record, calls Claude and Nova, and may incur model charges. It requires the
human's explicit approval immediately before running it. Follow the command in
[local-development.md](local-development.md#validation).

## 8. Observability, audit, and incident triage

Explain the distinction:

- API Gateway access logs answer: did a request reach the public API, what status did it return,
  and how long did it take?
- Application lifecycle logs on the EC2 container answer: did a migration, database call, or model
  inference stage fail?
- CloudTrail answers: who changed AWS control-plane resources and when?

Inspect configured endpoints read-only:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-audit \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1 \
  --query 'Stacks[0].Outputs.[OutputKey,OutputValue]' \
  --output table

aws cloudtrail get-trail-status \
  --name metaglasses-audit-trail \
  --profile PowerUserAccess-995342110760 \
  --region us-east-1
```

For a request failure, proceed in this order:

1. Confirm the API health endpoint and the HTTP API access log status.
2. Confirm the EC2 instance and its target are healthy.
3. Confirm the deployment workflow and its migration step completed.
4. Inspect safe, structured application log events by request ID. Do not collect raw request bodies,
   authorization headers, image bytes, or signed URLs.
5. For a Bedrock issue, classify it before retrying: validation and authorization errors are not
   retryable; throttling, service unavailable, and bounded timeouts may be retryable.

Do not create alarms, dashboards, log subscriptions, ADOT instrumentation, or CloudWatch Omni
resources during a walkthrough. Each is an infrastructure change and needs its own design and
approval.

## 9. Security and cost review

Walk through these points verbally. They are a review checklist, not permission to change anything.

### Security

- Cognito access tokens authenticate phone routes.
- Pairing tokens are capability credentials for the lens display path and should be treated as
  sensitive.
- RDS, ALB, EC2, and S3 are private. Do not widen a security group to `0.0.0.0/0` to troubleshoot.
- Secrets belong in Secrets Manager. Source code, shell history, chat, and CloudFormation parameters
  must not contain raw secret values.
- Runtime and deployment roles follow least privilege. Review IAM policy changes before execution.
- CloudTrail records AWS management activity. It does not replace application-level request logging.

### Cost

- RDS is a single-AZ `db.t4g.micro` for cost control. Multi-AZ would improve availability and
  increase cost.
- EC2, EBS, API Gateway, ALB, S3 storage and requests, ECR storage, CloudWatch ingestion, and
  Bedrock inference are separate billable dimensions.
- For the visual loop, cadence and image size drive model calls. Prefer 1-3 compact images at a
  bounded cadence over a continuous video stream.
- Use AWS Cost Explorer, budgets, and current Bedrock pricing for a real estimate. Do not guess from
  a past invoice or a static price table.

## 10. If the human asks to change something

Use this change protocol:

1. Restate the exact requested outcome and identify the impacted stack, template, runtime code, and
   data path.
2. Inspect the relevant CloudFormation template and its existing resource relationships.
3. Run local template validation and create a change set. Review replacements, deletions, IAM policy
   expansion, inbound network changes, public exposure, and stateful-resource retention.
4. Present the plan and wait for explicit approval before executing a change set, deploying, changing
   a database migration, or running a remote SSM command.
5. After deployment, verify stack completion, service health, logs, and the specific user-facing
   behavior changed.
6. Record the commit, deployment run, validation evidence, and rollback approach.

## Useful repository references

- [AWS deployment and operations](aws-deployment.md)
- [Task plan validation and live guidance design](task-plan-validation.md)
- [Local development and validation](local-development.md)
- [Compute CloudFormation template](../infrastructure/aws/compute-foundation.yaml)
- [Database CloudFormation template](../infrastructure/aws/database-foundation.yaml)
- [Public API CloudFormation template](../infrastructure/aws/public-api-foundation.yaml)
- [AWS deployment workflow](../.github/workflows/aws-deploy.yml)

## Suggested first prompt for the receiving agent

> Read `docs/aws-agent-walkthrough.md` first. Walk me through the MetaGlasses AWS environment in
> order, starting read-only. At each section, explain the service in plain language, show the safe
> command you intend to run, summarize the result, and wait for me before moving to the next major
> section. Never retrieve or print secret values, and do not make changes without my explicit
> approval for that exact action.
