# IAM

This document covers IAM roles, policies, and the IRSA (IAM Roles for Service Accounts) pattern in Tack.

## Table of Contents

- [Overview](#overview)
- [createOidcRole](#createoidcrole)
- [BunApp Role Integration](#bunapp-role-integration)
- [IRSA Pattern](#irsa-pattern)
- [Complete Examples](#complete-examples)

---

## Overview

Tack uses IAM Roles for Service Accounts (IRSA) to provide AWS credentials to Kubernetes pods without managing long-lived credentials.

### Stack Behavior

| Stack | IAM Method |
|-------|------------|
| development | No AWS IAM (local services) |
| local-staging | No AWS IAM (local services) |
| staging | IRSA via EKS OIDC |
| production | IRSA via EKS OIDC |

---

## createOidcRole

Creates an IAM role that can be assumed by a Kubernetes service account.

### Signature

```typescript
function createOidcRole(args: {
  name: string;
  oidcProviderArn: pulumi.Input<string>;
  oidcProviderUrl: pulumi.Input<string>;
  namespace: string;
  serviceAccount: string;
}): aws.iam.Role
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | IAM role name |
| `oidcProviderArn` | `pulumi.Input<string>` | Yes | EKS OIDC provider ARN |
| `oidcProviderUrl` | `pulumi.Input<string>` | Yes | EKS OIDC provider URL |
| `namespace` | `string` | Yes | Kubernetes namespace |
| `serviceAccount` | `string` | Yes | Kubernetes service account name |

### Example

```typescript
import { createOidcRole, createCluster, isLocalStack, currentStack } from "@sf-tensor/tack";

const cluster = createCluster({ /* ... */ });

// Only create OIDC role on production stacks
if (!isLocalStack(currentStack)) {
  const role = createOidcRole({
    name: "my-service-role",
    oidcProviderArn: cluster.backing('prod').cluster.oidcProviderArn,
    oidcProviderUrl: cluster.backing('prod').cluster.oidcProviderUrl,
    namespace: "default",
    serviceAccount: "my-service"
  });

  // Attach policies to the role
  new aws.iam.RolePolicy("my-service-policy", {
    role: role.name,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: ["arn:aws:s3:::my-bucket/*"]
      }]
    })
  });
}
```

---

## BunApp Role Integration

When creating a BunApp, Tack automatically creates an associated IAM role with IRSA configured.

### The Role Class

```typescript
interface Role {
  // Attach a custom IAM policy
  attachPolicy(
    name: string,
    statements: PolicyStatement[]
  ): void;

  // Grant access to buckets
  grantBucketAccess(
    buckets: Bucket[],
    access: "read-only" | "read-write"
  ): void;
}

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string>>;
}
```

### Attaching Custom Policies

```typescript
import { createBunApp, createCluster, createDeploymentManager } from "@sf-tensor/tack";

const app = createBunApp({
  id: "my-app",
  // ... other config
  cluster,
  deploymentManager,
  region
});

// Attach a custom policy for SQS access
app.role.attachPolicy("sqs-access", [{
  Effect: "Allow",
  Action: [
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes"
  ],
  Resource: ["arn:aws:sqs:us-east-1:123456789:my-queue"]
}]);

// Attach policy for DynamoDB access
app.role.attachPolicy("dynamodb-access", [{
  Effect: "Allow",
  Action: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query"
  ],
  Resource: [
    "arn:aws:dynamodb:us-east-1:123456789:table/my-table",
    "arn:aws:dynamodb:us-east-1:123456789:table/my-table/index/*"
  ]
}]);
```

### Granting Bucket Access

```typescript
import { createBunApp, createBucket } from "@sf-tensor/tack";

const dataBucket = createBucket({
  id: "data",
  bucketName: "my-app-data",
  isPublic: false,
  region
});

const logsBucket = createBucket({
  id: "logs",
  bucketName: "my-app-logs",
  isPublic: false,
  region
});

const app = createBunApp({
  id: "my-app",
  // ... other config
});

// Grant read-write access to data bucket
app.role.grantBucketAccess([dataBucket], "read-write");

// Grant read-only access to logs bucket
app.role.grantBucketAccess([logsBucket], "read-only");
```

### Access Levels

| Access Level | S3 Actions Granted |
|--------------|-------------------|
| `read-only` | `s3:GetObject`, `s3:ListBucket` |
| `read-write` | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` |

---

## IRSA Pattern

IRSA (IAM Roles for Service Accounts) allows Kubernetes pods to assume IAM roles without long-lived credentials.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EKS CLUSTER                                    │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         APPLICATION POD                                │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                     Service Account                               │ │ │
│  │  │  - Name: my-app                                                   │ │ │
│  │  │  - Annotation: eks.amazonaws.com/role-arn: arn:aws:iam::...       │ │ │
│  │  └───────────────────────────────────────┬───────────────────────────┘ │ │
│  │                                          │                             │ │
│  │  ┌───────────────────────────────────────┼───────────────────────────┐ │ │
│  │  │                     Projected Token   │                           │ │ │
│  │  │  - Mounted at /var/run/secrets/eks.amazonaws.com/serviceaccount/  │ │ │
│  │  │  - Auto-rotated by Kubernetes                                     │ │ │
│  │  │  - Contains OIDC JWT token                                        │ │ │
│  │  └───────────────────────────────────────┼───────────────────────────┘ │ │
│  └──────────────────────────────────────────┼─────────────────────────────┘ │
│                                             │                               │
└─────────────────────────────────────────────┼───────────────────────────────┘
                                              │
                                              │ sts:AssumeRoleWithWebIdentity
                                              │
┌─────────────────────────────────────────────┼───────────────────────────────┐
│                              AWS IAM        │                               │
│                                             ▼                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         IAM Role                                       │ │
│  │  Trust Policy:                                                         │ │
│  │  {                                                                     │ │
│  │    "Principal": { "Federated": "<oidc-provider-arn>" },                │ │
│  │    "Condition": {                                                      │ │
│  │      "StringEquals": {                                                 │ │
│  │        "<oidc-url>:sub": "system:serviceaccount:default:my-app"        │ │
│  │      }                                                                 │ │
│  │    }                                                                   │ │
│  │  }                                                                     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Attached Policies                              │ │
│  │  - S3 access                                                           │ │
│  │  - SQS access                                                          │ │
│  │  - Secrets Manager access                                              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Trust Policy Structure

The `createOidcRole` function generates this trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC123"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.us-east-1.amazonaws.com/id/ABC123:sub": "system:serviceaccount:default:my-app",
        "oidc.eks.us-east-1.amazonaws.com/id/ABC123:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

### AWS SDK Usage in Pods

Inside the pod, AWS SDKs automatically:

1. Detect the projected service account token
2. Call `sts:AssumeRoleWithWebIdentity`
3. Use the temporary credentials

```typescript
// In your application code - no credentials needed!
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "us-east-1" });

// Credentials are automatically obtained via IRSA
const response = await s3.send(new GetObjectCommand({
  Bucket: "my-bucket",
  Key: "my-key"
}));
```

---

## Complete Examples

### Example 1: Application with Multiple AWS Services

```typescript
import {
  createCluster,
  createDeploymentManager,
  createBunApp,
  createBucket,
  type Region
} from "@sf-tensor/tack";
import * as pulumi from "@pulumi/pulumi";

const region: Region = "us-east-1";

// Infrastructure setup
const cluster = createCluster({ /* ... */ });
const deploymentManager = createDeploymentManager({ /* ... */ });

// Create buckets
const uploadsBucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${pulumi.getStack()}`,
  isPublic: false,
  region
});

const processedBucket = createBucket({
  id: "processed",
  bucketName: `myapp-processed-${pulumi.getStack()}`,
  isPublic: false,
  region
});

// Create application
const app = createBunApp({
  id: "processor",
  runtime: "base",
  localPath: "/path/to/app",
  repository: { type: "github", org: "myorg", repo: "processor" },
  branch: "main",
  env: [
    ...uploadsBucket.getEnvEntries("UPLOADS"),
    ...processedBucket.getEnvEntries("PROCESSED")
  ],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/health", port: 3000 },
  region,
  cluster,
  deploymentManager
});

// Grant bucket access
app.role.grantBucketAccess([uploadsBucket], "read-only");
app.role.grantBucketAccess([processedBucket], "read-write");

// Add SQS access for job queue
app.role.attachPolicy("sqs-jobs", [{
  Effect: "Allow",
  Action: [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
    "sqs:ChangeMessageVisibility"
  ],
  Resource: ["arn:aws:sqs:us-east-1:123456789:processing-jobs"]
}]);

// Add Secrets Manager access
app.role.attachPolicy("secrets-access", [{
  Effect: "Allow",
  Action: ["secretsmanager:GetSecretValue"],
  Resource: ["arn:aws:secretsmanager:us-east-1:123456789:secret:myapp/*"]
}]);
```

### Example 2: Custom OIDC Role for Non-BunApp Workloads

```typescript
import {
  createOidcRole,
  createCluster,
  isLocalStack,
  currentStack
} from "@sf-tensor/tack";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

const cluster = createCluster({ /* ... */ });

// Only on production stacks
if (!isLocalStack(currentStack)) {
  // Create IAM role
  const cronJobRole = createOidcRole({
    name: "data-cleanup-role",
    oidcProviderArn: cluster.backing('prod').cluster.oidcProviderArn,
    oidcProviderUrl: cluster.backing('prod').cluster.oidcProviderUrl,
    namespace: "batch-jobs",
    serviceAccount: "data-cleanup"
  });

  // Attach policy for S3 cleanup
  new aws.iam.RolePolicy("cleanup-policy", {
    role: cronJobRole.name,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "s3:ListBucket",
          "s3:DeleteObject"
        ],
        Resource: [
          "arn:aws:s3:::myapp-temp-*",
          "arn:aws:s3:::myapp-temp-*/*"
        ]
      }]
    })
  });

  // Create service account with role annotation
  new k8s.core.v1.ServiceAccount("data-cleanup-sa", {
    metadata: {
      name: "data-cleanup",
      namespace: "batch-jobs",
      annotations: {
        "eks.amazonaws.com/role-arn": cronJobRole.arn
      }
    }
  }, { provider: cluster.provider });

  // Create CronJob using the service account
  new k8s.batch.v1.CronJob("data-cleanup", {
    metadata: {
      name: "data-cleanup",
      namespace: "batch-jobs"
    },
    spec: {
      schedule: "0 2 * * *",  // Daily at 2 AM
      jobTemplate: {
        spec: {
          template: {
            spec: {
              serviceAccountName: "data-cleanup",
              containers: [{
                name: "cleanup",
                image: "myorg/cleanup-job:latest",
                command: ["node", "cleanup.js"]
              }],
              restartPolicy: "OnFailure"
            }
          }
        }
      }
    }
  }, { provider: cluster.provider });
}
```

### Example 3: Cross-Account Access

```typescript
import { createBunApp, isLocalStack, currentStack } from "@sf-tensor/tack";

const app = createBunApp({
  id: "cross-account-app",
  // ... other config
});

// Grant cross-account S3 access
if (!isLocalStack(currentStack)) {
  app.role.attachPolicy("cross-account-s3", [{
    Effect: "Allow",
    Action: ["sts:AssumeRole"],
    Resource: ["arn:aws:iam::999888777666:role/SharedDataRole"]
  }]);
}
```

Application code for cross-account access:

```typescript
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Step 1: Assume role in other account
const sts = new STSClient({ region: "us-east-1" });
const assumeRoleResponse = await sts.send(new AssumeRoleCommand({
  RoleArn: "arn:aws:iam::999888777666:role/SharedDataRole",
  RoleSessionName: "cross-account-session"
}));

// Step 2: Use temporary credentials
const s3 = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: assumeRoleResponse.Credentials!.AccessKeyId!,
    secretAccessKey: assumeRoleResponse.Credentials!.SecretAccessKey!,
    sessionToken: assumeRoleResponse.Credentials!.SessionToken!
  }
});

const data = await s3.send(new GetObjectCommand({
  Bucket: "other-account-bucket",
  Key: "shared-data.json"
}));
```

---

## Best Practices

### 1. Use Least Privilege

Grant only the permissions your application needs:

```typescript
// Good - specific actions and resources
app.role.attachPolicy("s3-access", [{
  Effect: "Allow",
  Action: ["s3:GetObject"],
  Resource: ["arn:aws:s3:::my-bucket/specific-prefix/*"]
}]);

// Avoid - overly broad permissions
app.role.attachPolicy("s3-access", [{
  Effect: "Allow",
  Action: ["s3:*"],
  Resource: ["*"]
}]);
```

### 2. Use Resource ARN Patterns

Be specific with resource ARNs:

```typescript
// Specific table and indexes
app.role.attachPolicy("dynamodb-access", [{
  Effect: "Allow",
  Action: ["dynamodb:Query", "dynamodb:GetItem"],
  Resource: [
    `arn:aws:dynamodb:${region}:*:table/MyTable`,
    `arn:aws:dynamodb:${region}:*:table/MyTable/index/GSI1`
  ]
}]);
```

### 3. Add Conditions Where Possible

Use conditions for additional security:

```typescript
app.role.attachPolicy("s3-secure", [{
  Effect: "Allow",
  Action: ["s3:PutObject"],
  Resource: ["arn:aws:s3:::my-bucket/*"],
  Condition: {
    StringEquals: {
      "s3:x-amz-server-side-encryption": "aws:kms"
    }
  }
}]);
```

### 4. Separate Policies by Service

Keep policies organized:

```typescript
// S3 access
app.role.attachPolicy("s3-access", [/* S3 statements */]);

// SQS access
app.role.attachPolicy("sqs-access", [/* SQS statements */]);

// Secrets Manager access
app.role.attachPolicy("secrets-access", [/* Secrets statements */]);
```

---

## Troubleshooting

### Pod Cannot Assume Role

**Check service account annotation:**
```bash
kubectl get sa my-app -o yaml
# Should have: eks.amazonaws.com/role-arn annotation
```

**Check role trust policy:**
```bash
aws iam get-role --role-name my-app-role
# Verify OIDC provider and service account in trust policy
```

### Access Denied Errors

**Check IAM policy:**
```bash
aws iam list-role-policies --role-name my-app-role
aws iam get-role-policy --role-name my-app-role --policy-name my-policy
```

**Enable CloudTrail for debugging:**
- Check CloudTrail for the exact API call that was denied
- Verify the action and resource match your policy

### Token Not Found

**Check projected volume:**
```bash
kubectl exec -it my-pod -- ls -la /var/run/secrets/eks.amazonaws.com/serviceaccount/
```

**Verify EKS OIDC provider:**
```bash
aws eks describe-cluster --name my-cluster --query "cluster.identity.oidc.issuer"
```

---

## Related Documentation

- [Bun Apps](./BUN_APPS.md) - Application role configuration
- [Cluster](./CLUSTER.md) - OIDC provider setup
- [Secrets](./SECRETS.md) - Secrets Manager access
