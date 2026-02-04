# Buckets

This document covers S3/MinIO bucket management in Tack.

## Table of Contents

- [Overview](#overview)
- [createBucket](#createbucket)
- [Bucket Class](#bucket-class)
- [Lifecycle Rules](#lifecycle-rules)
- [Integration Patterns](#integration-patterns)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's bucket module provides S3-compatible storage that works on both local and production stacks.

### Stack Behavior

| Stack | Implementation | Access Method |
|-------|----------------|---------------|
| development | MinIO (in-cluster) | Access key + secret |
| local-staging | MinIO (in-cluster) | Access key + secret |
| staging | S3 | IAM role (IRSA) |
| production | S3 | IAM role (IRSA) |

---

## createBucket

Creates a storage bucket (S3 or MinIO depending on stack).

### Signature

```typescript
function createBucket(args: ResourceArgs<BucketConfig>): Bucket
```

### BucketConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique bucket identifier |
| `region` | `Region` | Yes | AWS region |
| `bucketName` | `string` | Yes | Bucket name |
| `isPublic` | `boolean` | No | Public access (default: `false`) |

### Basic Example

```typescript
import { createBucket, currentStack, type Region } from "@sf-tensor/tack";

const region: Region = "us-east-1";

const bucket = createBucket({
  id: "data-bucket",
  bucketName: `myapp-data-${currentStack}`,
  isPublic: false,
  region
});
```

---

## Bucket Class

The `Bucket` class wraps storage with a unified interface.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `pulumi.Output<string>` | Bucket name |
| `endpoint` | `pulumi.Output<string>` | S3/MinIO endpoint URL |
| `accessKey` | `pulumi.Output<string> \| undefined` | Access key (MinIO only) |
| `secretKey` | `pulumi.Output<string> \| undefined` | Secret key (MinIO only) |

### Methods

#### getEnvVar()

Returns a JSON string with all bucket configuration.

```typescript
getEnvVar(): pulumi.Output<string>
```

**Returns:**
```json
{
  "name": "bucket-name",
  "endpoint": "https://s3.us-east-1.amazonaws.com",
  "accessKey": "...",    // MinIO only
  "secretKey": "..."     // MinIO only
}
```

**Example:**

```typescript
const bucket = createBucket({ /* ... */ });

// Use as single env var
const app = createBunApp({
  env: [
    { name: "BUCKET_CONFIG", value: { type: "value", value: bucket.getEnvVar() } }
  ]
});
```

#### getEnvEntries(prefix)

Returns individual environment entries for the bucket.

```typescript
getEnvEntries(prefix: string): EnvEntry[]
```

**Returns:**
```typescript
[
  { name: "PREFIX_BUCKET", value: { type: "value", value: "bucket-name" } },
  { name: "PREFIX_ENDPOINT", value: { type: "value", value: "https://..." } },
  { name: "PREFIX_ACCESS_KEY", value: { type: "value", value: "..." } },      // MinIO only
  { name: "PREFIX_SECRET_KEY", value: { type: "value", value: "..." } },      // MinIO only
  { name: "PREFIX_FORCE_PATH_STYLE", value: { type: "value", value: "true" }} // Local only
]
```

**Example:**

```typescript
const dataBucket = createBucket({ id: "data", /* ... */ });
const logsBucket = createBucket({ id: "logs", /* ... */ });

const app = createBunApp({
  env: [
    ...dataBucket.getEnvEntries("DATA"),   // DATA_BUCKET, DATA_ENDPOINT, etc.
    ...logsBucket.getEnvEntries("LOGS")    // LOGS_BUCKET, LOGS_ENDPOINT, etc.
  ]
});
```

#### addLifecycleRules(args)

Adds lifecycle rules to the bucket (S3 only, no-op on local).

```typescript
addLifecycleRules(args: {
  id: string;
  rules: LifecycleRule[];
}): void
```

---

## Lifecycle Rules

Lifecycle rules automate storage class transitions and expiration.

### LifecycleRule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Rule identifier |
| `filter` | `{ prefix: string }` | No | Filter by object prefix |
| `transitions` | `Transition[]` | Yes | Storage class transitions |

### Transition

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | `number` | Days after creation |
| `storageClass` | `StorageClass` | Target storage class |

### Storage Classes

| Class | Description | Use Case |
|-------|-------------|----------|
| `STANDARD_IA` | Infrequent Access | Data accessed < monthly |
| `ONEZONE_IA` | Single-AZ IA | Non-critical infrequent data |
| `INTELLIGENT_TIERING` | Auto-tiering | Unknown access patterns |
| `GLACIER` | Archive | Rarely accessed |
| `GLACIER_IR` | Glacier Instant Retrieval | Archive with fast access |
| `DEEP_ARCHIVE` | Long-term archive | Compliance, 7+ year retention |

### Example

```typescript
const bucket = createBucket({
  id: "data",
  bucketName: "myapp-data",
  region
});

bucket.addLifecycleRules({
  id: "data-lifecycle",
  rules: [
    // Archive old data
    {
      id: "archive-old-data",
      filter: { prefix: "data/" },
      transitions: [
        { days: 30, storageClass: "STANDARD_IA" },
        { days: 90, storageClass: "GLACIER" },
        { days: 365, storageClass: "DEEP_ARCHIVE" }
      ]
    },
    // Quick archive for logs
    {
      id: "archive-logs",
      filter: { prefix: "logs/" },
      transitions: [
        { days: 7, storageClass: "GLACIER" }
      ]
    },
    // Intelligent tiering for uploads
    {
      id: "uploads-tiering",
      filter: { prefix: "uploads/" },
      transitions: [
        { days: 30, storageClass: "INTELLIGENT_TIERING" }
      ]
    }
  ]
});
```

---

## Integration Patterns

### With BunApp

```typescript
const bucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${currentStack}`,
  region
});

const app = createBunApp({
  id: "app",
  env: [
    // Individual env vars
    ...bucket.getEnvEntries("UPLOADS")
  ],
  // ...
  cluster,
  deploymentManager,
  region
});

// Grant access via IAM
app.role.grantBucketAccess([bucket], "read-write");
```

### With Multiple Buckets

```typescript
// Different buckets for different purposes
const dataBucket = createBucket({
  id: "data",
  bucketName: `myapp-data-${currentStack}`,
  region
});

const uploadsBucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${currentStack}`,
  region
});

const logsBucket = createBucket({
  id: "logs",
  bucketName: `myapp-logs-${currentStack}`,
  region
});

// Add lifecycle rules
logsBucket.addLifecycleRules({
  id: "logs-archive",
  rules: [{
    id: "archive-old-logs",
    transitions: [
      { days: 30, storageClass: "GLACIER" }
    ]
  }]
});

const app = createBunApp({
  id: "app",
  env: [
    ...dataBucket.getEnvEntries("DATA"),
    ...uploadsBucket.getEnvEntries("UPLOADS"),
    ...logsBucket.getEnvEntries("LOGS")
  ],
  // ...
});

// Grant different access levels
app.role.grantBucketAccess([dataBucket, uploadsBucket], "read-write");
app.role.grantBucketAccess([logsBucket], "read-only");
```

### Accessing Bucket in Application

```typescript
// Node.js/Bun application code
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Read env vars set by Tack
const bucket = process.env.DATA_BUCKET;
const endpoint = process.env.DATA_ENDPOINT;
const accessKey = process.env.DATA_ACCESS_KEY;  // Only set in local
const secretKey = process.env.DATA_SECRET_KEY;  // Only set in local
const forcePathStyle = process.env.DATA_FORCE_PATH_STYLE === "true";

// Configure S3 client
const s3Client = new S3Client({
  endpoint: endpoint,
  region: process.env.AWS_REGION || "us-east-1",
  forcePathStyle: forcePathStyle,
  credentials: accessKey ? {
    accessKeyId: accessKey,
    secretAccessKey: secretKey!
  } : undefined  // Uses IAM role in production
});

// Upload file
await s3Client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: "path/to/file.txt",
  Body: "Hello, World!"
}));

// Download file
const response = await s3Client.send(new GetObjectCommand({
  Bucket: bucket,
  Key: "path/to/file.txt"
}));
const content = await response.Body?.transformToString();
```

---

## Complete Examples

### Example 1: Simple Data Bucket

```typescript
import {
  createBucket,
  createBunApp,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const dataBucket = createBucket({
  id: "data",
  bucketName: `myapp-data-${currentStack}`,
  isPublic: false,
  region
});

const app = createBunApp({
  id: "app",
  runtime: "next",
  env: [
    ...dataBucket.getEnvEntries("DATA")
  ],
  // ...
  cluster,
  deploymentManager,
  region
});

app.role.grantBucketAccess([dataBucket], "read-write");

export const bucketName = dataBucket.name;
export const bucketEndpoint = dataBucket.endpoint;
```

### Example 2: Multi-Tier Storage

```typescript
import {
  createBucket,
  createBunApp,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// Hot storage for active data
const hotBucket = createBucket({
  id: "hot",
  bucketName: `myapp-hot-${currentStack}`,
  region
});

// Warm storage for older data
const warmBucket = createBucket({
  id: "warm",
  bucketName: `myapp-warm-${currentStack}`,
  region
});

// Configure warm bucket lifecycle
warmBucket.addLifecycleRules({
  id: "warm-lifecycle",
  rules: [{
    id: "transition-to-ia",
    transitions: [
      { days: 30, storageClass: "STANDARD_IA" },
      { days: 90, storageClass: "GLACIER_IR" }
    ]
  }]
});

// Archive storage
const archiveBucket = createBucket({
  id: "archive",
  bucketName: `myapp-archive-${currentStack}`,
  region
});

archiveBucket.addLifecycleRules({
  id: "archive-lifecycle",
  rules: [{
    id: "deep-archive",
    transitions: [
      { days: 1, storageClass: "DEEP_ARCHIVE" }
    ]
  }]
});

const app = createBunApp({
  id: "app",
  env: [
    ...hotBucket.getEnvEntries("HOT"),
    ...warmBucket.getEnvEntries("WARM"),
    ...archiveBucket.getEnvEntries("ARCHIVE")
  ],
  // ...
});

app.role.grantBucketAccess([hotBucket], "read-write");
app.role.grantBucketAccess([warmBucket], "read-write");
app.role.grantBucketAccess([archiveBucket], "read-write");
```

### Example 3: Public Assets Bucket

```typescript
import {
  createBucket,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// Public bucket for static assets
const assetsBucket = createBucket({
  id: "assets",
  bucketName: `myapp-assets-${currentStack}`,
  isPublic: true,  // Publicly accessible
  region
});

// Private bucket for user uploads
const uploadsBucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${currentStack}`,
  isPublic: false,
  region
});

const app = createBunApp({
  id: "app",
  env: [
    ...assetsBucket.getEnvEntries("ASSETS"),
    ...uploadsBucket.getEnvEntries("UPLOADS")
  ],
  // ...
});

// Only need write access to private bucket
app.role.grantBucketAccess([uploadsBucket], "read-write");
// Public bucket accessed directly via URL
```

---

## Best Practices

### 1. Include Stack Name in Bucket Names

```typescript
// Prevents naming collisions across stacks
bucketName: `myapp-data-${currentStack}`
```

### 2. Use Lifecycle Rules for Cost Optimization

```typescript
bucket.addLifecycleRules({
  id: "cost-optimization",
  rules: [
    {
      id: "standard-to-ia",
      transitions: [
        { days: 30, storageClass: "STANDARD_IA" }
      ]
    }
  ]
});
```

### 3. Separate Buckets by Purpose

```typescript
// Good: Clear separation
const dataBucket = createBucket({ bucketName: "myapp-data-..." });
const logsBucket = createBucket({ bucketName: "myapp-logs-..." });
const backupsBucket = createBucket({ bucketName: "myapp-backups-..." });

// Bad: Everything in one bucket
const bucket = createBucket({ bucketName: "myapp-..." });
```

### 4. Use Descriptive Prefixes

```typescript
// Clear prefixes in app environment
...bucket.getEnvEntries("UPLOADS")  // UPLOADS_BUCKET, UPLOADS_ENDPOINT
...bucket.getEnvEntries("DATA")     // DATA_BUCKET, DATA_ENDPOINT
```

### 5. Grant Minimum Required Access

```typescript
// Read-only when possible
app.role.grantBucketAccess([logsBucket], "read-only");

// Read-write only when needed
app.role.grantBucketAccess([uploadsBucket], "read-write");
```

---

## Local Development

On local stacks, buckets are backed by MinIO running in-cluster.

### Accessing MinIO

```bash
# Port forward MinIO
kubectl port-forward svc/minio 9000:9000

# Access MinIO Console (if enabled)
kubectl port-forward svc/minio-console 9001:9001
```

### MinIO Credentials

Local buckets include `accessKey` and `secretKey` which are required for MinIO authentication. On production stacks, these are `undefined` as S3 uses IAM roles.

```typescript
// Application code handles both cases
const credentials = accessKey ? {
  accessKeyId: accessKey,
  secretAccessKey: secretKey!
} : undefined;  // Uses IAM role
```

---

## Related Documentation

- [Bun Apps](./BUN_APPS.md) - Using buckets with applications
- [IAM](./IAM.md) - Bucket access permissions
- [Core Concepts](./CORE_CONCEPTS.md) - Stack-aware patterns
