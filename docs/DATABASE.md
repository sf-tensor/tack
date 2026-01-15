# Database

This document covers PostgreSQL database management in Tack.

## Table of Contents

- [Overview](#overview)
- [createDatabaseInstance](#createdatabaseinstance)
- [DatabaseInstance Class](#databaseinstance-class)
- [DatabaseUser Class](#databaseuser-class)
- [Database Class](#database-class)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's database module provides PostgreSQL databases that work on both local and production stacks.

### Stack Behavior

| Stack | Implementation | Features |
|-------|----------------|----------|
| development | In-cluster PostgreSQL | Single pod, no persistence |
| local-staging | In-cluster PostgreSQL | Single pod, no persistence |
| staging | AWS RDS | Single-AZ, automated backups |
| production | AWS RDS | Multi-AZ, deletion protection |

---

## createDatabaseInstance

Creates a PostgreSQL database instance.

### Signature

```typescript
function createDatabaseInstance(args: ResourceArgs<DatabaseInstanceConfig>): DatabaseInstance
```

### DatabaseInstanceConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique instance identifier |
| `region` | `Region` | Yes | AWS region |
| `name` | `string` | Yes | Instance name |
| `instanceType` | `string` | Yes | RDS instance type |
| `postgresVersion` | `string` | Yes | PostgreSQL version |
| `storageSize` | `number` | Yes | Storage size in GB |
| `username` | `string` | Yes | Master username |
| `networking` | `NetworkingConfig` | Yes | VPC and subnet config |
| `cluster` | `Cluster` | Yes | Target cluster |
| `deletionProtection` | `boolean` | No | Prevent deletion (default: `true` for prod) |
| `multiAz` | `boolean` | No | Multi-AZ deployment (default: `false`) |
| `backupRetentionDays` | `number` | No | Backup retention (default: 7 for prod, 0 for dev) |
| `deps` | `pulumi.Resource[]` | No | Dependencies |

### NetworkingConfig

```typescript
interface NetworkingConfig {
  vpc: Vpc;
  subnets: Subnet[];  // At least 2 for Multi-AZ
}
```

### Basic Example

```typescript
import {
  createVpc,
  createCluster,
  createDatabaseInstance,
  currentStack,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const db = createDatabaseInstance({
  id: "main-db",
  region,
  name: "main",
  instanceType: stackSwitch(
    { production: "db.r6g.large", staging: "db.t4g.medium" },
    "db.t4g.micro"
  ),
  postgresVersion: "15",
  storageSize: stackSwitch({ production: 100, staging: 50 }, 20),
  username: "postgres",
  networking: {
    vpc,
    subnets: [privateSubnet1, privateSubnet2]
  },
  multiAz: currentStack === "production",
  deletionProtection: currentStack === "production",
  backupRetentionDays: stackSwitch({ production: 14, staging: 7 }, 0),
  cluster
});
```

---

## DatabaseInstance Class

Abstract base class for database instances.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `host` | `pulumi.Output<string>` | Database hostname |
| `port` | `pulumi.Output<number>` | Database port |
| `masterUsername` | `pulumi.Output<string>` | Master username |
| `masterPassword` | `pulumi.Output<string>` | Master password |

### Methods

#### createUser(config)

Creates a database user.

```typescript
createUser(config: CreateUserConfig): DatabaseUser
```

**CreateUserConfig:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique user identifier |
| `username` | `string` | Yes | Database username |
| `password` | `pulumi.Input<string>` | No | Password (auto-generated if not provided) |

**Example:**

```typescript
const appUser = db.createUser({
  id: "app-user",
  username: "appuser"
});

// With explicit password
const adminUser = db.createUser({
  id: "admin-user",
  username: "admin",
  password: pulumi.secret("custom-password")
});
```

#### createDatabase(config)

Creates a database.

```typescript
createDatabase(config: CreateDatabaseConfig): Database
```

**CreateDatabaseConfig:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique database identifier |
| `name` | `string` | Yes | Database name |
| `owner` | `DatabaseUser` | Yes | Database owner |

**Example:**

```typescript
const appDb = db.createDatabase({
  id: "app-db",
  name: "myapp",
  owner: appUser
});
```

#### allowAccessFrom(id, securityGroupId)

Allows a security group to access the database (RDS only, no-op on local).

```typescript
allowAccessFrom(id: string, securityGroupId: pulumi.Input<string>): void
```

**Example:**

```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("cluster-access", cluster.clusterSecurityGroupId);
}
```

---

## DatabaseUser Class

Represents a database user with credentials.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `username` | `pulumi.Output<string>` | Username |
| `password` | `pulumi.Output<string>` | Password |
| `invocation` | `pulumi.Resource` | Lambda invocation resource |

### Example

```typescript
const appUser = db.createUser({
  id: "app",
  username: "app"
});

// Access credentials
export const dbUsername = appUser.username;
export const dbPassword = appUser.password;
```

---

## Database Class

Represents a database with connection information.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `pulumi.Output<string>` | Database name |
| `host` | `pulumi.Output<string>` | Database host |
| `port` | `pulumi.Output<number>` | Database port |
| `username` | `pulumi.Output<string>` | Username |
| `password` | `pulumi.Output<string>` | Password |
| `job` | `pulumi.Resource` | Creation job resource |

### Properties (Computed)

#### connectionString

Full PostgreSQL connection string.

```typescript
get connectionString(): pulumi.Output<string>
// Returns: "postgres://user:pass@host:5432/dbname"
```

### Methods

#### getEnvVar()

Returns JSON with all connection info.

```typescript
getEnvVar(): pulumi.Output<string>
```

**Returns:**
```json
{
  "connectionString": "postgres://user:pass@host:5432/dbname",
  "host": "hostname",
  "port": 5432,
  "username": "user",
  "password": "pass",
  "database": "dbname"
}
```

### Example

```typescript
const appDb = db.createDatabase({
  id: "app-db",
  name: "myapp",
  owner: appUser
});

// Use connection string directly
const app = createBunApp({
  env: [
    {
      name: "DATABASE_URL",
      value: { type: "value", value: appDb.connectionString }
    }
  ]
});

// Or use JSON config
const app2 = createBunApp({
  env: [
    {
      name: "DB_CONFIG",
      value: { type: "value", value: appDb.getEnvVar() }
    }
  ]
});
```

---

## Complete Examples

### Example 1: Single App Database

```typescript
import {
  createVpc,
  createCluster,
  createDatabaseInstance,
  createBunApp,
  createDeploymentManager,
  isLocalStack,
  currentStack,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// VPC and cluster setup...
const vpc = createVpc({ /* ... */ });
const cluster = createCluster({ /* ... */ });

// Create database instance
const db = createDatabaseInstance({
  id: "main-db",
  region,
  name: "main",
  instanceType: stackSwitch(
    { production: "db.r6g.large" },
    "db.t4g.micro"
  ),
  postgresVersion: "15",
  storageSize: stackSwitch({ production: 100 }, 20),
  username: "postgres",
  networking: { vpc, subnets: [privateSubnet1, privateSubnet2] },
  multiAz: currentStack === "production",
  cluster
});

// Create user and database
const appUser = db.createUser({ id: "app-user", username: "app" });
const appDb = db.createDatabase({ id: "app-db", name: "myapp", owner: appUser });

// Allow cluster access
if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("cluster", cluster.clusterSecurityGroupId);
}

// Create app with database connection
const app = createBunApp({
  id: "app",
  runtime: "next",
  env: [
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } }
  ],
  tasks: [
    { name: "migrate", command: "prisma migrate deploy" }
  ],
  cluster,
  deploymentManager,
  region
});

// Export connection info
export const databaseHost = appDb.host;
export const databaseName = appDb.name;
```

### Example 2: Multiple Databases

```typescript
// Create database instance
const db = createDatabaseInstance({
  id: "main-db",
  name: "main",
  instanceType: "db.r6g.large",
  postgresVersion: "15",
  storageSize: 200,
  username: "postgres",
  networking: { vpc, subnets },
  cluster,
  region
});

// Create users for different apps
const apiUser = db.createUser({ id: "api-user", username: "api" });
const analyticsUser = db.createUser({ id: "analytics-user", username: "analytics" });
const adminUser = db.createUser({ id: "admin-user", username: "admin" });

// Create databases for different apps
const apiDb = db.createDatabase({ id: "api-db", name: "api", owner: apiUser });
const analyticsDb = db.createDatabase({ id: "analytics-db", name: "analytics", owner: analyticsUser });

// Connect apps to their databases
const apiApp = createBunApp({
  id: "api",
  env: [
    { name: "DATABASE_URL", value: { type: "value", value: apiDb.connectionString } }
  ],
  // ...
});

const analyticsApp = createBunApp({
  id: "analytics",
  env: [
    { name: "DATABASE_URL", value: { type: "value", value: analyticsDb.connectionString } }
  ],
  // ...
});
```

### Example 3: Read Replicas Pattern

For read-heavy workloads, consider this pattern:

```typescript
// Primary database
const primaryDb = createDatabaseInstance({
  id: "primary-db",
  name: "primary",
  instanceType: "db.r6g.xlarge",
  postgresVersion: "15",
  storageSize: 500,
  username: "postgres",
  networking: { vpc, subnets },
  multiAz: true,
  cluster,
  region
});

// Create app user and database
const appUser = primaryDb.createUser({ id: "app", username: "app" });
const appDb = primaryDb.createDatabase({ id: "app-db", name: "myapp", owner: appUser });

// For read replicas, add them manually via AWS
// Then provide the replica endpoint to read-only services
const app = createBunApp({
  id: "app",
  env: [
    // Primary for writes
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } },
    // Read replica endpoint (manually configured)
    { name: "DATABASE_READ_URL", value: "postgres://..." }
  ],
  // ...
});
```

### Example 4: Using with Prisma

```typescript
// Database setup
const db = createDatabaseInstance({ /* ... */ });
const appUser = db.createUser({ id: "app", username: "app" });
const appDb = db.createDatabase({ id: "app-db", name: "myapp", owner: appUser });

// App with Prisma migrations
const app = createBunApp({
  id: "app",
  runtime: "next",
  env: [
    // Prisma expects DATABASE_URL
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } },
    // Shadow database for Prisma (optional)
    { name: "SHADOW_DATABASE_URL", value: { type: "value", value: shadowDb.connectionString } }
  ],
  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "prisma db seed" },
    { name: "generate", command: "prisma generate" }
  ],
  cluster,
  deploymentManager,
  region
});
```

---

## RDS Instance Types

### General Purpose

| Type | vCPU | Memory | Network |
|------|------|--------|---------|
| `db.t4g.micro` | 2 | 1 GB | Low |
| `db.t4g.small` | 2 | 2 GB | Low |
| `db.t4g.medium` | 2 | 4 GB | Moderate |
| `db.t4g.large` | 2 | 8 GB | Moderate |

### Memory Optimized

| Type | vCPU | Memory | Network |
|------|------|--------|---------|
| `db.r6g.large` | 2 | 16 GB | Up to 10 Gbps |
| `db.r6g.xlarge` | 4 | 32 GB | Up to 10 Gbps |
| `db.r6g.2xlarge` | 8 | 64 GB | Up to 10 Gbps |
| `db.r6g.4xlarge` | 16 | 128 GB | 10 Gbps |

### Recommendations

| Use Case | Recommended Type |
|----------|------------------|
| Development | `db.t4g.micro` |
| Small apps | `db.t4g.medium` |
| Production | `db.r6g.large` or higher |
| High memory | `db.r6g.xlarge` or higher |

---

## Best Practices

### 1. Use Multi-AZ for Production

```typescript
multiAz: currentStack === "production"
```

### 2. Enable Deletion Protection

```typescript
deletionProtection: currentStack === "production"
```

### 3. Configure Appropriate Backups

```typescript
backupRetentionDays: stackSwitch(
  { production: 14, staging: 7 },
  0  // No backups for development
)
```

### 4. Use Separate Users per App

```typescript
// Each app gets its own user
const apiUser = db.createUser({ username: "api" });
const workerUser = db.createUser({ username: "worker" });
```

### 5. Size Appropriately per Stack

```typescript
instanceType: stackSwitch(
  { production: "db.r6g.xlarge", staging: "db.t4g.medium" },
  "db.t4g.micro"
),
storageSize: stackSwitch(
  { production: 500, staging: 100 },
  20
)
```

---

## Local Development

On local stacks, databases run as PostgreSQL pods in Minikube.

### Accessing Local Database

```bash
# Port forward PostgreSQL
kubectl port-forward svc/main-db-postgres 5432:5432

# Connect with psql
psql -h localhost -U app -d myapp
```

### Local vs Production Differences

| Feature | Local | Production |
|---------|-------|------------|
| High availability | No | Multi-AZ optional |
| Backups | No | Automated |
| Encryption | No | At rest |
| Security groups | N/A | VPC-based |
| Performance | Limited | Scalable |

---

## Related Documentation

- [Networking](./NETWORKING.md) - VPC setup for RDS
- [Cluster](./CLUSTER.md) - Security group access
- [Bun Apps](./BUN_APPS.md) - Connecting apps to database
- [Secrets](./SECRETS.md) - Managing database credentials
