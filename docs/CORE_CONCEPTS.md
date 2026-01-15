# Core Concepts

This document explains the fundamental concepts and patterns used throughout Tack. Understanding these will help you use the library effectively and debug issues when they arise.

## Table of Contents

- [Stacks](#stacks)
- [The Resource Pattern](#the-resource-pattern)
- [Core Types](#core-types)
- [Utility Functions](#utility-functions)
- [Global Constants](#global-constants)

---

## Stacks

Tack uses Pulumi stacks to determine environment-specific behavior. The stack name controls what resources are created and how they're configured.

### Stack Types

| Stack | Type | Description |
|-------|------|-------------|
| `development` | Local | Full DevPod workflow with file sync and port forwarding |
| `local-staging` | Local | Local cluster with production-like deployments |
| `staging` | Remote | AWS staging environment with CodeBuild CI/CD |
| `production` | Remote | AWS production environment with full redundancy |

### Local vs Remote Stacks

```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

// Check if current stack is local
if (isLocalStack(currentStack)) {
  // Uses Minikube, MinIO, in-cluster PostgreSQL
  console.log("Running on local infrastructure");
} else {
  // Uses EKS, S3, RDS
  console.log("Running on AWS infrastructure");
}
```

### Stack-Specific Behavior Table

| Component | development | local-staging | staging | production |
|-----------|-------------|---------------|---------|------------|
| Kubernetes | Minikube | Minikube | EKS | EKS |
| Object Storage | MinIO | MinIO | S3 | S3 |
| Database | K8s PostgreSQL | K8s PostgreSQL | RDS | RDS |
| Load Balancer | nginx | nginx | ALB | ALB |
| TLS Certificates | None | None | ACM | ACM |
| DNS | localhost | localhost | Cloudflare | Cloudflare |
| App Deployment | DevPod | Deployment | Deployment | Deployment |
| Build Method | Local Docker | Local Docker | CodeBuild | CodeBuild |

---

## The Resource Pattern

Tack uses a polymorphic `Resource<P, L>` base class to handle stack-specific implementations transparently.

### How It Works

Every Tack resource extends `Resource<P, L>` where:
- `P` = Production backing type (AWS resources)
- `L` = Local backing type (Kubernetes/mock resources)

```typescript
// Internal implementation (simplified)
abstract class Resource<P, L = {}> {
  protected stack: Stack;
  private _backing: L | P;

  constructor(backing: L | P) {
    this.stack = currentStack;
    this._backing = backing;
  }

  // Access the backing implementation
  backing(key: 'local'): L;
  backing(key: 'prod'): P;
  backing(key: 'local' | 'prod'): L | P {
    return this._backing;
  }
}
```

### Example: Bucket Class

```typescript
// Bucket uses different backing for local vs production
type AWSBucketBacking = { bucket: aws.s3.Bucket };

class Bucket extends Resource<AWSBucketBacking, {}> {
  public readonly name: pulumi.Output<string>;
  public readonly endpoint: pulumi.Output<string>;

  // Methods work the same regardless of backing
  addLifecycleRules(args) {
    // Only applies to S3, no-op for MinIO
    if (isLocalStack(this.stack)) return;

    addS3LifecycleRules(args.id, this.backing('prod').bucket, args.rules);
  }
}
```

### Accessing the Backing

When you need direct access to the underlying resource:

```typescript
const bucket = createBucket({
  id: "data",
  bucketName: "my-bucket",
  region: "us-east-1"
});

// Access the S3 bucket directly (production only)
if (!isLocalStack(currentStack)) {
  const s3Bucket = bucket.backing('prod').bucket;
  console.log(s3Bucket.arn);
}
```

### When to Use backing()

Use `backing()` when you need to:
- Access provider-specific properties not exposed on the class
- Integrate with other Pulumi resources directly
- Implement custom logic for one stack type

```typescript
// Example: Add a custom bucket policy (S3 only)
if (!isLocalStack(currentStack)) {
  new aws.s3.BucketPolicy("custom-policy", {
    bucket: bucket.backing('prod').bucket.id,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [/* ... */]
    })
  });
}
```

---

## Core Types

### Region

All supported AWS regions (excluding GovCloud):

```typescript
type Region =
  // US
  | 'us-east-1' | 'us-east-2' | 'us-west-1' | 'us-west-2'
  // Asia Pacific
  | 'ap-east-1' | 'ap-east-2'
  | 'ap-south-1' | 'ap-south-2'
  | 'ap-southeast-1' | 'ap-southeast-2' | 'ap-southeast-3' | 'ap-southeast-4' | 'ap-southeast-5' | 'ap-southeast-6' | 'ap-southeast-7'
  | 'ap-northeast-1' | 'ap-northeast-2' | 'ap-northeast-3'
  // Europe
  | 'eu-central-1' | 'eu-central-2'
  | 'eu-west-1' | 'eu-west-2' | 'eu-west-3'
  | 'eu-south-1' | 'eu-south-2'
  | 'eu-north-1'
  // Other
  | 'af-south-1'
  | 'ca-central-1' | 'ca-west-1'
  | 'il-central-1'
  | 'mx-central-1' | 'me-south-1' | 'me-central-1'
  | 'sa-east-1';
```

**Usage:**
```typescript
import { type Region } from "@sf-tensor/tack";

const region: Region = "us-east-1";  // Type-safe
const invalid: Region = "us-gov-west-1";  // Error: GovCloud not supported
```

### Stack

Valid stack names:

```typescript
type Stack = 'development' | 'local-staging' | 'staging' | 'production';
```

**Usage:**
```typescript
import { type Stack, currentStack } from "@sf-tensor/tack";

function getConfig(stack: Stack): Config {
  switch (stack) {
    case 'development':
      return devConfig;
    case 'production':
      return prodConfig;
    default:
      return defaultConfig;
  }
}
```

### ResourceArgs<T>

Standard wrapper for resource configuration:

```typescript
type ResourceArgs<T> = T & {
  id: string;                              // Unique resource identifier
  region: Region;                          // AWS region
  deps?: pulumi.Input<pulumi.Resource>[];  // Optional dependencies
};
```

**Usage:**
```typescript
import { type ResourceArgs } from "@sf-tensor/tack";

interface MyConfig {
  name: string;
  size: number;
}

function createMyResource(args: ResourceArgs<MyConfig>) {
  // args.id, args.region, args.deps are always available
  // args.name, args.size come from MyConfig
}
```

### Repository

GitHub repository reference:

```typescript
type Repository = {
  type: 'github';
  org: string;   // GitHub organization or username
  repo: string;  // Repository name
};
```

**Usage:**
```typescript
import { type Repository, getOrigin } from "@sf-tensor/tack";

const repo: Repository = {
  type: "github",
  org: "my-company",
  repo: "my-app"
};

console.log(getOrigin(repo));
// Output: git@github.com:my-company/my-app.git
```

---

## Utility Functions

### isLocalStack(stack)

Check if a stack is local (development or local-staging).

```typescript
function isLocalStack(stack: Stack): boolean
```

**Example:**
```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

if (isLocalStack(currentStack)) {
  // Skip production-only setup
  console.log("Skipping CloudWatch alarms for local stack");
}
```

### getOrigin(repo)

Convert a Repository to a git URL.

```typescript
function getOrigin(repo: Repository): string
```

**Example:**
```typescript
import { getOrigin } from "@sf-tensor/tack";

const url = getOrigin({
  type: "github",
  org: "anthropics",
  repo: "tack"
});
// Returns: "git@github.com:anthropics/tack.git"
```

### stackSwitch(config, default?)

Return stack-specific values based on current stack.

```typescript
function stackSwitch<T>(
  config: Partial<Record<Stack, T>>,
  default_?: T
): T
```

**Example:**
```typescript
import { stackSwitch } from "@sf-tensor/tack";

// Simple value switching
const instanceType = stackSwitch(
  {
    production: "m6gd.2xlarge",
    staging: "m6gd.large"
  },
  "m6gd.medium"  // Default for development/local-staging
);

// Complex object switching
const scalingConfig = stackSwitch(
  {
    production: { minSize: 3, maxSize: 20, desiredSize: 5 },
    staging: { minSize: 1, maxSize: 5, desiredSize: 2 }
  },
  { minSize: 1, maxSize: 2, desiredSize: 1 }
);

// Boolean switching
const enableDeletionProtection = stackSwitch(
  { production: true },
  false
);

// Array switching
const instanceTypes = stackSwitch(
  {
    production: ["m6gd.xlarge", "m6gd.2xlarge"],
    staging: ["m6gd.large"]
  },
  ["t3.medium"]
);
```

**Behavior:**
- Returns the value for the current stack if defined
- Falls back to the default if current stack not in config
- Throws if no match and no default provided

---

## Global Constants

### currentStack

The current Pulumi stack name cast to `Stack` type.

```typescript
import { currentStack } from "@sf-tensor/tack";

console.log(`Deploying to: ${currentStack}`);
// Output: "Deploying to: production"
```

### currentAccountId

The current AWS account ID as a Pulumi Output.

```typescript
import { currentAccountId } from "@sf-tensor/tack";

// Use in resource ARNs
const queueArn = pulumi.interpolate`arn:aws:sqs:us-east-1:${currentAccountId}:my-queue`;
```

### githubConnectorArn

The GitHub connection ARN from Pulumi config. Returns `'<invalid>'` for local stacks.

```typescript
import { githubConnectorArn, isLocalStack, currentStack } from "@sf-tensor/tack";

if (!isLocalStack(currentStack)) {
  console.log(`Using GitHub connection: ${githubConnectorArn}`);
}
```

---

## Pattern Examples

### Stack-Aware Resource Creation

```typescript
import {
  createBucket,
  createDatabaseInstance,
  isLocalStack,
  currentStack,
  stackSwitch
} from "@sf-tensor/tack";

// Resources automatically adapt to the stack
const bucket = createBucket({
  id: "data",
  bucketName: `myapp-${currentStack}`,  // Include stack in name
  region: "us-east-1"
});

// Use stackSwitch for different configurations
const db = createDatabaseInstance({
  id: "main-db",
  name: "main",
  instanceType: stackSwitch(
    {
      production: "db.r6g.xlarge",
      staging: "db.t4g.medium"
    },
    "db.t4g.micro"
  ),
  postgresVersion: "15",
  storageSize: stackSwitch(
    { production: 500, staging: 100 },
    20
  ),
  multiAz: stackSwitch({ production: true }, false),
  deletionProtection: currentStack === "production",
  // ... other config
});
```

### Conditional Logic Based on Stack

```typescript
import { isLocalStack, currentStack, stackSwitch } from "@sf-tensor/tack";

// Skip certain resources on local stacks
if (!isLocalStack(currentStack)) {
  // Create CloudWatch alarms
  new aws.cloudwatch.MetricAlarm("high-cpu", {
    // ...
  });

  // Create WAF rules
  new aws.wafv2.WebAcl("main-waf", {
    // ...
  });
}

// Different behavior based on stack
const logLevel = isLocalStack(currentStack) ? "debug" : "info";
const replicaCount = stackSwitch({ production: 3, staging: 2 }, 1);
```

### Accessing Backing Resources

```typescript
import { createCluster, isLocalStack, currentStack } from "@sf-tensor/tack";

const cluster = createCluster({
  // ... config
});

// Access production-only properties safely
if (!isLocalStack(currentStack)) {
  const eksCluster = cluster.backing('prod').cluster;

  // Use EKS-specific properties
  new aws.cloudwatch.MetricAlarm("cluster-cpu", {
    metricName: "cluster_failed_node_count",
    namespace: "ContainerInsights",
    dimensions: {
      ClusterName: eksCluster.eksCluster.name
    }
    // ...
  });
}

// The provider works on all stacks
const provider = cluster.provider;  // k8s.Provider
```

---

## Best Practices

### 1. Use stackSwitch for Configuration

Instead of complex if/else chains:

```typescript
// Bad
let instanceType: string;
if (currentStack === 'production') {
  instanceType = 'm6gd.2xlarge';
} else if (currentStack === 'staging') {
  instanceType = 'm6gd.large';
} else {
  instanceType = 'm6gd.medium';
}

// Good
const instanceType = stackSwitch(
  { production: 'm6gd.2xlarge', staging: 'm6gd.large' },
  'm6gd.medium'
);
```

### 2. Include Stack in Resource Names

Prevent naming collisions across stacks:

```typescript
// Good
const bucket = createBucket({
  id: "data",
  bucketName: `myapp-data-${currentStack}`,
  // ...
});
```

### 3. Guard Production-Only Code

```typescript
// Only add deletion protection in production
deletionProtection: currentStack === 'production',

// Only create expensive resources in production
if (!isLocalStack(currentStack)) {
  // Multi-AZ, read replicas, etc.
}
```

### 4. Use Type Annotations

```typescript
import { type Region, type Stack, type Repository } from "@sf-tensor/tack";

const region: Region = "us-east-1";
const repo: Repository = { type: "github", org: "my-org", repo: "my-app" };
```

---

## Related Documentation

- [Getting Started](./GETTING_STARTED.md) - First project setup
- [Networking](./NETWORKING.md) - VPC and subnet configuration
- [Cluster](./CLUSTER.md) - EKS cluster setup
- [Examples](./EXAMPLES.md) - Complete working examples
