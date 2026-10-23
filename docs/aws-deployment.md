# AWS deployment and operations

MetaGlasses currently uses one AWS environment in `us-east-1`. No application data was migrated
from Supabase: the Aurora database starts empty and the AWS Cognito user pool starts with no users.

## Architecture

```text
client HTTPS
  -> API Gateway execute-api URL
  -> VPC Link
  -> internal Application Load Balancer
  -> EC2 Deno container
  -> Aurora PostgreSQL, Cognito, S3, Secrets Manager
```

Only API Gateway is internet-facing. The load balancer, EC2 instance, Aurora cluster, S3 bucket,
and NVIDIA credential remain private. The default AWS URL avoids buying a domain or managing an
ACM certificate.

## Stack map

| Stack | Purpose |
| --- | --- |
| `metaglasses-auth` | Cognito user pool and mobile app client |
| `metaglasses-storage` | Private pairing-image S3 bucket |
| `metaglasses-database` | VPC, Aurora PostgreSQL, and database security group |
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

## Deploy application code

Pushing a merged commit to `main` triggers `.github/workflows/aws-deploy.yml`.

1. GitHub Actions assumes the AWS deploy role through OIDC. No static AWS key is stored in GitHub.
2. The workflow builds the Deno container and pushes an immutable commit-SHA tag to ECR.
3. It sends an SSM command to EC2 to pull and start that image.
4. The container listens on port 8000. The EC2 security group accepts that port only from the
   internal ALB.
5. The workflow checks `http://127.0.0.1:8000/healthz` on EC2 and fails if the container does not
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

## Operational gap

CloudFormation stack events provide deployment history, but this AWS account currently has no
CloudTrail trail. Create an organization-appropriate CloudTrail trail before treating this as a
production audit record.
