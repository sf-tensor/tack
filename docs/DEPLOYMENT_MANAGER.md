# Deployment Manager

The deployment manager is a companion service that coordinates build and deployment tasks for non-local stacks.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [createDeploymentManager](#createdeploymentmanager)
- [Components](#components)
- [Deployment Flow](#deployment-flow)
- [Task Management](#task-management)
- [Troubleshooting](#troubleshooting)

---

## Overview

The deployment manager handles CI/CD for staging and production stacks:

- Receives deployment tasks via SQS
- Updates Kubernetes deployments with new images
- Triggers task CronJobs
- Manages deployment state

### When Used

| Stack | Deployment Manager |
|-------|-------------------|
| development | Stub (no-op) |
| local-staging | Stub (no-op) |
| staging | Active |
| production | Active |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GITHUB                                         │
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │   Push to main  │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
└───────────┼─────────────────────────────────────────────────────────────────┘
            │ webhook
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS                                            │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         CODEBUILD                                      │ │
│  │  1. Clone repository                                                   │ │
│  │  2. Build Docker image                                                 │ │
│  │  3. Push to ECR                                                        │ │
│  │  4. Send task to SQS                                                   │ │
│  └───────────────────────────────────────────────────────────────┬────────┘ │
│                                                                  │          │
│  ┌───────────────────────────────────────────────────────────────┼────────┐ │
│  │                         ECR                                   │        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │        │ │
│  │  │ app:latest  │  │ app:v1.2.3  │  │ tasks:v1.2  │            │        │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘            │        │ │
│  └───────────────────────────────────────────────────────────────┼────────┘ │
│                                                                  │          │
│  ┌───────────────────────────────────────────────────────────────┼────────┐ │
│  │                         SQS                                   │        │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │        │ │
│  │  │ {"type": "deploy", "app": "web", "image": "..."}        │◄─┘        │ │
│  │  └───────────────────────────────────────────────────────┬─┘           │ │
│  └──────────────────────────────────────────────────────────┼─────────────┘ │
│                                                             │               │
└─────────────────────────────────────────────────────────────┼───────────────┘
                                                              │
                                                              │ poll
                                                              │
┌─────────────────────────────────────────────────────────────┼───────────────┐
│                         EKS CLUSTER                         │               │
│                                                             ▼               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    DEPLOYMENT MANAGER POD                              │ │
│  │  1. Receive SQS message                                                │ │
│  │  2. Update Deployment image                                            │ │
│  │  3. Trigger CronJobs if needed                                         │ │
│  │  4. Delete SQS message                                                 │ │
│  └───────────────────────────────────────────────────────────┬────────────┘ │
│                                                              │              │
│  ┌───────────────────────────────────────────────────────────┼────────────┐ │
│  │                    APP DEPLOYMENTS                        │            │ │
│  │                                                           │            │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │            │ │
│  │  │  web-app    │  │  api-app    │  │  workers    │◄───────┘            │ │
│  │  │ Deployment  │  │ Deployment  │  │ Deployment  │ (image update)      │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                     │ │
│  │                                                                        │ │
│  │  ┌─────────────┐  ┌─────────────┐                                      │ │
│  │  │   migrate   │  │   cleanup   │                                      │ │
│  │  │  CronJob    │  │  CronJob    │ (triggered on deploy)                │ │
│  │  └─────────────┘  └─────────────┘                                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## createDeploymentManager

Creates the deployment manager infrastructure.

### Signature

```typescript
function createDeploymentManager(args: ResourceArgs<DeploymentManagerConfig>): DeploymentManager
```

### DeploymentManagerConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier |
| `region` | `Region` | Yes | AWS region |
| `cluster` | `Cluster` | Yes | Target EKS cluster |
| `managerRepository` | `Repository` | Yes* | Manager source repo |
| `managerBranch` | `string` | No | Manager branch (default: `main`) |

*Required for non-local stacks

### Example

```typescript
import {
  createCluster,
  createDeploymentManager,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const cluster = createCluster({ /* ... */ });

const deploymentManager = createDeploymentManager({
  id: "cicd",
  region,
  cluster,
  managerRepository: {
    type: "github",
    org: "myorg",
    repo: "deployment-manager"
  },
  managerBranch: "main"
});
```

---

## Components

The deployment manager creates several AWS and Kubernetes resources.

### ECR Repositories

| Repository | Purpose |
|------------|---------|
| Manager ECR | Deployment manager container images |
| App Main ECR | Application container images |
| App Tasks ECR | Task runner container images (if tasks defined) |

### SQS Queue

- **Queue Name**: `{id}-deployment-queue`
- **Visibility Timeout**: 15 minutes (configurable)
- **Message Retention**: 4 days

### IAM Roles

| Role | Purpose | Principal |
|------|---------|-----------|
| CodeBuild Role | Build and push images | CodeBuild service |
| Manager Pod Role | K8s API access, SQS polling | Pod service account (OIDC) |

### CodeBuild Projects

| Project | Trigger | Purpose |
|---------|---------|---------|
| Manager Build | Push to manager repo | Build manager image |
| App Build | Push to app repo | Build app images |

### Manager Pod

Kubernetes Deployment running the manager service:
- Polls SQS for deployment tasks
- Updates Kubernetes resources
- Has IRSA for AWS access

---

## Deployment Flow

### 1. Code Push

Developer pushes to the application repository.

### 2. CodeBuild Triggered

GitHub webhook triggers CodeBuild project.

### 3. Build Process

CodeBuild executes:

```yaml
# Simplified buildspec
phases:
  pre_build:
    commands:
      - aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REPO
  build:
    commands:
      - docker build -t $ECR_REPO:$COMMIT_SHA .
      - docker push $ECR_REPO:$COMMIT_SHA
      - docker tag $ECR_REPO:$COMMIT_SHA $ECR_REPO:latest
      - docker push $ECR_REPO:latest
  post_build:
    commands:
      - aws sqs send-message --queue-url $SQS_URL --message-body '{"type":"deploy","image":"..."}'
```

### 4. SQS Message

CodeBuild sends deployment task to SQS:

```json
{
  "type": "deploy",
  "app": "web-app",
  "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/web-app:abc123",
  "tasks": ["migrate"],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 5. Manager Processing

Manager pod:
1. Receives message from SQS
2. Updates Deployment with new image
3. Triggers specified task CronJobs
4. Deletes SQS message on success

### 6. Deployment Complete

New pods roll out with the updated image.

---

## Task Management

### Task Labels

Tasks are identified by labels:

```typescript
// Default label key
taskLabelKey: "tack.dev/task-type"

// Custom label key
taskLabelKey: "myorg.com/task-type"
```

### Task CronJobs

In production, tasks are created as suspended CronJobs:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: web-app-migrate
  labels:
    tack.dev/task-type: migrate
spec:
  suspend: true  # Manager will unsuspend to run
  schedule: "0 0 * * *"  # Not actually scheduled
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: task
            image: app:latest
            command: ["prisma", "migrate", "deploy"]
```

### Triggering Tasks

When deployment includes tasks:

1. Manager finds CronJob by label
2. Creates a Job from CronJob template
3. Job runs to completion
4. Job is cleaned up automatically

---

## DeploymentManager Interface

### Methods

#### createBunAppDeployPipeline

Called internally when creating a BunApp to set up its CI/CD pipeline.

```typescript
interface DeploymentManager {
  createBunAppDeployPipeline(
    app: BunApp,
    args: ResourceArgs<BunAppConfig>,
    ecrRepos: EcrRepositories
  ): void;
}
```

---

## Configuration

### Environment Variables in CodeBuild

Apps can specify environment variables available during build:

```typescript
const app = createBunApp({
  env: [
    // Not available in CodeBuild (default)
    { name: "DATABASE_URL", value: dbUrl },

    // Available in CodeBuild
    { name: "NPM_TOKEN", value: npmToken, isPublic: true }
  ]
});
```

### Docker Credentials

Docker Hub credentials are automatically configured:

```typescript
// These are added automatically
{ name: "DOCKER_USERNAME", value: { type: "secret-arn", secretName: "docker/auth", key: "user" }, isPublic: true },
{ name: "DOCKER_PASSWORD", value: { type: "secret-arn", secretName: "docker/auth", key: "password" }, isPublic: true }
```

You must create the `docker/auth` secret in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name docker/auth \
  --secret-string '{"user":"dockerhub-username","password":"dockerhub-token"}'
```

---

## Troubleshooting

### Build Failing

**Check CodeBuild logs:**

```bash
# Via AWS Console
# CodeBuild → Build projects → Select project → Build history

# Or via CLI
aws codebuild list-builds-for-project --project-name my-app-codebuild
aws codebuild batch-get-builds --ids <build-id>
```

**Common issues:**
- Missing Docker credentials secret
- ECR permissions
- GitHub connection expired

### Deployment Not Updating

**Check SQS queue:**

```bash
aws sqs get-queue-attributes \
  --queue-url <queue-url> \
  --attribute-names ApproximateNumberOfMessages
```

**Check manager pod:**

```bash
kubectl logs -l app=cicd-manager -f
kubectl describe pod -l app=cicd-manager
```

**Common issues:**
- Manager pod not running
- SQS permissions
- Message format incorrect

### Tasks Not Running

**Check CronJob exists:**

```bash
kubectl get cronjob -l tack.dev/task-type=migrate
```

**Check Jobs:**

```bash
kubectl get jobs
kubectl logs job/<job-name>
```

**Common issues:**
- Wrong label key
- CronJob not created
- Image pull issues

---

## Manager Repository

You need to provide your own deployment manager implementation.

### Minimal Manager Example

```typescript
// manager/src/index.ts
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import * as k8s from "@kubernetes/client-node";

const sqs = new SQSClient({});
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const k8sApi = kc.makeApiClient(k8s.AppsV1Api);

async function processMessage(message: any) {
  const task = JSON.parse(message.Body);

  if (task.type === "deploy") {
    // Update deployment image
    await k8sApi.patchNamespacedDeployment(
      task.app,
      "default",
      [{
        op: "replace",
        path: "/spec/template/spec/containers/0/image",
        value: task.image
      }],
      undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/json-patch+json" } }
    );
  }
}

async function main() {
  while (true) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20
    }));

    for (const message of response.Messages || []) {
      await processMessage(message);
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle
      }));
    }
  }
}

main();
```

---

## Best Practices

### 1. Monitor SQS Queue

Set up CloudWatch alarms for:
- Queue depth (messages backing up)
- Message age (stuck messages)

### 2. Use Dead Letter Queue

Configure DLQ for failed messages:

```typescript
// Custom DLQ can be added to the queue configuration
```

### 3. Implement Retries

Manager should handle transient failures:
- Kubernetes API timeouts
- Image pull retries
- Pod scheduling delays

### 4. Log Everything

Comprehensive logging helps debug issues:
- Message received
- Action taken
- Result status

---

## Related Documentation

- [CI/CD](./CICD.md) - CodeBuild configuration
- [Bun Apps](./BUN_APPS.md) - Application deployment
- [IAM](./IAM.md) - Role configuration
