# Secrets

This document covers secret management in Tack, including local development secrets, AWS Secrets Manager, and Kubernetes secrets.

## Table of Contents

- [Overview](#overview)
- [Secret Types](#secret-types)
- [Local Secrets](#local-secrets)
- [AWS Secrets Manager](#aws-secrets-manager)
- [Kubernetes Secrets](#kubernetes-secrets)
- [Environment Variable Integration](#environment-variable-integration)
- [Best Practices](#best-practices)

---

## Overview

Tack supports three types of secrets:

| Type | Use Case | Storage |
|------|----------|---------|
| Local file | Local development | `.secrets` file |
| AWS Secrets Manager | Production | AWS Secrets Manager service |
| Kubernetes secrets | All stacks | Kubernetes Secret resources |

### Stack Behavior

| Stack | Secret Source |
|-------|--------------|
| development | `.secrets` file (converted to K8s secrets) |
| local-staging | `.secrets` file (converted to K8s secrets) |
| staging | AWS Secrets Manager |
| production | AWS Secrets Manager |

---

## Secret Types

### EnvEntry Secret Types

In `BunAppConfig.env`, secrets can be specified using different types:

```typescript
interface EnvEntry {
  name: string;
  value: string | EnvValue;
  isPublic?: boolean;  // Available in CodeBuild if true
}

// Plain string value
type EnvValue =
  | string
  | { type: "value"; value: pulumi.Input<string> }
  // Kubernetes secret reference
  | { type: "secret"; name: string; key: string }
  // AWS Secrets Manager reference
  | { type: "secret-arn"; secretName: pulumi.Input<string>; key?: string };
```

---

## Local Secrets

### The .secrets File

For local development, Tack reads secrets from a `.secrets` file.

**File Format:**
```
# Lines starting with # are comments
secretName:value
secretName:{"key1":"value1","key2":"value2"}
```

**Example `.secrets` file:**
```
# Database credentials
staging/db/credentials:{"username":"postgres","password":"localdevpassword"}

# API keys
staging/stripe-key:{"secret_key":"sk_test_xxx","publishable_key":"pk_test_xxx"}

# Simple values
staging/jwt-secret:my-local-jwt-secret-key
```

### readSecretsFile

Reads and parses the `.secrets` file.

```typescript
import { readSecretsFile } from "@sf-tensor/tack";

// Default path: .secrets in current directory
const secrets = readSecretsFile();

// Custom path
const secrets = readSecretsFile("/path/to/.secrets");

// Returns Map<string, ParsedSecret>
interface ParsedSecret {
  secretName: string;
  value: string;  // Raw string value
  parsedValue: Record<string, string> | string;  // JSON parsed or string
}
```

### createLocalSecretsForApp

Creates Kubernetes secrets from the `.secrets` file for local development.

```typescript
import { createLocalSecretsForApp, type NativeSecretEnvEntry } from "@sf-tensor/tack";

// This is typically called automatically by createBunApp
// when running on local stacks

createLocalSecretsForApp({
  id: "my-app",
  nativeSecrets: [
    { secretName: "staging/db/credentials", key: "password" },
    { secretName: "staging/stripe-key", key: "secret_key" }
  ],
  cluster,
  namespace: "default"  // optional, defaults to "default"
});
```

### How Local Secrets Work

1. When creating a BunApp with `secret-arn` env entries on local stacks
2. Tack reads the `.secrets` file
3. Creates a Kubernetes Secret with the values
4. The pod mounts this secret like AWS Secrets would work

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LOCAL STACK                                       │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        .secrets FILE                                   │ │
│  │  staging/db/credentials:{"username":"pg","password":"secret"}          │ │
│  └───────────────────────────────────────┬────────────────────────────────┘ │
│                                          │                                  │
│                                          │ readSecretsFile()                │
│                                          ▼                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     createLocalSecretsForApp()                         │ │
│  │  - Parses secrets                                                      │ │
│  │  - Creates K8s Secret resource                                         │ │
│  └───────────────────────────────────────┬────────────────────────────────┘ │
│                                          │                                  │
│                                          ▼                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     Kubernetes Secret                                  │ │
│  │  name: my-app-aws-secrets                                              │ │
│  │  data:                                                                 │ │
│  │    staging_db_credentials_password: secret                             │ │
│  └───────────────────────────────────────┬────────────────────────────────┘ │
│                                          │                                  │
│                                          │ Volume mount                     │
│                                          ▼                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                          POD                                           │ │
│  │  env:                                                                  │ │
│  │    - name: DB_PASSWORD                                                 │ │
│  │      valueFrom:                                                        │ │
│  │        secretKeyRef:                                                   │ │
│  │          name: my-app-aws-secrets                                      │ │
│  │          key: staging_db_credentials_password                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## AWS Secrets Manager

### Creating Secrets in AWS

Before using secrets, create them in AWS Secrets Manager:

```bash
# Create a JSON secret
aws secretsmanager create-secret \
  --name "myapp/database" \
  --secret-string '{"username":"admin","password":"secretpassword123"}'

# Create a plain string secret
aws secretsmanager create-secret \
  --name "myapp/api-key" \
  --secret-string "sk_live_xxxxxxxxxxxxx"
```

### Referencing in BunApp

```typescript
const app = createBunApp({
  id: "my-app",
  env: [
    // Reference a specific key from JSON secret
    {
      name: "DB_PASSWORD",
      value: {
        type: "secret-arn",
        secretName: "myapp/database",
        key: "password"
      }
    },

    // Reference entire secret (if plain string)
    {
      name: "API_KEY",
      value: {
        type: "secret-arn",
        secretName: "myapp/api-key"
      }
    },

    // Make secret available in CodeBuild too
    {
      name: "NPM_TOKEN",
      value: {
        type: "secret-arn",
        secretName: "npm/token"
      },
      isPublic: true  // Available during build
    }
  ],
  // ... other config
});
```

### How AWS Secrets Work

On production stacks, Tack uses the CSI Secrets Store driver with AWS Secrets Manager provider:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AWS CLOUD                                          │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     AWS Secrets Manager                                  ││
│  │  myapp/database: {"username":"admin","password":"xxx"}                   ││
│  └───────────────────────────────────────┬─────────────────────────────────┘│
│                                          │                                  │
└──────────────────────────────────────────┼──────────────────────────────────┘
                                           │
                                           │ secretsmanager:GetSecretValue
                                           │
┌──────────────────────────────────────────┼───────────────────────────────────┐
│                           EKS CLUSTER    │                                   │
│                                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                 CSI Secrets Store Driver                                │ │
│  │  - AWS Secrets Manager Provider                                         │ │
│  │  - Syncs secrets to pod volumes                                         │ │
│  └───────────────────────────────────────┬─────────────────────────────────┘ │
│                                          │                                   │
│                                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                     SecretProviderClass                                 │ │
│  │  name: my-app-secrets                                                   │ │
│  │  spec:                                                                  │ │
│  │    provider: aws                                                        │ │
│  │    parameters:                                                          │ │ 
│  │      objects: |                                                         │ │
│  │        - objectName: "myapp/database"                                   │ │
│  │          jmesPath:                                                      │ │
│  │            - path: password                                             │ │
│  │              objectAlias: db_password                                   │ │
│  └───────────────────────────────────────┬─────────────────────────────────┘ │
│                                          │                                   │
│                                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          POD                                            │ │
│  │  volumes:                                                               │ │
│  │    - name: secrets-store                                                │ │
│  │      csi:                                                               │ │
│  │        driver: secrets-store.csi.k8s.io                                 │ │
│  │        volumeAttributes:                                                │ │
│  │          secretProviderClass: my-app-secrets                            │ │
│  │                                                                         │ │
│  │  env:                                                                   │ │
│  │    - name: DB_PASSWORD                                                  │ │
│  │      valueFrom:                                                         │ │
│  │        secretKeyRef:                                                    │ │
│  │          name: my-app-aws-secrets                                       │ │
│  │          key: db_password                                               │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Docker Hub Credentials

For CodeBuild to pull private base images, create Docker Hub credentials:

```bash
aws secretsmanager create-secret \
  --name "docker/auth" \
  --secret-string '{"user":"your-dockerhub-username","password":"your-dockerhub-token"}'
```

These are automatically used by CodeBuild for Docker authentication.

---

## Kubernetes Secrets

### Direct Kubernetes Secret Reference

Reference existing Kubernetes secrets in your app:

```typescript
const app = createBunApp({
  id: "my-app",
  env: [
    {
      name: "REDIS_PASSWORD",
      value: {
        type: "secret",
        name: "redis-credentials",  // K8s secret name
        key: "password"             // Key within the secret
      }
    }
  ],
  // ... other config
});
```

### Creating Kubernetes Secrets Manually

```typescript
import * as k8s from "@pulumi/kubernetes";

const redisSecret = new k8s.core.v1.Secret("redis-credentials", {
  metadata: {
    name: "redis-credentials",
    namespace: "default"
  },
  stringData: {
    password: "my-redis-password",
    host: "redis.default.svc.cluster.local"
  }
}, { provider: cluster.provider });

// Reference in BunApp
const app = createBunApp({
  id: "my-app",
  env: [
    {
      name: "REDIS_PASSWORD",
      value: { type: "secret", name: "redis-credentials", key: "password" }
    }
  ],
  // ...
});
```

---

## Environment Variable Integration

### Complete Example

```typescript
import {
  createBunApp,
  createBucket,
  createDatabaseInstance,
  stackSwitch,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// Create resources
const bucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${currentStack}`,
  isPublic: false,
  region
});

const db = createDatabaseInstance({
  id: "main-db",
  // ... config
});

const appUser = db.createUser({
  id: "app-user",
  username: "appuser"
});

const appDb = db.createDatabase({
  id: "app-db",
  name: "myapp",
  owner: appUser
});

// Create app with all secret types
const app = createBunApp({
  id: "my-app",
  runtime: "next",

  env: [
    // Plain string
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },

    // Pulumi Output value
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } },

    // Bucket environment variables (includes endpoint, access keys on local)
    ...bucket.getEnvEntries("UPLOADS"),

    // Kubernetes secret reference
    {
      name: "REDIS_URL",
      value: { type: "secret", name: "redis-credentials", key: "url" }
    },

    // AWS Secrets Manager - specific key
    {
      name: "STRIPE_SECRET_KEY",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/stripe`,
        key: "secret_key"
      }
    },

    // AWS Secrets Manager - entire value
    {
      name: "JWT_SECRET",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/jwt-secret`
      }
    },

    // Build-time secret (available in CodeBuild)
    {
      name: "NPM_TOKEN",
      value: {
        type: "secret-arn",
        secretName: "npm/private-registry-token"
      },
      isPublic: true
    },

    // Sentry DSN for error tracking
    {
      name: "SENTRY_DSN",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/sentry`,
        key: "dsn"
      }
    }
  ],

  // ... other config
  cluster,
  deploymentManager,
  region
});
```

### Local .secrets File for Above Example

```
# Database (optional - could use local postgres)
production/db:{"username":"admin","password":"xxx"}

# Stripe API keys
development/stripe:{"secret_key":"sk_test_xxx","publishable_key":"pk_test_xxx"}
staging/stripe:{"secret_key":"sk_test_xxx","publishable_key":"pk_test_xxx"}

# JWT signing secret
development/jwt-secret:local-development-jwt-secret
staging/jwt-secret:staging-jwt-secret-key

# NPM private registry
npm/private-registry-token:npm_xxxxxxxx

# Sentry
development/sentry:{"dsn":"https://xxx@sentry.io/123"}
staging/sentry:{"dsn":"https://xxx@sentry.io/456"}
```

---

## isPublic Flag

The `isPublic` flag controls whether a secret is available during CodeBuild:

```typescript
env: [
  // NOT available in CodeBuild (default)
  {
    name: "DATABASE_URL",
    value: { type: "secret-arn", secretName: "prod/db" }
  },

  // AVAILABLE in CodeBuild
  {
    name: "NPM_TOKEN",
    value: { type: "secret-arn", secretName: "npm/token" },
    isPublic: true
  }
]
```

### When to Use isPublic

| Secret Type | isPublic | Reason |
|-------------|----------|--------|
| Database credentials | `false` | Not needed during build |
| API keys for runtime | `false` | Not needed during build |
| NPM private registry | `true` | Needed to install packages |
| Sentry auth token | `true` | Needed for sourcemap upload |
| Docker credentials | automatic | Handled by Tack |

---

## Best Practices

### 1. Use Naming Conventions

Organize secrets by environment:

```
production/database
production/stripe
production/jwt-secret

staging/database
staging/stripe
staging/jwt-secret
```

### 2. Keep .secrets Out of Git

```gitignore
# .gitignore
.secrets
.secrets.local
```

### 3. Use JSON for Complex Secrets

```
# Good - JSON for multiple related values
myapp/stripe:{"secret_key":"sk_xxx","publishable_key":"pk_xxx"}

# Good - Plain string for single values
myapp/jwt-secret:my-secret-key
```

### 4. Rotate Secrets Regularly

```bash
# Update secret in AWS
aws secretsmanager put-secret-value \
  --secret-id myapp/database \
  --secret-string '{"username":"admin","password":"newpassword"}'

# Pods will automatically receive updated values on next restart
kubectl rollout restart deployment my-app
```

### 5. Document Required Secrets

Create a template file for team members:

```
# .secrets.template
# Copy to .secrets and fill in values

# Stripe test keys (get from Stripe dashboard)
staging/stripe:{"secret_key":"sk_test_xxx","publishable_key":"pk_test_xxx"}

# JWT secret (generate with: openssl rand -base64 32)
staging/jwt-secret:

# Database credentials (match docker-compose or local postgres)
staging/database:{"username":"postgres","password":"postgres"}
```

### 6. Use Different Secrets Per Environment

```typescript
const app = createBunApp({
  id: "my-app",
  env: [
    {
      name: "STRIPE_KEY",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/stripe`,  // Uses stack name in path
        key: "secret_key"
      }
    }
  ]
});
```

---

## Troubleshooting

### Secret Not Found in .secrets

**Symptom**: Warning in Pulumi output about missing secret.

**Solution**: Verify the secret name matches exactly:
```bash
# Check your .secrets file
cat .secrets | grep "staging/my-secret"
```

### CSI Driver Not Working

**Symptom**: Pod fails to start with secret mounting error.

**Solution**:
```bash
# Check CSI driver pods
kubectl get pods -n kube-system -l app=secrets-store-csi-driver

# Check SecretProviderClass
kubectl get secretproviderclass

# Check pod events
kubectl describe pod my-app-xxx
```

### AWS Permissions Error

**Symptom**: Access denied when fetching secret.

**Solution**:
```bash
# Verify IAM policy includes secrets access
aws iam get-role-policy --role-name my-app-role --policy-name secrets-access

# Check the secret exists
aws secretsmanager describe-secret --secret-id myapp/database
```

### Secret Key Not Found

**Symptom**: Empty environment variable value.

**Solution**:
```bash
# Verify the key exists in the secret
aws secretsmanager get-secret-value --secret-id myapp/database | jq '.SecretString | fromjson'
```

---

## Related Documentation

- [Bun Apps](./BUN_APPS.md) - Environment configuration
- [IAM](./IAM.md) - Secrets Manager permissions
- [CI/CD](./CICD.md) - Build-time secrets
- [Cluster](./CLUSTER.md) - CSI Secrets Store setup
