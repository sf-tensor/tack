# Cluster

This document covers EKS cluster creation and configuration in Tack.

## Table of Contents

- [Overview](#overview)
- [createCluster](#createcluster)
- [Cluster Class](#cluster-class)
- [Node Groups](#node-groups)
- [Built-in Add-ons](#built-in-add-ons)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's cluster module creates fully configured EKS clusters with managed node groups, security, and essential add-ons. On local stacks, it returns a Kubernetes provider pointing to Minikube.

### Stack Behavior

| Stack | Cluster Type | Features |
|-------|--------------|----------|
| development | Minikube provider | Basic K8s access |
| local-staging | Minikube provider | Basic K8s access |
| staging | EKS | Full EKS with add-ons |
| production | EKS | Full EKS with add-ons + deletion protection |

---

## createCluster

Creates an EKS cluster with managed node groups and supporting infrastructure.

### Signature

```typescript
function createCluster(args: ResourceArgs<ClusterConfig>): Cluster
```

### ClusterConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique cluster identifier |
| `region` | `Region` | Yes | AWS region |
| `vpc` | `Vpc` | Yes | VPC to deploy cluster in |
| `nodeGroups` | `ClusterNodeGroupConfig[]` | Yes | Node group configurations |
| `privateSubnets` | `Subnet[]` | Yes | Private subnets for nodes |
| `publicSubnets` | `Subnet[]` | Yes | Public subnets for load balancers |
| `deletionProtection` | `boolean` | No | Prevent cluster deletion (default: true for production) |
| `deps` | `pulumi.Resource[]` | No | Resources cluster depends on |

### Basic Example

```typescript
import {
  createVpc,
  createCluster,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const vpc = createVpc({
  id: "vpc",
  name: "my-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

const publicSubnet = vpc.createSubnet({
  id: "public-1",
  name: "public-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.1.0/24",
  region
});

const privateSubnet = vpc.createSubnet({
  id: "private-1",
  name: "private-1",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.10.0/24",
  region
});

const cluster = createCluster({
  id: "main-cluster",
  region,
  vpc,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        { production: ["m6gd.xlarge"], staging: ["m6gd.large"] },
        ["m6gd.large"]
      ),
      scalingConfig: { minSize: 1, maxSize: 5, desiredSize: 2 },
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets: [privateSubnet],
  publicSubnets: [publicSubnet]
});
```

---

## Cluster Class

The `Cluster` class wraps an EKS cluster (or Minikube provider on local stacks).

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `k8s.Provider` | Kubernetes provider for deploying resources |

### Methods

#### clusterSecurityGroupId

Returns the cluster security group ID. Throws on local stacks.

```typescript
get clusterSecurityGroupId(): pulumi.Output<string>
```

**Example:**

```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

// Use for database access rules
if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("cluster-access", cluster.clusterSecurityGroupId);
}
```

#### dependencies()

Returns resources the cluster depends on (node groups, add-ons).

```typescript
dependencies(): pulumi.Resource[]
```

**Example:**

```typescript
// Ensure resources wait for cluster to be ready
new k8s.core.v1.ConfigMap("app-config", {
  // ...
}, {
  provider: cluster.provider,
  dependsOn: cluster.dependencies()
});
```

#### backing()

Access the underlying implementation.

```typescript
// Production backing
interface AWSClusterBacking {
  cluster: eks.Cluster;
  provider: k8s.Provider;
  nodeGroups: eks.ManagedNodeGroup[];
  clusterSecurityGroupId: pulumi.Output<string>;
}

// Local backing
interface LocalBacking {
  provider: k8s.Provider;
}
```

**Example:**

```typescript
if (!isLocalStack(currentStack)) {
  const eksCluster = cluster.backing('prod').cluster;

  // Access EKS-specific properties
  export const oidcArn = eksCluster.oidcProviderArn;
  export const oidcUrl = eksCluster.oidcProviderUrl;
}
```

---

## Node Groups

Node groups define the compute resources for your cluster.

### ClusterNodeGroupConfig

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Node group identifier |
| `instanceTypes` | `string[]` | Yes | EC2 instance types |
| `amiType` | `string` | Yes | AMI type (see below) |
| `scalingConfig` | `ScalingConfig` | Yes | Auto-scaling configuration |
| `storage` | `StorageConfig` | Yes | Storage configuration |

### AMI Types

| AMI Type | Architecture | OS |
|----------|--------------|-----|
| `BOTTLEROCKET_ARM_64` | ARM64 | Bottlerocket |
| `BOTTLEROCKET_x86_64` | x86_64 | Bottlerocket |
| `AL2_ARM_64` | ARM64 | Amazon Linux 2 |
| `AL2_x86_64` | x86_64 | Amazon Linux 2 |

**Recommendation**: Use `BOTTLEROCKET_ARM_64` for best security and cost efficiency.

### Scaling Configuration

```typescript
interface ScalingConfig {
  minSize: number;     // Minimum nodes
  maxSize: number;     // Maximum nodes
  desiredSize: number; // Initial node count
}
```

**Example:**

```typescript
scalingConfig: stackSwitch(
  {
    production: { minSize: 3, maxSize: 20, desiredSize: 5 },
    staging: { minSize: 1, maxSize: 5, desiredSize: 2 }
  },
  { minSize: 1, maxSize: 2, desiredSize: 1 }
)
```

### Storage Configuration

Two storage options are available:

#### Option 1: NVMe Instance Store

Uses instance storage (ephemeral). Best for high-performance workloads.

```typescript
storage: { type: "nvme-instance-store" }
```

**Supported instances**: `m6gd`, `c6gd`, `r6gd`, `i3`, `i4i` families

**Bottlerocket behavior**: Tack automatically configures Bottlerocket to use ephemeral storage for containerd and kubelet via bootstrap commands.

#### Option 2: EBS Storage

Uses persistent EBS volumes. Best for workloads needing data persistence.

```typescript
storage: {
  type: "ebs",
  ebsDiskSize: 100  // Size in GB (default: 50)
}
```

### Multiple Node Groups

Define different node groups for different workload types:

```typescript
const cluster = createCluster({
  // ...
  nodeGroups: [
    // General purpose nodes
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["m6gd.large"],
      scalingConfig: { minSize: 2, maxSize: 10, desiredSize: 3 },
      storage: { type: "nvme-instance-store" }
    },
    // Compute-optimized nodes
    {
      id: "compute",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["c6gd.xlarge"],
      scalingConfig: { minSize: 0, maxSize: 10, desiredSize: 0 },
      storage: { type: "nvme-instance-store" }
    },
    // Memory-optimized nodes
    {
      id: "memory",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["r6gd.large"],
      scalingConfig: { minSize: 0, maxSize: 5, desiredSize: 0 },
      storage: { type: "nvme-instance-store" }
    }
  ]
});
```

---

## Built-in Add-ons

Tack automatically installs these add-ons on production clusters:

### 1. KMS Encryption

Kubernetes secrets are encrypted at rest using a dedicated KMS key.

```typescript
// Key is auto-created with:
// - Key rotation enabled
// - 7-day deletion window
// - EKS service permissions
```

### 2. AWS Load Balancer Controller

Manages ALB/NLB for Kubernetes Ingress and Service resources.

```typescript
// Installed via Helm with:
// - OIDC-based IAM role
// - Service account annotation
// - VPC and cluster configuration
```

### 3. CSI Secrets Store Driver

Mounts AWS Secrets Manager secrets as Kubernetes volumes.

```typescript
// Installed with:
// - Secret sync to K8s secrets enabled
// - 5-minute rotation polling
// - AWS provider configured
```

### 4. OIDC Provider

Enables IAM Roles for Service Accounts (IRSA).

```typescript
// Auto-created, access via:
cluster.backing('prod').cluster.oidcProviderArn
cluster.backing('prod').cluster.oidcProviderUrl
```

---

## Complete Examples

### Example 1: Production-Ready Cluster

```typescript
import {
  createVpc,
  createCluster,
  stackSwitch,
  currentStack,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";
const azs = ["a", "b", "c"];

// Create VPC
const vpc = createVpc({
  id: "vpc",
  name: `app-vpc-${currentStack}`,
  cidrBlock: "10.0.0.0/16",
  region
});

// Create subnets in each AZ
const publicSubnets = azs.map((az, i) =>
  vpc.createSubnet({
    id: `public-${az}`,
    name: `public-${az}`,
    availabilityZone: `${region}${az}`,
    cidrBlock: `10.0.${i + 1}.0/24`,
    region
  })
);

const privateSubnets = azs.map((az, i) =>
  vpc.createSubnet({
    id: `private-${az}`,
    name: `private-${az}`,
    availabilityZone: `${region}${az}`,
    cidrBlock: `10.0.${i + 10}.0/24`,
    region
  })
);

// Create cluster
const cluster = createCluster({
  id: "main",
  region,
  vpc,
  deletionProtection: currentStack === "production",
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch(
        {
          production: ["m6gd.xlarge", "m6gd.2xlarge"],
          staging: ["m6gd.large"]
        },
        ["t3.medium"]
      ),
      scalingConfig: stackSwitch(
        {
          production: { minSize: 3, maxSize: 20, desiredSize: 5 },
          staging: { minSize: 1, maxSize: 5, desiredSize: 2 }
        },
        { minSize: 1, maxSize: 2, desiredSize: 1 }
      ),
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets,
  publicSubnets
});

export const clusterProvider = cluster.provider;
```

### Example 2: Multi-Node-Group Cluster

```typescript
const cluster = createCluster({
  id: "multi-workload",
  region,
  vpc,
  nodeGroups: [
    // Web tier - general purpose
    {
      id: "web",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["m6gd.large"],
      scalingConfig: { minSize: 2, maxSize: 10, desiredSize: 3 },
      storage: { type: "nvme-instance-store" }
    },
    // API tier - compute optimized
    {
      id: "api",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["c6gd.xlarge"],
      scalingConfig: { minSize: 2, maxSize: 15, desiredSize: 4 },
      storage: { type: "nvme-instance-store" }
    },
    // Background jobs - spot-friendly
    {
      id: "workers",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: ["m6gd.large", "m6gd.xlarge"],
      scalingConfig: { minSize: 0, maxSize: 20, desiredSize: 2 },
      storage: { type: "ebs", ebsDiskSize: 50 }
    },
    // ML inference - GPU (if needed)
    {
      id: "inference",
      amiType: "AL2_x86_64",  // GPU instances need AL2
      instanceTypes: ["g4dn.xlarge"],
      scalingConfig: { minSize: 0, maxSize: 5, desiredSize: 0 },
      storage: { type: "ebs", ebsDiskSize: 100 }
    }
  ],
  privateSubnets,
  publicSubnets
});
```

### Example 3: Using Cluster with Other Resources

```typescript
import {
  createCluster,
  createBunApp,
  createDatabaseInstance,
  createDeploymentManager,
  isLocalStack,
  currentStack
} from "@sf-tensor/tack";

// Create cluster first
const cluster = createCluster({ /* ... */ });

// Create deployment manager
const deploymentManager = createDeploymentManager({
  id: "deploy",
  region,
  cluster,
  managerRepository: { type: "github", org: "myorg", repo: "manager" },
  managerBranch: "main"
});

// Create database with cluster access
const db = createDatabaseInstance({
  id: "main-db",
  name: "main",
  cluster,
  // ...
});

// Allow cluster to access database
if (!isLocalStack(currentStack)) {
  db.allowAccessFrom("cluster", cluster.clusterSecurityGroupId);
}

// Deploy applications
const app = createBunApp({
  id: "web",
  cluster,
  deploymentManager,
  // ...
});
```

---

## Cluster Configuration Details

### Security Groups

Tack creates security groups with:

- **Cluster security group**: Self-referencing for node-to-node and control plane communication
- **Node security groups**: Via launch templates with cluster SG attached

### IAM Roles

Three roles are created:

1. **Service role**: For EKS control plane
2. **Node worker role**: For EC2 instances with policies:
   - `AmazonEKSWorkerNodePolicy`
   - `AmazonEC2ContainerRegistryReadOnly`
   - `AmazonEKS_CNI_Policy`
3. **Load balancer controller role**: OIDC-based for ALB management

### Networking

- **API server**: Public and private endpoints enabled
- **Pod networking**: IPv4 with default VPC CNI
- **Subnets**: Automatically tagged for EKS load balancer discovery

---

## Best Practices

### 1. Use ARM64 Instances

Graviton processors offer better price/performance:

```typescript
amiType: "BOTTLEROCKET_ARM_64",
instanceTypes: ["m6gd.large"]  // ARM64
```

### 2. Enable Deletion Protection

For production clusters:

```typescript
deletionProtection: currentStack === "production"
```

### 3. Multi-AZ Node Groups

Spread across availability zones for resilience:

```typescript
privateSubnets: [subnetAZa, subnetAZb, subnetAZc]
```

### 4. Right-Size Node Groups

Start small and scale based on metrics:

```typescript
scalingConfig: {
  minSize: 2,      // Minimum for HA
  desiredSize: 2,  // Start at minimum
  maxSize: 20      // Room to grow
}
```

---

## Related Documentation

- [Networking](./NETWORKING.md) - VPC and subnet setup
- [Bun Apps](./BUN_APPS.md) - Deploy applications to cluster
- [Database](./DATABASE.md) - RDS with cluster access
- [CI/CD](./CICD.md) - CodeBuild integration
