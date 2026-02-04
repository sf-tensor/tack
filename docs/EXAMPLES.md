# Examples

Complete, runnable examples demonstrating Tack features.

## Table of Contents

- [Example 1: Basic Web Application](#example-1-basic-web-application)
- [Example 2: Full Production Setup](#example-2-full-production-setup)
- [Example 3: Multi-Service Architecture](#example-3-multi-service-architecture)
- [Example 4: Database Integration](#example-4-database-integration)
- [Example 5: Background Tasks](#example-5-background-tasks)
- [Example 6: Custom Domain with SSL](#example-6-custom-domain-with-ssl)
- [Example 7: Local Development Setup](#example-7-local-development-setup)

---

## Example 1: Basic Web Application

A minimal example deploying a Next.js application.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

// =============================================================================
// CONFIGURATION
// =============================================================================

const region: Region = "us-east-1";

// =============================================================================
// NETWORKING
// =============================================================================

const vpc = createVpc({
  id: "vpc",
  name: "basic-app-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

const publicSubnet1 = vpc.createSubnet({
  id: "public-1",
  name: "public-subnet-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.1.0/24",
  region
});

const publicSubnet2 = vpc.createSubnet({
  id: "public-2",
  name: "public-subnet-2",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.2.0/24",
  region
});

const privateSubnet1 = vpc.createSubnet({
  id: "private-1",
  name: "private-subnet-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.10.0/24",
  region
});

const privateSubnet2 = vpc.createSubnet({
  id: "private-2",
  name: "private-subnet-2",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.11.0/24",
  region
});

// =============================================================================
// CLUSTER
// =============================================================================

const cluster = createCluster({
  id: "cluster",
  region,
  vpc,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        { production: ["m6gd.large"], staging: ["m6gd.medium"] },
        ["m6gd.medium"]
      ),
      scalingConfig: stackSwitch(
        {
          production: { minSize: 2, maxSize: 10, desiredSize: 3 },
          staging: { minSize: 1, maxSize: 5, desiredSize: 2 }
        },
        { minSize: 1, maxSize: 3, desiredSize: 1 }
      ),
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets: [privateSubnet1, privateSubnet2],
  publicSubnets: [publicSubnet1, publicSubnet2]
});

// =============================================================================
// CI/CD
// =============================================================================

const deploymentManager = createDeploymentManager({
  id: "cicd",
  region,
  cluster,
  managerRepository: { type: "github", org: "myorg", repo: "cicd-manager" },
  managerBranch: "main"
});

// =============================================================================
// APPLICATION
// =============================================================================

const app = createBunApp({
  id: "web",
  runtime: "next",
  localPath: "/Users/dev/projects/my-next-app",
  repository: { type: "github", org: "myorg", repo: "my-next-app" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") }
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },

  devPod: {
    nodeModulesCacheSize: "10Gi",
    ignorePatterns: [".git", "node_modules", ".next"]
  },

  region,
  cluster,
  deploymentManager
});

// =============================================================================
// EXPORTS
// =============================================================================

export const appUrl = "http://localhost:3000";  // Local access
```

---

## Example 2: Full Production Setup

Complete production infrastructure with all components.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createBucket,
  createDatabaseInstance,
  createLoadBalancer,
  stackSwitch,
  currentStack,
  isLocalStack,
  type Region
} from "@sf-tensor/tack";
import * as pulumi from "@pulumi/pulumi";

// =============================================================================
// CONFIGURATION
// =============================================================================

const region: Region = "us-east-1";
const config = new pulumi.Config();
const cloudflareZoneId = config.get("cloudflareZoneId");
const domain = config.get("domain") || "app.example.com";

// =============================================================================
// NETWORKING
// =============================================================================

const vpc = createVpc({
  id: "main-vpc",
  name: `myapp-vpc-${currentStack}`,
  cidrBlock: "10.0.0.0/16",
  region
});

// Public subnets (for load balancers)
const publicSubnet1 = vpc.createSubnet({
  id: "public-1",
  name: "public-subnet-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.1.0/24",
  region
});

const publicSubnet2 = vpc.createSubnet({
  id: "public-2",
  name: "public-subnet-2",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.2.0/24",
  region
});

// Private subnets (for applications)
const privateSubnet1 = vpc.createSubnet({
  id: "private-1",
  name: "private-subnet-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.10.0/24",
  region
});

const privateSubnet2 = vpc.createSubnet({
  id: "private-2",
  name: "private-subnet-2",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.11.0/24",
  region
});

// Database subnets
const dbSubnet1 = vpc.createSubnet({
  id: "db-1",
  name: "db-subnet-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.20.0/24",
  region
});

const dbSubnet2 = vpc.createSubnet({
  id: "db-2",
  name: "db-subnet-2",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.21.0/24",
  region
});

// =============================================================================
// CLUSTER
// =============================================================================

const cluster = createCluster({
  id: "main-cluster",
  region,
  vpc,
  deletionProtection: stackSwitch({ production: true }, false),
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        {
          production: ["m6gd.xlarge"],
          staging: ["m6gd.large"]
        },
        ["m6gd.large"]
      ),
      scalingConfig: stackSwitch(
        {
          production: { minSize: 3, maxSize: 20, desiredSize: 5 },
          staging: { minSize: 2, maxSize: 8, desiredSize: 3 }
        },
        { minSize: 1, maxSize: 3, desiredSize: 2 }
      ),
      storage: { type: "nvme-instance-store" }
    },
    {
      id: "compute",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        {
          production: ["c6gd.2xlarge"],
          staging: ["c6gd.xlarge"]
        },
        ["c6gd.large"]
      ),
      scalingConfig: stackSwitch(
        {
          production: { minSize: 0, maxSize: 10, desiredSize: 2 },
          staging: { minSize: 0, maxSize: 5, desiredSize: 0 }
        },
        { minSize: 0, maxSize: 2, desiredSize: 0 }
      ),
      storage: { type: "ebs", ebsDiskSize: 200 }
    }
  ],
  privateSubnets: [privateSubnet1, privateSubnet2],
  publicSubnets: [publicSubnet1, publicSubnet2]
});

// =============================================================================
// CI/CD
// =============================================================================

const deploymentManager = createDeploymentManager({
  id: "deploy-manager",
  region,
  cluster,
  managerRepository: { type: "github", org: "myorg", repo: "deployment-manager" },
  managerBranch: "main"
});

// =============================================================================
// DATABASE
// =============================================================================

const db = createDatabaseInstance({
  id: "main-db",
  name: "main",
  instanceType: stackSwitch(
    {
      production: "db.r6g.large",
      staging: "db.t4g.medium"
    },
    "db.t4g.micro"
  ),
  postgresVersion: "15",
  storageSize: stackSwitch({ production: 100, staging: 50 }, 20),
  username: "postgres",
  networking: {
    vpc,
    subnets: [dbSubnet1, dbSubnet2]
  },
  deletionProtection: stackSwitch({ production: true }, false),
  multiAz: stackSwitch({ production: true }, false),
  backupRetentionDays: stackSwitch({ production: 14, staging: 7 }, 1),
  region,
  cluster
});

// Allow cluster access to database
if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("cluster-access", cluster.clusterSecurityGroupId);
}

// Create application database and user
const appUser = db.createUser({
  id: "app-user",
  username: "appuser"
});

const appDb = db.createDatabase({
  id: "app-db",
  name: "myapp",
  owner: appUser
});

// =============================================================================
// STORAGE
// =============================================================================

const uploadsBucket = createBucket({
  id: "uploads",
  bucketName: `myapp-uploads-${currentStack}`,
  isPublic: false,
  region
});

const assetsBucket = createBucket({
  id: "assets",
  bucketName: `myapp-assets-${currentStack}`,
  isPublic: true,
  region
});

// Add lifecycle rules for uploads
uploadsBucket.addLifecycleRules({
  id: "upload-lifecycle",
  rules: [
    {
      id: "move-to-ia",
      filter: { prefix: "uploads/" },
      transitions: [
        { days: 30, storageClass: "STANDARD_IA" },
        { days: 90, storageClass: "GLACIER" }
      ]
    },
    {
      id: "delete-temp",
      filter: { prefix: "temp/" },
      expiration: { days: 7 }
    }
  ]
});

// =============================================================================
// APPLICATIONS
// =============================================================================

// Frontend Application
const frontend = createBunApp({
  id: "frontend",
  runtime: "next",
  localPath: "/Users/dev/projects/myapp-frontend",
  repository: { type: "github", org: "myorg", repo: "myapp-frontend" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    { name: "NEXT_PUBLIC_API_URL", value: stackSwitch(
      {
        production: "https://api.example.com",
        staging: "https://api-staging.example.com"
      },
      "http://localhost:4000"
    )},
    ...assetsBucket.getEnvEntries("ASSETS")
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },

  devPod: {
    nodeModulesCacheSize: "15Gi",
    ignorePatterns: [".git", "node_modules", ".next", "dist"]
  },

  region,
  cluster,
  deploymentManager
});

// API Application
const api = createBunApp({
  id: "api",
  runtime: "base",
  localPath: "/Users/dev/projects/myapp-api",
  repository: { type: "github", org: "myorg", repo: "myapp-api" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } },
    ...uploadsBucket.getEnvEntries("UPLOADS"),
    {
      name: "JWT_SECRET",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/jwt-secret`
      }
    },
    {
      name: "STRIPE_SECRET_KEY",
      value: {
        type: "secret-arn",
        secretName: `${currentStack}/stripe`,
        key: "secret_key"
      }
    }
  ],

  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "node scripts/seed.js" }
  ],

  ports: [{ name: "http", port: 4000 }],
  healthRoute: { path: "/health", port: 4000 },
  taskLabelKey: "myapp.io/task-type",

  devPod: {
    nodeModulesCacheSize: "10Gi",
    ignorePatterns: [".git", "node_modules", "dist"]
  },

  region,
  cluster,
  deploymentManager
});

// Grant bucket access to API
api.role.grantBucketAccess([uploadsBucket], "read-write");

// =============================================================================
// LOAD BALANCER
// =============================================================================

const lb = createLoadBalancer({
  name: "main-lb",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: isLocalStack(currentStack) ? "" : domain,
      routes: [
        { path: "/api", service: api.service.metadata.name, port: 4000 },
        { path: "/", service: frontend.service.metadata.name, port: 3000 }
      ]
    }
  ]
});

// =============================================================================
// EXPORTS
// =============================================================================

export const frontendUrl = isLocalStack(currentStack)
  ? "http://localhost:3000"
  : `https://${domain}`;

export const apiUrl = isLocalStack(currentStack)
  ? "http://localhost:4000"
  : `https://${domain}/api`;

export const databaseHost = db.host;
export const uploadsBucketName = uploadsBucket.name;
export const assetsBucketName = assetsBucket.name;
export const albHostname = lb.albHostname;
```

---

## Example 3: Multi-Service Architecture

Microservices architecture with multiple applications.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createBucket,
  createLoadBalancer,
  stackSwitch,
  currentStack,
  isLocalStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// ... VPC and Cluster setup (same as previous examples)

// =============================================================================
// SHARED STORAGE
// =============================================================================

const sharedBucket = createBucket({
  id: "shared",
  bucketName: `myapp-shared-${currentStack}`,
  isPublic: false,
  region
});

// =============================================================================
// SERVICES
// =============================================================================

// User Service
const userService = createBunApp({
  id: "user-service",
  runtime: "base",
  localPath: "/Users/dev/projects/user-service",
  repository: { type: "github", org: "myorg", repo: "user-service" },
  branch: "main",
  env: [
    { name: "SERVICE_NAME", value: "user-service" },
    { name: "PORT", value: "4001" },
    {
      name: "DATABASE_URL",
      value: { type: "secret-arn", secretName: `${currentStack}/user-db` }
    }
  ],
  ports: [{ name: "http", port: 4001 }],
  healthRoute: { path: "/health", port: 4001 },
  region,
  cluster,
  deploymentManager
});

// Order Service
const orderService = createBunApp({
  id: "order-service",
  runtime: "base",
  localPath: "/Users/dev/projects/order-service",
  repository: { type: "github", org: "myorg", repo: "order-service" },
  branch: "main",
  env: [
    { name: "SERVICE_NAME", value: "order-service" },
    { name: "PORT", value: "4002" },
    {
      name: "DATABASE_URL",
      value: { type: "secret-arn", secretName: `${currentStack}/order-db` }
    },
    { name: "USER_SERVICE_URL", value: "http://user-service:4001" }
  ],
  ports: [{ name: "http", port: 4002 }],
  healthRoute: { path: "/health", port: 4002 },
  region,
  cluster,
  deploymentManager
});

// Payment Service
const paymentService = createBunApp({
  id: "payment-service",
  runtime: "base",
  localPath: "/Users/dev/projects/payment-service",
  repository: { type: "github", org: "myorg", repo: "payment-service" },
  branch: "main",
  env: [
    { name: "SERVICE_NAME", value: "payment-service" },
    { name: "PORT", value: "4003" },
    {
      name: "STRIPE_SECRET_KEY",
      value: { type: "secret-arn", secretName: `${currentStack}/stripe`, key: "secret_key" }
    },
    { name: "ORDER_SERVICE_URL", value: "http://order-service:4002" }
  ],
  ports: [{ name: "http", port: 4003 }],
  healthRoute: { path: "/health", port: 4003 },
  region,
  cluster,
  deploymentManager
});

// Notification Service
const notificationService = createBunApp({
  id: "notification-service",
  runtime: "base",
  localPath: "/Users/dev/projects/notification-service",
  repository: { type: "github", org: "myorg", repo: "notification-service" },
  branch: "main",
  env: [
    { name: "SERVICE_NAME", value: "notification-service" },
    { name: "PORT", value: "4004" },
    {
      name: "SENDGRID_API_KEY",
      value: { type: "secret-arn", secretName: `${currentStack}/sendgrid` }
    },
    ...sharedBucket.getEnvEntries("TEMPLATES")
  ],
  ports: [{ name: "http", port: 4004 }],
  healthRoute: { path: "/health", port: 4004 },
  region,
  cluster,
  deploymentManager
});

notificationService.role.grantBucketAccess([sharedBucket], "read-only");

// API Gateway
const gateway = createBunApp({
  id: "api-gateway",
  runtime: "base",
  localPath: "/Users/dev/projects/api-gateway",
  repository: { type: "github", org: "myorg", repo: "api-gateway" },
  branch: "main",
  env: [
    { name: "SERVICE_NAME", value: "api-gateway" },
    { name: "PORT", value: "4000" },
    { name: "USER_SERVICE_URL", value: "http://user-service:4001" },
    { name: "ORDER_SERVICE_URL", value: "http://order-service:4002" },
    { name: "PAYMENT_SERVICE_URL", value: "http://payment-service:4003" },
    { name: "NOTIFICATION_SERVICE_URL", value: "http://notification-service:4004" }
  ],
  ports: [{ name: "http", port: 4000 }],
  healthRoute: { path: "/health", port: 4000 },
  region,
  cluster,
  deploymentManager
});

// Frontend
const frontend = createBunApp({
  id: "frontend",
  runtime: "next",
  localPath: "/Users/dev/projects/frontend",
  repository: { type: "github", org: "myorg", repo: "frontend" },
  branch: "main",
  env: [
    { name: "NEXT_PUBLIC_API_URL", value: isLocalStack(currentStack)
      ? "http://localhost:4000"
      : "https://api.example.com"
    }
  ],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },
  region,
  cluster,
  deploymentManager
});

// =============================================================================
// LOAD BALANCER
// =============================================================================

const lb = createLoadBalancer({
  name: "main-lb",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: isLocalStack(currentStack) ? "" : "api.example.com",
      routes: [
        { path: "/", service: gateway.service.metadata.name, port: 4000 }
      ]
    },
    {
      host: isLocalStack(currentStack) ? "" : "app.example.com",
      routes: [
        { path: "/", service: frontend.service.metadata.name, port: 3000 }
      ]
    }
  ]
});

// =============================================================================
// EXPORTS
// =============================================================================

export const services = {
  userService: "http://user-service:4001",
  orderService: "http://order-service:4002",
  paymentService: "http://payment-service:4003",
  notificationService: "http://notification-service:4004",
  gateway: "http://api-gateway:4000",
  frontend: "http://frontend:3000"
};
```

---

## Example 4: Database Integration

Complete database setup with users, databases, and migrations.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createDatabaseInstance,
  stackSwitch,
  currentStack,
  isLocalStack,
  type Region
} from "@sf-tensor/tack";
import * as random from "@pulumi/random";

const region: Region = "us-east-1";

// ... VPC and Cluster setup

// =============================================================================
// DATABASE INSTANCE
// =============================================================================

const db = createDatabaseInstance({
  id: "primary-db",
  name: "primary",
  instanceType: stackSwitch(
    {
      production: "db.r6g.xlarge",
      staging: "db.r6g.large"
    },
    "db.t4g.micro"
  ),
  postgresVersion: "15",
  storageSize: stackSwitch({ production: 200, staging: 100 }, 20),
  username: "postgres",
  networking: {
    vpc,
    subnets: [dbSubnet1, dbSubnet2]
  },
  deletionProtection: stackSwitch({ production: true }, false),
  multiAz: stackSwitch({ production: true }, false),
  backupRetentionDays: stackSwitch({ production: 30, staging: 7 }, 1),
  region,
  cluster
});

// Allow cluster access
if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("eks-access", cluster.clusterSecurityGroupId);
}

// =============================================================================
// DATABASE USERS AND DATABASES
// =============================================================================

// Generate secure passwords
const apiPassword = new random.RandomPassword("api-password", {
  length: 32,
  special: false
});

const analyticsPassword = new random.RandomPassword("analytics-password", {
  length: 32,
  special: false
});

// API User - full access to api database
const apiUser = db.createUser({
  id: "api-user",
  username: "apiuser",
  password: apiPassword.result
});

// Analytics User - read-only access
const analyticsUser = db.createUser({
  id: "analytics-user",
  username: "analytics",
  password: analyticsPassword.result
});

// API Database
const apiDb = db.createDatabase({
  id: "api-db",
  name: "api",
  owner: apiUser
});

// Analytics Database
const analyticsDb = db.createDatabase({
  id: "analytics-db",
  name: "analytics",
  owner: analyticsUser
});

// =============================================================================
// APPLICATIONS
// =============================================================================

const api = createBunApp({
  id: "api",
  runtime: "base",
  localPath: "/Users/dev/projects/api",
  repository: { type: "github", org: "myorg", repo: "api" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    // Use the auto-generated connection string
    { name: "DATABASE_URL", value: { type: "value", value: apiDb.connectionString } },
    // Or construct manually
    { name: "DB_HOST", value: { type: "value", value: db.host } },
    { name: "DB_PORT", value: { type: "value", value: db.port.apply(p => String(p)) } },
    { name: "DB_NAME", value: "api" },
    { name: "DB_USER", value: { type: "value", value: apiUser.username } },
    { name: "DB_PASSWORD", value: { type: "value", value: apiUser.password } }
  ],

  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "prisma db seed" }
  ],

  ports: [{ name: "http", port: 4000 }],
  healthRoute: { path: "/health", port: 4000 },
  taskLabelKey: "myapp.io/task-type",

  region,
  cluster,
  deploymentManager
});

const analyticsService = createBunApp({
  id: "analytics",
  runtime: "base",
  localPath: "/Users/dev/projects/analytics",
  repository: { type: "github", org: "myorg", repo: "analytics" },
  branch: "main",

  env: [
    { name: "DATABASE_URL", value: { type: "value", value: analyticsDb.connectionString } },
    { name: "API_DATABASE_URL", value: { type: "value", value: apiDb.connectionString } }
  ],

  ports: [{ name: "http", port: 4001 }],
  healthRoute: { path: "/health", port: 4001 },

  region,
  cluster,
  deploymentManager
});

// =============================================================================
// EXPORTS
// =============================================================================

export const databaseEndpoint = db.host;
export const apiDatabaseUrl = apiDb.connectionString;
export const analyticsDatabaseUrl = analyticsDb.connectionString;
```

---

## Example 5: Background Tasks

Application with background tasks and scheduled jobs.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createBucket,
  stackSwitch,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// ... VPC and Cluster setup

// =============================================================================
// STORAGE
// =============================================================================

const processingBucket = createBucket({
  id: "processing",
  bucketName: `myapp-processing-${currentStack}`,
  isPublic: false,
  region
});

const outputBucket = createBucket({
  id: "output",
  bucketName: `myapp-output-${currentStack}`,
  isPublic: false,
  region
});

// =============================================================================
// APPLICATION WITH TASKS
// =============================================================================

const processor = createBunApp({
  id: "processor",
  runtime: "base",
  localPath: "/Users/dev/projects/processor",
  repository: { type: "github", org: "myorg", repo: "processor" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    ...processingBucket.getEnvEntries("INPUT"),
    ...outputBucket.getEnvEntries("OUTPUT"),
    {
      name: "DATABASE_URL",
      value: { type: "secret-arn", secretName: `${currentStack}/database` }
    },
    {
      name: "REDIS_URL",
      value: { type: "secret", name: "redis-credentials", key: "url" }
    }
  ],

  // Define background tasks
  tasks: [
    // Database migration - runs on deploy
    {
      name: "migrate",
      command: "prisma migrate deploy"
    },

    // Data cleanup - scheduled daily
    {
      name: "cleanup",
      command: "node scripts/cleanup-old-data.js"
    },

    // Report generation - scheduled weekly
    {
      name: "generate-reports",
      command: "node scripts/generate-weekly-reports.js"
    },

    // Sync external data - runs on deploy
    {
      name: "sync",
      command: "node scripts/sync-external-data.js"
    },

    // Reindex search - runs on demand
    {
      name: "reindex",
      command: "node scripts/reindex-search.js"
    }
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/health", port: 3000 },
  taskLabelKey: "processor.io/task-type",

  devPod: {
    nodeModulesCacheSize: "10Gi",
    ignorePatterns: [".git", "node_modules", "dist"]
  },

  region,
  cluster,
  deploymentManager
});

// Grant bucket access
processor.role.grantBucketAccess([processingBucket], "read-only");
processor.role.grantBucketAccess([outputBucket], "read-write");

// Add SQS permissions for job queue
processor.role.attachPolicy("sqs-access", [{
  Effect: "Allow",
  Action: [
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
    "sqs:ChangeMessageVisibility"
  ],
  Resource: [`arn:aws:sqs:${region}:*:processor-jobs`]
}]);

// =============================================================================
// EXPORTS
// =============================================================================

export const processorUrl = "http://localhost:3000";
export const taskNames = processor.taskNames;
```

### How Tasks Work

In production, tasks are created as suspended CronJobs:

```bash
# View tasks
kubectl get cronjobs -l processor.io/task-type

# Manually trigger a task
kubectl create job --from=cronjob/processor-migrate migrate-manual-$(date +%s)

# View task logs
kubectl logs -l job-name=processor-migrate
```

---

## Example 6: Custom Domain with SSL

Full SSL setup with custom domain and Cloudflare DNS.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createLoadBalancer,
  createCertificate,
  createDnsRecord,
  stackSwitch,
  currentStack,
  isLocalStack,
  type Region
} from "@sf-tensor/tack";
import * as pulumi from "@pulumi/pulumi";

const region: Region = "us-east-1";
const config = new pulumi.Config();

// Get Cloudflare zone ID from config
const cloudflareZoneId = config.require("cloudflareZoneId");

// Domain configuration
const baseDomain = "example.com";
const appDomain = stackSwitch(
  {
    production: `app.${baseDomain}`,
    staging: `app-staging.${baseDomain}`
  },
  `app-dev.${baseDomain}`
);
const apiDomain = stackSwitch(
  {
    production: `api.${baseDomain}`,
    staging: `api-staging.${baseDomain}`
  },
  `api-dev.${baseDomain}`
);

// ... VPC and Cluster setup

// =============================================================================
// APPLICATIONS
// =============================================================================

const frontend = createBunApp({
  id: "frontend",
  runtime: "next",
  localPath: "/Users/dev/projects/frontend",
  repository: { type: "github", org: "myorg", repo: "frontend" },
  branch: "main",
  env: [
    { name: "NEXT_PUBLIC_API_URL", value: `https://${apiDomain}` }
  ],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },
  region,
  cluster,
  deploymentManager
});

const api = createBunApp({
  id: "api",
  runtime: "base",
  localPath: "/Users/dev/projects/api",
  repository: { type: "github", org: "myorg", repo: "api" },
  branch: "main",
  env: [
    { name: "CORS_ORIGIN", value: `https://${appDomain}` }
  ],
  ports: [{ name: "http", port: 4000 }],
  healthRoute: { path: "/health", port: 4000 },
  region,
  cluster,
  deploymentManager
});

// =============================================================================
// LOAD BALANCER
// =============================================================================

const lb = createLoadBalancer({
  name: "main-lb",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: isLocalStack(currentStack) ? "" : appDomain,
      routes: [
        { path: "/", service: frontend.service.metadata.name, port: 3000 }
      ]
    },
    {
      host: isLocalStack(currentStack) ? "" : apiDomain,
      routes: [
        { path: "/", service: api.service.metadata.name, port: 4000 }
      ]
    }
  ]
});

// =============================================================================
// CUSTOM CERTIFICATES (Optional - usually automatic)
// =============================================================================

// Only needed if you want manual certificate control
// Usually createLoadBalancer handles this automatically

if (!isLocalStack(currentStack)) {
  // Create wildcard certificate
  const wildcardCert = createCertificate({
    id: "wildcard-cert",
    domainName: baseDomain,
    subjectAlternativeNames: [`*.${baseDomain}`],
    zoneId: cloudflareZoneId
  });

  // Create additional DNS records if needed
  const wwwRecord = createDnsRecord({
    id: "www-redirect",
    recordName: `www.${baseDomain}`,
    albHostname: lb.albHostname,
    zoneId: cloudflareZoneId
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export const urls = {
  app: isLocalStack(currentStack) ? "http://localhost:3000" : `https://${appDomain}`,
  api: isLocalStack(currentStack) ? "http://localhost:4000" : `https://${apiDomain}`
};

export const albHostname = lb.albHostname;
export const certificates = lb.certificates;
```

---

## Example 7: Local Development Setup

Optimized configuration for local development workflow.

```typescript
// index.ts
import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  createBucket,
  createDatabaseInstance,
  stackSwitch,
  currentStack,
  isLocalStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// =============================================================================
// INFRASTRUCTURE (minimal on local)
// =============================================================================

const vpc = createVpc({
  id: "vpc",
  name: "dev-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

// Only create multiple subnets for production
const publicSubnets = isLocalStack(currentStack)
  ? [vpc.createSubnet({
      id: "public",
      name: "public",
      availabilityZone: `${region}a`,
      cidrBlock: "10.0.1.0/24",
      region
    })]
  : [
      vpc.createSubnet({ id: "public-1", name: "public-1", availabilityZone: `${region}a`, cidrBlock: "10.0.1.0/24", region }),
      vpc.createSubnet({ id: "public-2", name: "public-2", availabilityZone: `${region}b`, cidrBlock: "10.0.2.0/24", region })
    ];

const privateSubnets = isLocalStack(currentStack)
  ? [vpc.createSubnet({
      id: "private",
      name: "private",
      availabilityZone: `${region}a`,
      cidrBlock: "10.0.10.0/24",
      region
    })]
  : [
      vpc.createSubnet({ id: "private-1", name: "private-1", availabilityZone: `${region}a`, cidrBlock: "10.0.10.0/24", region }),
      vpc.createSubnet({ id: "private-2", name: "private-2", availabilityZone: `${region}b`, cidrBlock: "10.0.11.0/24", region })
    ];

const cluster = createCluster({
  id: "cluster",
  region,
  vpc,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        { production: ["m6gd.xlarge"], staging: ["m6gd.large"] },
        ["m6gd.medium"]  // Smaller for local
      ),
      scalingConfig: stackSwitch(
        {
          production: { minSize: 2, maxSize: 10, desiredSize: 3 },
          staging: { minSize: 1, maxSize: 5, desiredSize: 2 }
        },
        { minSize: 1, maxSize: 2, desiredSize: 1 }  // Minimal for local
      ),
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets,
  publicSubnets
});

const deploymentManager = createDeploymentManager({
  id: "cicd",
  region,
  cluster,
  managerRepository: { type: "github", org: "myorg", repo: "cicd-manager" },
  managerBranch: "main"
});

// =============================================================================
// DATABASE
// =============================================================================

const db = createDatabaseInstance({
  id: "db",
  name: "main",
  instanceType: stackSwitch(
    { production: "db.r6g.large", staging: "db.t4g.medium" },
    "db.t4g.micro"  // Smallest for local
  ),
  postgresVersion: "15",
  storageSize: stackSwitch({ production: 100, staging: 50 }, 10),  // Small for local
  username: "postgres",
  networking: { vpc, subnets: privateSubnets },
  deletionProtection: false,
  multiAz: false,
  backupRetentionDays: 1,
  region,
  cluster
});

const appUser = db.createUser({ id: "app", username: "app" });
const appDb = db.createDatabase({ id: "appdb", name: "app", owner: appUser });

// =============================================================================
// STORAGE
// =============================================================================

const bucket = createBucket({
  id: "data",
  bucketName: `myapp-data-${currentStack}`,
  isPublic: false,
  region
});

// =============================================================================
// APPLICATION
// =============================================================================

const app = createBunApp({
  id: "app",
  runtime: "next",

  // Local path must be absolute
  localPath: "/Users/dev/projects/my-app",

  repository: { type: "github", org: "myorg", repo: "my-app" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    { name: "DATABASE_URL", value: { type: "value", value: appDb.connectionString } },
    ...bucket.getEnvEntries("DATA"),

    // Local-only debug settings
    ...(isLocalStack(currentStack) ? [
      { name: "DEBUG", value: "true" },
      { name: "LOG_LEVEL", value: "debug" }
    ] : [])
  ],

  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },

  tasks: [
    { name: "migrate", command: "prisma migrate deploy" },
    { name: "seed", command: "prisma db seed" }
  ],

  // DevPod configuration for optimal local development
  devPod: {
    // Large cache for fast npm installs
    nodeModulesCacheSize: "15Gi",

    // Skip init if you want faster startup (but need manual npm install)
    skipInit: false,

    // Generous timeout for first install
    initTimeoutMs: 600000,  // 10 minutes

    // Ignore files that don't need syncing
    ignorePatterns: [
      // Version control
      ".git",
      ".svn",

      // Dependencies (installed in pod)
      "node_modules",

      // Build outputs (generated in pod)
      ".next",
      "dist",
      "build",
      ".turbo",

      // Local environment files
      ".env.local",
      ".env.development.local",

      // IDE/Editor files
      ".idea",
      ".vscode",
      "*.swp",
      "*.swo",

      // System files
      ".DS_Store",
      "Thumbs.db",

      // Logs
      "*.log",
      "npm-debug.log*",
      "yarn-debug.log*",
      "yarn-error.log*",

      // Test coverage
      "coverage",
      ".nyc_output"
    ]
  },

  region,
  cluster,
  deploymentManager
});

app.role.grantBucketAccess([bucket], "read-write");

// =============================================================================
// LOCAL DEVELOPMENT INSTRUCTIONS
// =============================================================================

// Output helpful commands
export const instructions = `
Local Development Quick Start:
==============================
1. Start Minikube:      minikube start
2. Deploy:              pulumi up
3. Access app:          http://localhost:3000
4. View logs:           kubectl logs -l app=app -f
5. Run migrations:      kubectl create job --from=cronjob/app-migrate migrate-\$(date +%s)

Database Access:
================
Host:     localhost (port-forward required)
Database: app
User:     app
Password: (see Pulumi output)

Port Forward Commands:
=====================
kubectl port-forward svc/app 3000:3000
kubectl port-forward svc/main-postgresql 5432:5432
`;

export const databaseUrl = appDb.connectionString;
export const bucketName = bucket.name;
```

### Local .secrets File for Development

```
# .secrets
# Copy to .secrets and customize values

# Stripe test keys
development/stripe:{"secret_key":"sk_test_xxxxx","publishable_key":"pk_test_xxxxx"}

# JWT secret for local dev
development/jwt-secret:local-development-jwt-secret-change-in-prod

# Third-party API keys (use test/sandbox keys)
development/sendgrid:sg.xxxxxx
development/twilio:{"account_sid":"ACtest","auth_token":"testtoken"}
```

---

## Related Documentation

- [Getting Started](./GETTING_STARTED.md) - Prerequisites and setup
- [Core Concepts](./CORE_CONCEPTS.md) - Stacks and Resource pattern
- [Bun Apps](./BUN_APPS.md) - Application configuration
- [Database](./DATABASE.md) - Database setup
- [Buckets](./BUCKETS.md) - Storage configuration
- [Load Balancer](./LOAD_BALANCER.md) - Domain and SSL setup
- [DevPod](./DEV_POD.md) - Local development workflow
