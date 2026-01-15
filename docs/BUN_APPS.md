# Bun Apps

This document covers application deployment with `createBunApp` and related classes.

## Table of Contents

- [Overview](#overview)
- [createBunApp](#createbunapp)
- [BunApp Class](#bunapp-class)
- [Role Class](#role-class)
- [Environment Variables](#environment-variables)
- [Tasks](#tasks)
- [DevPod Configuration](#devpod-configuration)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's `bun` module deploys Bun and Next.js applications to Kubernetes. It handles stack-specific behavior automatically:

### Stack Behavior

| Stack | Deployment Type | Build Method | Features |
|-------|-----------------|--------------|----------|
| development | DevPod | Local Docker | File sync, port forwarding |
| local-staging | Deployment | Local Docker | Production-like deployment |
| staging | Deployment | CodeBuild | CI/CD pipeline |
| production | Deployment | CodeBuild | CI/CD pipeline, IAM roles |

---

## createBunApp

Creates a complete application deployment with service, deployment, tasks, and IAM role.

### Signature

```typescript
function createBunApp(args: ResourceArgs<BunAppConfig>): BunApp
```

### BunAppConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique app identifier |
| `region` | `Region` | Yes | AWS region |
| `runtime` | `'next' \| 'base'` | Yes | Application runtime |
| `localPath` | `string` | Yes | Local path to application code |
| `repository` | `Repository` | Yes | GitHub repository |
| `branch` | `string` | Yes | Git branch to deploy |
| `env` | `EnvEntry[]` | Yes | Environment variables |
| `ports` | `Port[]` | Yes | Container ports to expose |
| `healthRoute` | `HealthRoute` | No | Health check configuration |
| `tasks` | `Task[]` | No | Background tasks/jobs |
| `taskLabelKey` | `string` | No | Label key for tasks (default: `tack.dev/task-type`) |
| `npmrc` | `string` | No | Custom .npmrc content |
| `devPod` | `DevPodConfig` | No | DevPod configuration |
| `cluster` | `Cluster` | Yes | Target cluster |
| `deploymentManager` | `DeploymentManager` | Yes | CI/CD manager |
| `deps` | `pulumi.Resource[]` | No | Dependencies |

### Basic Example

```typescript
import {
  createCluster,
  createDeploymentManager,
  createBunApp,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const app = createBunApp({
  id: "web-app",
  region,
  runtime: "next",
  localPath: "../my-next-app",
  repository: { type: "github", org: "myorg", repo: "my-next-app" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: "production" }
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },

  cluster,
  deploymentManager
});
```

---

## BunApp Class

The `BunApp` class represents a deployed application with all its Kubernetes resources.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `service` | `k8s.core.v1.Service` | Kubernetes Service |
| `deployment` | `k8s.apps.v1.Deployment` | Kubernetes Deployment |
| `tasks` | `(Job \| CronJob)[]` | Task jobs/cronjobs |
| `taskNames` | `string[]` | Names of configured tasks |
| `role` | `Role` | IAM role wrapper |

### Example

```typescript
const app = createBunApp({ /* ... */ });

// Export service name for load balancer
export const serviceName = app.service.metadata.name;

// Export deployment name
export const deploymentName = app.deployment.metadata.name;

// Get task names
console.log(app.taskNames);  // ["migrate", "seed"]
```

---

## Role Class

The `Role` class wraps an IAM role and provides methods for attaching policies.

### Methods

#### arn()

Returns the IAM role ARN. Throws on local stacks.

```typescript
arn(): pulumi.Output<string>
```

**Example:**

```typescript
// Use in other IAM configurations
const roleArn = app.role.arn();
```

#### role()

Returns the underlying `aws.iam.Role`. Throws on local stacks.

```typescript
role(): aws.iam.Role
```

#### attachPolicy(name, statements)

Attaches an inline policy to the role. No-op on local stacks.

```typescript
attachPolicy(name: string, statements: aws.iam.PolicyStatement[]): void
```

**Example:**

```typescript
// Grant SQS access
app.role.attachPolicy("sqs-access", [{
  Effect: "Allow",
  Action: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage"],
  Resource: [queueArn]
}]);

// Grant SNS access
app.role.attachPolicy("sns-publish", [{
  Effect: "Allow",
  Action: ["sns:Publish"],
  Resource: [topicArn]
}]);

// Grant DynamoDB access
app.role.attachPolicy("dynamodb-access", [{
  Effect: "Allow",
  Action: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query"
  ],
  Resource: [tableArn, `${tableArn}/index/*`]
}]);
```

#### grantBucketAccess(buckets, access)

Grants S3 bucket access to the role. No-op on local stacks.

```typescript
grantBucketAccess(buckets: Bucket[], access: 'read-only' | 'read-write'): void
```

**Example:**

```typescript
const dataBucket = createBucket({ /* ... */ });
const logsBucket = createBucket({ /* ... */ });

// Read-only access to logs
app.role.grantBucketAccess([logsBucket], "read-only");

// Read-write access to data
app.role.grantBucketAccess([dataBucket], "read-write");
```

---

## Environment Variables

The `env` parameter accepts an array of `EnvEntry` objects with flexible value types.

### EnvEntry Types

#### 1. Plain String

Simple string value.

```typescript
{ name: "NODE_ENV", value: "production" }
```

#### 2. Value Object

Pulumi Output value.

```typescript
{
  name: "API_URL",
  value: { type: "value", value: apiEndpoint }  // pulumi.Output<string>
}
```

#### 3. Kubernetes Secret

Reference to a Kubernetes secret.

```typescript
{
  name: "DB_PASSWORD",
  value: {
    type: "secret",
    name: "db-credentials",  // K8s secret name
    key: "password"          // Key within secret
  }
}
```

#### 4. AWS Secrets Manager

Reference to AWS Secrets Manager secret.

```typescript
{
  name: "API_KEY",
  value: {
    type: "secret-arn",
    secretName: "prod/api-keys",  // Secret name in AWS
    key: "stripe"                 // Optional: specific key in JSON secret
  }
}
```

### isPublic Flag

Mark environment variables as available in CodeBuild:

```typescript
{
  name: "NPM_TOKEN",
  value: { type: "secret-arn", secretName: "npm/token" },
  isPublic: true  // Available during build
}
```

### Complete Environment Example

```typescript
const app = createBunApp({
  // ...
  env: [
    // Plain values
    { name: "NODE_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "info" },

    // Pulumi outputs
    { name: "API_URL", value: { type: "value", value: apiEndpoint } },
    { name: "REDIS_URL", value: { type: "value", value: redisUrl } },

    // Kubernetes secrets
    {
      name: "DB_PASSWORD",
      value: { type: "secret", name: "db-credentials", key: "password" }
    },

    // AWS Secrets Manager
    {
      name: "STRIPE_KEY",
      value: { type: "secret-arn", secretName: "prod/stripe", key: "secret_key" }
    },

    // Build-time secrets
    {
      name: "NPM_TOKEN",
      value: { type: "secret-arn", secretName: "npm/auth" },
      isPublic: true
    },

    // Bucket configuration (helper method)
    ...bucket.getEnvEntries("DATA")
  ]
});
```

---

## Tasks

Tasks are background jobs that run separately from the main application.

### Task Configuration

```typescript
interface Task {
  name: string;     // Task identifier
  command: string;  // Shell command to run
}
```

### Example

```typescript
const app = createBunApp({
  // ...
  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "node scripts/seed.js" },
    { name: "cleanup", command: "node scripts/cleanup.js" }
  ]
});
```

### Task Behavior by Stack

| Stack | Implementation | Trigger |
|-------|----------------|---------|
| development | Kubernetes Job | Manual |
| local-staging | Kubernetes Job | Manual |
| staging | Suspended CronJob | Deployment manager |
| production | Suspended CronJob | Deployment manager |

### Task Labeling

Tasks are labeled for the deployment manager to identify them:

```typescript
taskLabelKey: "tack.dev/task-type"  // default
// or
taskLabelKey: "my-org.com/task-type"  // custom
```

---

## DevPod Configuration

DevPod enables local development with file sync and port forwarding.

### DevPodConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `nodeModulesCacheSize` | `string` | `"5Gi"` | PVC size for node_modules |
| `ignorePatterns` | `string[]` | `[]` | File patterns to ignore during sync |
| `skipInit` | `boolean` | `false` | Skip automatic initialization |
| `initTimeoutMs` | `number` | `180000` | Init timeout in milliseconds |

### Example

```typescript
const app = createBunApp({
  // ...
  devPod: {
    nodeModulesCacheSize: "10Gi",
    ignorePatterns: [
      ".git",
      "node_modules",
      ".next",
      "*.log",
      ".env.local"
    ],
    skipInit: false,
    initTimeoutMs: 300000  // 5 minutes
  }
});
```

---

## Complete Examples

### Example 1: Simple Next.js App

```typescript
import {
  createCluster,
  createDeploymentManager,
  createBunApp,
  currentStack,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const app = createBunApp({
  id: "web",
  region,
  runtime: "next",
  localPath: "../web-app",
  repository: { type: "github", org: "myorg", repo: "web-app" },
  branch: stackSwitch({ production: "main" }, "develop"),

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    { name: "NEXT_PUBLIC_API_URL", value: "https://api.example.com" }
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },

  devPod: {
    nodeModulesCacheSize: "10Gi",
    ignorePatterns: [".git", "node_modules", ".next"]
  },

  cluster,
  deploymentManager
});
```

### Example 2: API with Database and Queue

```typescript
import {
  createCluster,
  createDeploymentManager,
  createBunApp,
  createDatabaseInstance,
  createBucket,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// Create resources
const db = createDatabaseInstance({ /* ... */ });
const appDb = db.createDatabase({ id: "app-db", name: "app", owner: appUser });
const bucket = createBucket({ id: "uploads", bucketName: "uploads", region });

// Create API app
const api = createBunApp({
  id: "api",
  region,
  runtime: "base",
  localPath: "../api-server",
  repository: { type: "github", org: "myorg", repo: "api" },
  branch: "main",

  env: [
    // Application config
    { name: "NODE_ENV", value: "production" },
    { name: "PORT", value: "3000" },

    // Database connection
    {
      name: "DATABASE_URL",
      value: { type: "value", value: appDb.connectionString }
    },

    // Bucket access
    ...bucket.getEnvEntries("UPLOADS"),

    // External API keys
    {
      name: "STRIPE_SECRET_KEY",
      value: { type: "secret-arn", secretName: "prod/stripe", key: "secret" }
    },
    {
      name: "SENDGRID_API_KEY",
      value: { type: "secret-arn", secretName: "prod/sendgrid" }
    }
  ],

  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "prisma db seed" }
  ],

  ports: [
    { name: "http", port: 3000 },
    { name: "metrics", port: 9090 }
  ],
  healthRoute: { path: "/health", port: 3000 },

  cluster,
  deploymentManager
});

// Grant permissions
api.role.grantBucketAccess([bucket], "read-write");

api.role.attachPolicy("sqs-access", [{
  Effect: "Allow",
  Action: ["sqs:*"],
  Resource: ["arn:aws:sqs:*:*:task-queue"]
}]);
```

### Example 3: Multi-Service Application

```typescript
// Frontend
const frontend = createBunApp({
  id: "frontend",
  runtime: "next",
  localPath: "../frontend",
  repository: { type: "github", org: "myorg", repo: "frontend" },
  branch: "main",
  env: [
    { name: "NEXT_PUBLIC_API_URL", value: "/api" }
  ],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },
  cluster,
  deploymentManager,
  region
});

// Backend API
const backend = createBunApp({
  id: "backend",
  runtime: "base",
  localPath: "../backend",
  repository: { type: "github", org: "myorg", repo: "backend" },
  branch: "main",
  env: [
    { name: "DATABASE_URL", value: { type: "value", value: db.connectionString } }
  ],
  ports: [{ name: "http", port: 4000 }],
  healthRoute: { path: "/health", port: 4000 },
  cluster,
  deploymentManager,
  region
});

// Background workers
const workers = createBunApp({
  id: "workers",
  runtime: "base",
  localPath: "../workers",
  repository: { type: "github", org: "myorg", repo: "workers" },
  branch: "main",
  env: [
    { name: "DATABASE_URL", value: { type: "value", value: db.connectionString } },
    { name: "QUEUE_URL", value: { type: "value", value: queueUrl } }
  ],
  tasks: [
    { name: "process-emails", command: "node jobs/emails.js" },
    { name: "process-reports", command: "node jobs/reports.js" },
    { name: "cleanup", command: "node jobs/cleanup.js" }
  ],
  ports: [{ name: "http", port: 5000 }],
  healthRoute: { path: "/health", port: 5000 },
  cluster,
  deploymentManager,
  region
});
```

### Example 4: App with Private NPM Registry

```typescript
import { generateNpmRc } from "@sf-tensor/tack";

const app = createBunApp({
  id: "app",
  runtime: "next",
  // ...

  // Custom .npmrc for private packages
  npmrc: generateNpmRc({
    registry: "https://npm.pkg.github.com",
    scope: "@myorg"
  }),

  env: [
    // NPM token for builds
    {
      name: "NPM_TOKEN",
      value: { type: "secret-arn", secretName: "npm/token" },
      isPublic: true  // Available in CodeBuild
    }
  ],

  cluster,
  deploymentManager,
  region
});
```

---

## Best Practices

### 1. Use Meaningful Task Names

```typescript
// Good
tasks: [
  { name: "migrate-db", command: "prisma migrate deploy" },
  { name: "send-reports", command: "node jobs/reports.js" }
]

// Bad
tasks: [
  { name: "task1", command: "..." },
  { name: "job", command: "..." }
]
```

### 2. Configure DevPod Ignore Patterns

```typescript
devPod: {
  ignorePatterns: [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "*.log",
    ".env.local"
  ]
}
```

### 3. Use Environment Prefixes for Buckets

```typescript
// Clear prefixes help identify sources
...dataBucket.getEnvEntries("DATA"),      // DATA_BUCKET, DATA_ENDPOINT
...logsBucket.getEnvEntries("LOGS"),      // LOGS_BUCKET, LOGS_ENDPOINT
...uploadsBucket.getEnvEntries("UPLOADS") // UPLOADS_BUCKET, UPLOADS_ENDPOINT
```

### 4. Separate Sensitive from Public Env Vars

```typescript
env: [
  // Public config
  { name: "NODE_ENV", value: "production" },
  { name: "LOG_LEVEL", value: "info" },

  // Secrets (not logged, handled specially)
  { name: "DB_PASSWORD", value: { type: "secret", name: "db", key: "password" } },
  { name: "API_KEY", value: { type: "secret-arn", secretName: "api-keys" } }
]
```

---

## Related Documentation

- [Cluster](./CLUSTER.md) - Cluster setup for app deployment
- [DevPod](./DEV_POD.md) - Local development workflow
- [CI/CD](./CICD.md) - Build pipeline configuration
- [Buckets](./BUCKETS.md) - Storage integration
- [Database](./DATABASE.md) - Database connections
- [Secrets](./SECRETS.md) - Secret management
