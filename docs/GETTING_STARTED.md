# Getting Started with Tack

This guide walks you through setting up your first Tack project, from prerequisites to deploying your first application.

## Prerequisites

Before using Tack, ensure you have the following installed and configured:

### Required

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Runtime for Pulumi programs |
| Pulumi CLI | Latest | Infrastructure as code engine |
| AWS CLI | v2 | AWS credential management |

### For Local Development (DevPod)

| Tool | Version | Purpose |
|------|---------|---------|
| kubectl | Latest | Kubernetes cluster access |
| Minikube | Latest | Local Kubernetes cluster |
| Docker | Latest | Container runtime |

### Optional

| Tool | Version | Purpose |
|------|---------|---------|
| Cloudflare Account | - | DNS management and TLS certificates |

## Installation

Install Tack in your Pulumi project:

```bash
npm install @sf-tensor/tack
```

Or with other package managers:

```bash
# Yarn
yarn add @sf-tensor/tack

# pnpm
pnpm add @sf-tensor/tack

# Bun
bun add @sf-tensor/tack
```

## AWS Configuration

Tack requires AWS credentials available to Pulumi. Configure them using one of these methods:

### Option 1: AWS CLI Profile (Recommended)

```bash
aws configure
# Enter your AWS Access Key ID, Secret Access Key, and default region
```

### Option 2: Environment Variables

```bash
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="us-east-1"
```

### Option 3: AWS SSO

```bash
aws configure sso
aws sso login --profile your-profile
export AWS_PROFILE=your-profile
```

## Pulumi Configuration

Tack reads configuration from your Pulumi project. Set these values:

### Required for Production Stacks

```bash
# GitHub connection for CodeBuild (required for staging/production)
pulumi config set githubConnectionArn arn:aws:codestar-connections:us-east-1:123456789:connection/abc-123
```

To create a GitHub connection:
1. Go to AWS Console → Developer Tools → Connections
2. Create a new connection to GitHub
3. Complete the OAuth flow
4. Copy the connection ARN

### Optional Configuration

```bash
# Cloudflare zone ID for DNS and TLS (optional but recommended)
pulumi config set cloudflareZoneId your-zone-id
```

To find your Cloudflare zone ID:
1. Log into Cloudflare Dashboard
2. Select your domain
3. The Zone ID is in the right sidebar under "API"

## Stack Naming

Tack expects specific stack names that control behavior:

| Stack Name | Environment | Cluster Type | Storage | Build Method |
|------------|-------------|--------------|---------|--------------|
| `development` | Local | Minikube | MinIO | Local Docker |
| `local-staging` | Local | Minikube | MinIO | Local Docker |
| `staging` | AWS | EKS | S3 | CodeBuild |
| `production` | AWS | EKS | S3 | CodeBuild |

Create stacks using these exact names:

```bash
# Local development
pulumi stack init development

# Production
pulumi stack init production
```

## Your First Project

### Step 1: Create a New Pulumi Project

```bash
mkdir my-infra && cd my-infra
pulumi new typescript
```

### Step 2: Install Dependencies

```bash
npm install @sf-tensor/tack @pulumi/aws @pulumi/kubernetes
```

### Step 3: Write Your Infrastructure

Replace `index.ts` with:

```typescript
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

// Define your region
const region: Region = "us-east-1";

// =============================================================================
// NETWORKING
// =============================================================================

// Create a VPC (skipped on local stacks)
const vpc = createVpc({
  id: "main-vpc",
  name: `my-app-vpc-${currentStack}`,
  cidrBlock: "10.0.0.0/16",
  region
});

// Create subnets
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

// Create Kubernetes cluster
const cluster = createCluster({
  id: "main-cluster",
  region,
  vpc,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        {
          production: ["m6gd.xlarge"],
          staging: ["m6gd.large"]
        },
        ["m6gd.large"]  // default for local stacks
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

// Create deployment manager for automated deployments
const deploymentManager = createDeploymentManager({
  id: "deploy-manager",
  region,
  cluster,
  managerRepository: { type: "github", org: "your-org", repo: "cicd-manager" },
  managerBranch: "main"
});

// =============================================================================
// STORAGE
// =============================================================================

// Create a bucket for application data
const dataBucket = createBucket({
  id: "data-bucket",
  bucketName: `my-app-data-${currentStack}`,
  isPublic: false,
  region
});

// =============================================================================
// APPLICATION
// =============================================================================

// Deploy your application
const app = createBunApp({
  id: "web-app",
  runtime: "next",
  localPath: "../my-next-app",  // Path to your Next.js app
  repository: { type: "github", org: "your-org", repo: "my-next-app" },
  branch: "main",

  env: [
    { name: "NODE_ENV", value: stackSwitch({ production: "production" }, "development") },
    ...dataBucket.getEnvEntries("DATA")  // Adds DATA_BUCKET, DATA_ENDPOINT, etc.
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

// Grant the app read-write access to the bucket
app.role.grantBucketAccess([dataBucket], "read-write");

// =============================================================================
// EXPORTS
// =============================================================================

export const bucketName = dataBucket.name;
export const bucketEndpoint = dataBucket.endpoint;
```

### Step 4: Configure and Deploy

```bash
# Initialize your stack
pulumi stack init development

# For production, set required config
pulumi config set githubConnectionArn <your-arn>

# Preview changes
pulumi preview

# Deploy
pulumi up
```

## Project Structure

A typical Tack project looks like:

```
my-infra/
├── Pulumi.yaml              # Pulumi project file
├── Pulumi.development.yaml  # Development stack config
├── Pulumi.staging.yaml      # Staging stack config
├── Pulumi.production.yaml   # Production stack config
├── index.ts                 # Infrastructure code
├── package.json
└── tsconfig.json
```

## Common Errors and Solutions

### "githubConnectionArn is required"

**Cause**: Running `pulumi up` on a non-local stack without configuring GitHub connection.

**Solution**:
```bash
pulumi config set githubConnectionArn <your-connection-arn>
```

### "vpcId is not available for local stacks"

**Cause**: Calling `vpc.vpcId()` on a local stack where no real VPC exists.

**Solution**: Use `isLocalStack()` to conditionally access production-only properties:
```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

if (!isLocalStack(currentStack)) {
  console.log(vpc.vpcId());
}
```

### "Cannot connect to Minikube"

**Cause**: Minikube is not running or not configured.

**Solution**:
```bash
# Start Minikube
minikube start

# Verify kubectl can connect
kubectl get nodes
```

### "AWS credentials not found"

**Cause**: AWS CLI not configured or credentials expired.

**Solution**:
```bash
# Configure AWS CLI
aws configure

# Or for SSO
aws sso login
```

## Next Steps

Now that you have a basic project running:

1. **Learn Core Concepts** - Read [CORE_CONCEPTS.md](./CORE_CONCEPTS.md) to understand stacks, the Resource pattern, and stack-switching
2. **Add a Database** - See [DATABASE.md](./DATABASE.md) for RDS/PostgreSQL setup
3. **Configure CI/CD** - See [CICD.md](./CICD.md) for CodeBuild integration
4. **Set Up Custom Domains** - See [LOAD_BALANCER.md](./LOAD_BALANCER.md) for ALB and DNS configuration
5. **Explore Examples** - See [EXAMPLES.md](./EXAMPLES.md) for complete, runnable examples

## Quick Reference

### Import Everything

```typescript
import {
  // Core
  currentStack,
  stackSwitch,
  isLocalStack,
  type Region,
  type Stack,

  // Networking
  createVpc,

  // Cluster
  createCluster,

  // Apps
  createBunApp,
  type BunAppConfig,
  type EnvEntry,

  // Storage
  createBucket,

  // Database
  createDatabaseInstance,

  // CI/CD
  createDeploymentManager,

  // Load Balancing
  createLoadBalancer,

  // DNS & Certs
  createDnsRecord,
  createCertificate,

  // IAM
  createOidcRole
} from "@sf-tensor/tack";
```

### Stack-Conditional Values

```typescript
const instanceType = stackSwitch(
  {
    production: "m6gd.2xlarge",
    staging: "m6gd.large"
  },
  "m6gd.medium"  // default for development/local-staging
);
```

### Check Current Stack

```typescript
import { currentStack, isLocalStack } from "@sf-tensor/tack";

console.log(`Deploying to: ${currentStack}`);

if (isLocalStack(currentStack)) {
  console.log("Running locally with Minikube");
} else {
  console.log("Running on AWS with EKS");
}
```
