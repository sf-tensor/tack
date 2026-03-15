# CI/CD

This document covers CodeBuild, ECR, and deployment pipeline configuration in Tack.

## Table of Contents

- [Overview](#overview)
- [CodeBuild Projects](#codebuild-projects)
- [ECR Repositories](#ecr-repositories)
- [GitHub Integration](#github-integration)
- [Build Environment](#build-environment)
- [Troubleshooting](#troubleshooting)

---

## Overview

Tack's CI/CD module provides:

- **CodeBuild projects** for building container images
- **ECR repositories** for storing images
- **IAM roles** for secure build access
- **SQS integration** for deployment coordination

### Stack Behavior

| Stack | CI/CD Active | Build Method |
|-------|--------------|--------------|
| development | No | Local Docker |
| local-staging | No | Local Docker |
| staging | Yes | CodeBuild |
| production | Yes | CodeBuild |

---

## CodeBuild Projects

### App Build Project

Created for each `BunApp` to build application images.

**Features:**
- Triggered by GitHub push
- Builds a workload-specific Docker image from the repository
- Pushes to ECR
- Sends deployment task to SQS

When a Bun app defines `containers`, Tack creates one CodeBuild project per workload. Each project:

- Uses the same source repository and branch
- Passes the workload's `buildTask` into Docker as `BUILD_TASK`
- Pushes to that workload's own ECR repository
- Sends deployment messages for that workload's Deployment

**Build Phases:**

```yaml
phases:
  pre_build:
    commands:
      # Login to ECR
      - aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO_URL
      # Login to Docker Hub (for base images)
      - echo $DOCKER_PASSWORD | docker login -u $DOCKER_USERNAME --password-stdin

  build:
    commands:
      # Build workload image
      - docker build --build-arg BUILD_TASK="$BUILD_TASK" -t $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION .
      - docker push $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION
      - docker tag $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION $ECR_REPO_URL:latest
      - docker push $ECR_REPO_URL:latest

  post_build:
    commands:
      # Send deployment task to SQS
      - aws sqs send-message --queue-url $SQS_QUEUE_URL --message-body "$DEPLOY_MESSAGE"
```

### Manager Build Project

Builds the deployment manager service.

**Triggers:**
- Push to manager repository
- Manual trigger for initial deployment

---

## ECR Repositories

### Repository Structure

| Repository | Purpose |
|------------|---------|
| `{workload-id}-main` | Workload application images |
| `{workload-id}-tasks` | Task runner images (if tasks are defined on that workload) |
| `{manager-id}` | Deployment manager images |

### Image Tags

| Tag | Description |
|-----|-------------|
| `latest` | Most recent build |
| `{commit-sha}` | Specific commit |
| `{branch}-{sha}` | Branch-qualified tag |

### Repository Lifecycle

Repositories are configured with lifecycle policies:
- Keep last 10 untagged images
- Delete images older than 30 days

---

## GitHub Integration

### Connection Setup

1. **Create CodeStar Connection:**
   ```bash
   # Via AWS Console
   # Developer Tools → Connections → Create connection → GitHub
   ```

2. **Authorize GitHub App:**
   - Complete OAuth flow in browser
   - Grant access to repositories

3. **Configure in Pulumi:**
   ```bash
   pulumi config set githubConnectionArn arn:aws:codestar-connections:us-east-1:123456789:connection/abc-123
   ```

### Webhook Configuration

CodeBuild automatically configures webhooks:
- Push events trigger builds
- Branch filtering based on app configuration

### Branch Configuration

```typescript
const app = createBunApp({
  repository: { type: "github", org: "myorg", repo: "my-app" },
  branch: "main",  // Only builds from this branch trigger deployments
  // ...
});
```

---

## Build Environment

### Compute Type

Default: `BUILD_GENERAL1_SMALL` (3 GB memory, 2 vCPUs)

For larger builds, the instance type can be configured in the CodeBuild project.

### Environment Variables

#### Automatic Variables

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region |
| `ECR_REPO_URL` | ECR repository URL |
| `SQS_QUEUE_URL` | Deployment queue URL |
| `BUILD_TASK` | Bun build task for the current workload |
| `CODEBUILD_RESOLVED_SOURCE_VERSION` | Git commit SHA |

#### App-Defined Variables

Variables with `isPublic: true` are available in CodeBuild:

```typescript
const app = createBunApp({
  env: [
    // Not available in build (default)
    { name: "DATABASE_URL", value: dbUrl },

    // Available in build
    { name: "NPM_TOKEN", value: npmToken, isPublic: true },
    { name: "SENTRY_AUTH_TOKEN", value: sentryToken, isPublic: true }
  ]
});
```

#### Docker Credentials

Automatically added:
- `DOCKER_USERNAME` - From `docker/auth` secret
- `DOCKER_PASSWORD` - From `docker/auth` secret

**Setup required:**

```bash
aws secretsmanager create-secret \
  --name docker/auth \
  --secret-string '{"user":"your-dockerhub-user","password":"your-dockerhub-token"}'
```

---

## IAM Roles

### CodeBuild Role

Permissions:
- ECR push/pull
- SQS send message
- Secrets Manager access (for `isPublic` secrets)
- CloudWatch Logs

### Manager Pod Role

Permissions:
- SQS receive/delete message
- ECR pull (for verification)

Uses IRSA (IAM Roles for Service Accounts) for secure access.

---

## Build Configuration

### Custom Buildspec

For advanced use cases, create a `buildspec.yml` in your repository:

```yaml
version: 0.2

env:
  secrets-manager:
    NPM_TOKEN: npm/token

phases:
  install:
    runtime-versions:
      nodejs: 18
    commands:
      - npm ci

  pre_build:
    commands:
      - aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REPO_URL
      - npm run lint
      - npm run test

  build:
    commands:
      - npm run build
      - docker build -t $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION .
      - docker push $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION

  post_build:
    commands:
      - docker tag $ECR_REPO_URL:$CODEBUILD_RESOLVED_SOURCE_VERSION $ECR_REPO_URL:latest
      - docker push $ECR_REPO_URL:latest

cache:
  paths:
    - node_modules/**/*
    - .next/cache/**/*
```

### NPM Configuration

For private registries:

```typescript
import { generateNpmRc } from "@sf-tensor/tack";

const app = createBunApp({
  npmrc: generateNpmRc({
    registry: "https://npm.pkg.github.com",
    scope: "@myorg"
  }),
  env: [
    {
      name: "NPM_TOKEN",
      value: { type: "secret-arn", secretName: "npm/token" },
      isPublic: true
    }
  ]
});
```

---

## Build Caching

### Docker Layer Cache

Enable caching for faster builds:

```dockerfile
# Dockerfile
FROM node:18-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
CMD ["npm", "start"]
```

### CodeBuild Cache

Configure S3 cache in buildspec:

```yaml
cache:
  paths:
    - node_modules/**/*
    - .npm/**/*
```

---

## Troubleshooting

### Build Not Triggering

**Check webhook:**
```bash
# In GitHub repository settings → Webhooks
# Verify webhook is configured and delivering
```

**Check connection:**
```bash
# AWS Console → Developer Tools → Connections
# Ensure connection is "Available"
```

**Common issues:**
- Connection not authorized
- Branch filter not matching
- Webhook secret mismatch

### Build Failing

**Check logs:**
```bash
# AWS Console → CodeBuild → Build projects → Build history
# Or via CLI
aws codebuild list-builds-for-project --project-name my-app-codebuild
aws codebuild batch-get-builds --ids <build-id>
```

**Common issues:**

| Error | Cause | Solution |
|-------|-------|----------|
| ECR login failed | Permissions | Check CodeBuild role |
| Docker pull limit | Rate limiting | Add Docker Hub credentials |
| NPM install failed | Private packages | Configure NPM token |
| Out of memory | Large build | Increase compute type |

### Image Not Pushing

**Check ECR permissions:**
```bash
aws ecr describe-repositories --repository-names my-app-main
```

**Check IAM policy:**
```bash
aws iam get-role-policy --role-name my-app-codebuild-role --policy-name ecr-policy
```

### Deployment Not Happening

**Check SQS:**
```bash
aws sqs get-queue-attributes --queue-url <url> --attribute-names All
```

**Check message format:**
Verify the deployment message matches expected format.

---

## Monitoring

### CloudWatch Metrics

| Metric | Description |
|--------|-------------|
| `BuildsSucceeded` | Successful builds |
| `BuildsFailed` | Failed builds |
| `BuildDuration` | Build time |

### Alarms

Recommended alarms:
- Build failure rate > 20%
- Build duration > 15 minutes
- SQS queue depth > 10

---

## Best Practices

### 1. Use Multi-Stage Builds

```dockerfile
FROM node:18 AS builder
# Build stage

FROM node:18-alpine AS runner
# Minimal runtime image
```

### 2. Cache Dependencies

```yaml
cache:
  paths:
    - node_modules/**/*
```

### 3. Run Tests in Build

```yaml
phases:
  pre_build:
    commands:
      - npm test
```

### 4. Tag Images Properly

- Always push both `:latest` and `:commit-sha`
- Use branch-qualified tags for non-main branches

### 5. Monitor Build Times

Set up alerts for long-running builds.

---

## Related Documentation

- [Deployment Manager](./DEPLOYMENT_MANAGER.md) - Deployment orchestration
- [Bun Apps](./BUN_APPS.md) - Application configuration
- [IAM](./IAM.md) - Role configuration
