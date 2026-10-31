# AWS deployment and operations

MetaGlasses currently uses one AWS environment in `us-east-1`. No application data was migrated
from Supabase: the RDS PostgreSQL database starts empty and the AWS Cognito user pool starts with
no users.

## Architecture

```text
client HTTPS
  -> API Gateway execute-api URL
  -> VPC Link
  -> internal Application Load Balancer
  -> EC2 Deno container
  -> RDS PostgreSQL, Cognito, S3, Secrets Manager
```

Only API Gateway is internet-facing. The load balancer, EC2 instance, RDS instance, S3 bucket,
and NVIDIA credential remain private. The default AWS URL avoids buying a domain or managing an
ACM certificate.

## Stack map

| Stack | Purpose |
| --- | --- |
| `metaglasses-auth` | Cognito user pool and mobile app client |
| `metaglasses-storage` | Private pairing-image S3 bucket |
| `metaglasses-database` | VPC, private RDS PostgreSQL, and database security group |
| `metaglasses-compute` | EC2, ECR, SSM, runtime IAM role, and GitHub OIDC deploy role |
| `metaglasses-public-api` | API Gateway, VPC Link, internal ALB, private subnets, and API access logs |

## Authenticate the AWS CLI

```bash
aws sso login --profile PowerUserAccess-995342110760
aws sts get-caller-identity --profile PowerUserAccess-995342110760
```

The first command opens the configured AWS IAM Identity Center sign-in page. The second confirms
which account and role the CLI session can use.

## Public API URL

Retrieve the current URL without storing it in source code:

```bash
aws cloudformation describe-stacks \
  --stack-name metaglasses-public-api \
  --region us-east-1 \
  --profile PowerUserAccess-995342110760 \
  --query 'Stacks[0].Outputs[?OutputKey==`HttpApiUrl`].OutputValue' \
  --output text
```

Validate it:

```bash
curl --fail "$(aws cloudformation describe-stacks \
  --stack-name metaglasses-public-api \
  --region us-east-1 \
  --profile PowerUserAccess-995342110760 \
  --query 'Stacks[0].Outputs[?OutputKey==`HttpApiUrl`].OutputValue' \
  --output text)/healthz"
```

The response is JSON with `status: ok`, `environment: aws`, and `auth: required`.

## Deploy infrastructure

All infrastructure is CloudFormation in `infrastructure/aws/`. Validate a template before
creating a change set:

```bash
aws cloudformation validate-template \
  --template-body file://infrastructure/aws/public-api-foundation.yaml \
  --region us-east-1 \
  --profile PowerUserAccess-995342110760
```

The public API stack consumes IDs from the existing database and compute stacks. Use a change set
for any update so the planned AWS resource changes can be inspected before execution.

## Database bootstrap and access

The RDS instance is a single-AZ `db.t4g.micro` PostgreSQL 17.9 instance with 20 GiB gp3 storage,
seven-day backups, encryption, deletion protection, and no public endpoint. The API authenticates
as `metaglasses_api` with short-lived IAM database tokens. It has no direct table access: it can
only execute the application functions in the private `app` schema and read the migration ledger.
The deployment runs the pinned migration container before replacing the healthy API container. A
migration failure leaves the existing API running and prevents the new image from being selected.

The one-time bootstrap scripts in `database/bootstrap/` create that role and a separate
`metaglasses_migrator` role. The migrator can create objects only in `app`, write the migration
ledger, and has the narrow pairing-table privileges needed to own task-plan security-definer
functions (select, update and references on `app.pairings`, and select on `app.pairing_images`). It cannot access the public schema. Run bootstrap scripts in numeric order with the
database administrator before enabling automatic deployments. `database/migrations/0001_initial.sql`
is the AWS-native schema used by the API; it does not depend on Supabase Auth, Storage, or
extensions.

## Deploy application code

Pushing a merged commit to `main` triggers `.github/workflows/aws-deploy.yml`.

1. GitHub Actions assumes the AWS deploy role through OIDC. No static AWS key is stored in GitHub.
2. The workflow builds the Deno container and pushes an immutable commit-SHA tag to ECR.
3. It sends an SSM command to EC2 to pull the image and apply unapplied migrations as the separate
   IAM-authenticated migrator role. A migration failure leaves the previous API container running.
4. It starts that image after the migration succeeds.
5. The container listens on port 8000. The EC2 security group accepts that port only from the
   internal ALB.
6. The workflow checks `http://127.0.0.1:8000/healthz` on EC2 and fails if the container does not
   become healthy.

The workflow needs the GitHub repository variable `METAGLASSES_AWS_DEPLOY_ROLE_ARN`, set to the
`GitHubDeployRoleArn` output of `metaglasses-compute`.

## Request time limit

API Gateway HTTP APIs allow at most 30 seconds for a backend response. In AWS, NVIDIA and
bring-your-own-provider requests stop after 20 seconds, leaving time for the application to return
a normal safe error response. Local development retains the five-minute provider timeout.

## Console validation

1. Open **CloudFormation**, choose `metaglasses-public-api`, then select **Outputs** for the URL.
2. Open **API Gateway**, choose the HTTP API, then **Stages** and `$default` to inspect access-log
   configuration.
3. Open **EC2**, choose **Load Balancers**, select the internal MetaGlasses ALB, then inspect the
   **Target groups** tab. The EC2 target must be `healthy`.
4. Open **CloudWatch**, choose **Log groups**, and open the `metaglasses-public-api-HttpApiAccessLogs-*`
   group to view API status and latency records. Request bodies, authorization headers, and query
   strings are not logged there.

## Audit logging

The `metaglasses-audit` stack creates a multi-Region CloudTrail that records all AWS management
events, such as CloudFormation deployments, security-group changes, and IAM or Secrets Manager
configuration actions. It writes those records to a private, encrypted, versioned S3 bucket for
one year and enables log-file validation, which helps detect missing or modified log files.

It intentionally does not capture high-volume data events, such as individual S3 object reads and
writes. Those events have separate costs and can contain more operational detail, so enable them
only after an explicit cost and privacy review. Application request status and latency remain in
the API Gateway CloudWatch access log group.

To validate the trail in the AWS console, open **CloudTrail** in `us-east-1`, choose **Trails**,
and open `metaglasses-audit-trail`. Confirm that logging is on, multi-Region trail is enabled, and
log file validation is enabled. Choose its S3 bucket link to view delivered log objects. Initial
log delivery can take several minutes; validation digest files can take up to about one hour.
