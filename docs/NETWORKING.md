# Networking

This document covers VPC, subnet, and CIDR utilities in Tack.

## Table of Contents

- [Overview](#overview)
- [createVpc](#createvpc)
- [Vpc Class](#vpc-class)
- [Subnet Class](#subnet-class)
- [CIDR Utilities](#cidr-utilities)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's networking module provides abstractions for AWS VPC and subnet creation. On local stacks, these resources are no-ops (return empty objects) since Minikube handles networking internally.

### Stack Behavior

| Stack | VPC | Subnets | Internet Gateway |
|-------|-----|---------|------------------|
| development | No-op | No-op | No-op |
| local-staging | No-op | No-op | No-op |
| staging | AWS VPC | AWS Subnets | Required |
| production | AWS VPC | AWS Subnets | Required |

---

## createVpc

Creates a VPC with DNS support and IPv6 enabled.

### Signature

```typescript
function createVpc(args: ResourceArgs<{
  name: string;
  cidrBlock: string;
}>): Vpc
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique resource identifier |
| `region` | `Region` | Yes | AWS region |
| `name` | `string` | Yes | VPC name (used in tags) |
| `cidrBlock` | `string` | Yes | IPv4 CIDR block (e.g., `"10.0.0.0/16"`) |
| `deps` | `pulumi.Resource[]` | No | Resources this VPC depends on |

### Example

```typescript
import { createVpc, type Region } from "@sf-tensor/tack";

const region: Region = "us-east-1";

const vpc = createVpc({
  id: "main-vpc",
  name: "production-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

// Access VPC ID (production only)
export const vpcId = vpc.vpcId();
```

### VPC Configuration

The VPC is created with:
- DNS support enabled (`enableDnsSupport: true`)
- DNS hostnames enabled (`enableDnsHostnames: true`)
- IPv6 CIDR block auto-assigned (`assignGeneratedIpv6CidrBlock: true`)
- Stack name tag for identification

---

## Vpc Class

The `Vpc` class wraps an AWS VPC and provides methods for subnet creation.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| (internal) | `aws.ec2.Vpc` | The underlying AWS VPC (accessible via `backing('prod')`) |

### Methods

#### vpcId()

Returns the VPC ID. Throws an error on local stacks.

```typescript
vpcId(): pulumi.Output<string>
```

**Example:**

```typescript
import { createVpc, isLocalStack, currentStack } from "@sf-tensor/tack";

const vpc = createVpc({ /* ... */ });

// Safe access
if (!isLocalStack(currentStack)) {
  console.log(vpc.vpcId());
}

// Or export directly (will fail on local)
export const vpcId = vpc.vpcId();
```

#### createSubnet(args)

Creates a subnet within the VPC.

```typescript
createSubnet(args: ResourceArgs<{
  name: string;
  availabilityZone: string;
  cidrBlock: string;
}>): Subnet
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Unique subnet identifier |
| `region` | `Region` | Yes | AWS region |
| `name` | `string` | Yes | Subnet name (used in tags) |
| `availabilityZone` | `string` | Yes | AZ (e.g., `"us-east-1a"`) |
| `cidrBlock` | `string` | Yes | IPv4 CIDR block for this subnet |
| `deps` | `pulumi.Resource[]` | No | Resources this subnet depends on |

**Example:**

```typescript
const publicSubnet = vpc.createSubnet({
  id: "public-1",
  name: "public-subnet-1",
  availabilityZone: "us-east-1a",
  cidrBlock: "10.0.1.0/24",
  region
});

const privateSubnet = vpc.createSubnet({
  id: "private-1",
  name: "private-subnet-1",
  availabilityZone: "us-east-1a",
  cidrBlock: "10.0.10.0/24",
  region
});
```

---

## Subnet Class

The `Subnet` class wraps an AWS subnet.

### Methods

#### subnetId()

Returns the subnet ID. Throws an error on local stacks.

```typescript
subnetId(): pulumi.Output<string>
```

**Example:**

```typescript
const subnet = vpc.createSubnet({ /* ... */ });

// Use in EKS cluster configuration
const cluster = createCluster({
  // ...
  privateSubnets: [subnet],
  publicSubnets: []
});
```

---

## CIDR Utilities

Tack provides utilities for CIDR block management and IP allocation.

### SubnetAllocation

A class for allocating IP addresses within a CIDR block.

```typescript
class SubnetAllocation {
  constructor(cidrBlock: string)
  next(): string           // Get next available CIDR and advance
  peek(): string           // Get next CIDR without advancing
  reset(): void            // Reset to beginning
  remaining(): number      // Count remaining allocatable addresses
}
```

**Example:**

```typescript
import { SubnetAllocation } from "@sf-tensor/tack";

const allocator = new SubnetAllocation("10.0.0.0/16");

// Allocate /24 subnets
const subnet1Cidr = allocator.next();  // "10.0.0.0/24"
const subnet2Cidr = allocator.next();  // "10.0.1.0/24"

// Peek at next without consuming
const nextCidr = allocator.peek();     // "10.0.2.0/24"
const sameCidr = allocator.peek();     // Still "10.0.2.0/24"

// Check remaining capacity
console.log(allocator.remaining());    // Number of remaining /24 blocks
```

### parseCidr(cidr)

Parse a CIDR string into its components.

```typescript
function parseCidr(cidr: string): {
  ip: number;           // 32-bit IP as integer
  prefixLength: number; // Subnet mask length
  mask: number;         // 32-bit subnet mask
}
```

**Example:**

```typescript
import { parseCidr } from "@sf-tensor/tack";

const result = parseCidr("10.0.0.0/16");
// result.ip = 167772160 (10.0.0.0 as integer)
// result.prefixLength = 16
// result.mask = 4294901760 (255.255.0.0 as integer)
```

### ipToString(ip)

Convert a 32-bit integer IP to dotted decimal notation.

```typescript
function ipToString(ip: number): string
```

**Example:**

```typescript
import { ipToString } from "@sf-tensor/tack";

const ip = ipToString(167772160);  // "10.0.0.0"
const ip2 = ipToString(167772161); // "10.0.0.1"
```

### stringToIp(ip)

Convert a dotted decimal IP string to a 32-bit integer.

```typescript
function stringToIp(ip: string): number
```

**Example:**

```typescript
import { stringToIp } from "@sf-tensor/tack";

const num = stringToIp("10.0.0.0");   // 167772160
const num2 = stringToIp("192.168.1.1"); // 3232235777
```

### alignToSubnetBoundary(ip, prefixLength)

Align an IP address to a subnet boundary.

```typescript
function alignToSubnetBoundary(ip: number, prefixLength: number): number
```

**Example:**

```typescript
import { alignToSubnetBoundary, stringToIp, ipToString } from "@sf-tensor/tack";

const ip = stringToIp("10.0.5.37");
const aligned = alignToSubnetBoundary(ip, 24);
console.log(ipToString(aligned));  // "10.0.5.0"
```

---

## Complete Examples

### Example 1: Basic VPC with Public and Private Subnets

```typescript
import {
  createVpc,
  createCluster,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

// Create VPC
const vpc = createVpc({
  id: "main-vpc",
  name: "my-app-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

// Public subnets (for load balancers)
const publicSubnet1 = vpc.createSubnet({
  id: "public-1a",
  name: "public-subnet-1a",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.1.0/24",
  region
});

const publicSubnet2 = vpc.createSubnet({
  id: "public-1b",
  name: "public-subnet-1b",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.2.0/24",
  region
});

// Private subnets (for EKS nodes and databases)
const privateSubnet1 = vpc.createSubnet({
  id: "private-1a",
  name: "private-subnet-1a",
  availabilityZone: `${region}a`,
  cidrBlock: "10.0.10.0/24",
  region
});

const privateSubnet2 = vpc.createSubnet({
  id: "private-1b",
  name: "private-subnet-1b",
  availabilityZone: `${region}b`,
  cidrBlock: "10.0.11.0/24",
  region
});

// Use with cluster
const cluster = createCluster({
  id: "main-cluster",
  region,
  vpc,
  nodeGroups: [/* ... */],
  privateSubnets: [privateSubnet1, privateSubnet2],
  publicSubnets: [publicSubnet1, publicSubnet2]
});
```

### Example 2: Multi-AZ Setup with CIDR Allocator

```typescript
import {
  createVpc,
  SubnetAllocation,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";
const azs = ["a", "b", "c"];

// Create VPC
const vpc = createVpc({
  id: "main-vpc",
  name: "multi-az-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

// Use allocator for consistent CIDR assignment
const publicAllocator = new SubnetAllocation("10.0.0.0/20");
const privateAllocator = new SubnetAllocation("10.0.128.0/17");

// Create subnets across all AZs
const publicSubnets = azs.map((az, i) =>
  vpc.createSubnet({
    id: `public-${az}`,
    name: `public-subnet-${az}`,
    availabilityZone: `${region}${az}`,
    cidrBlock: publicAllocator.next(),
    region
  })
);

const privateSubnets = azs.map((az, i) =>
  vpc.createSubnet({
    id: `private-${az}`,
    name: `private-subnet-${az}`,
    availabilityZone: `${region}${az}`,
    cidrBlock: privateAllocator.next(),
    region
  })
);
```

### Example 3: Adding Internet Gateway and NAT Gateway

Tack's VPC doesn't automatically create internet/NAT gateways. Add them manually if needed:

```typescript
import * as aws from "@pulumi/aws";
import { createVpc, isLocalStack, currentStack, type Region } from "@sf-tensor/tack";

const region: Region = "us-east-1";

const vpc = createVpc({
  id: "main-vpc",
  name: "complete-vpc",
  cidrBlock: "10.0.0.0/16",
  region
});

// Only create gateways on production stacks
if (!isLocalStack(currentStack)) {
  // Internet Gateway for public subnets
  const igw = new aws.ec2.InternetGateway("main-igw", {
    vpcId: vpc.vpcId(),
    tags: { Name: "main-internet-gateway" }
  });

  // Elastic IP for NAT Gateway
  const natEip = new aws.ec2.Eip("nat-eip", {
    domain: "vpc",
    tags: { Name: "nat-gateway-eip" }
  });

  // NAT Gateway in public subnet
  const publicSubnet = vpc.createSubnet({
    id: "public-1",
    name: "public-subnet-1",
    availabilityZone: `${region}a`,
    cidrBlock: "10.0.1.0/24",
    region
  });

  const natGateway = new aws.ec2.NatGateway("main-nat", {
    subnetId: publicSubnet.subnetId(),
    allocationId: natEip.id,
    tags: { Name: "main-nat-gateway" }
  }, { dependsOn: [igw] });

  // Route tables
  const publicRouteTable = new aws.ec2.RouteTable("public-rt", {
    vpcId: vpc.vpcId(),
    routes: [{
      cidrBlock: "0.0.0.0/0",
      gatewayId: igw.id
    }],
    tags: { Name: "public-route-table" }
  });

  const privateRouteTable = new aws.ec2.RouteTable("private-rt", {
    vpcId: vpc.vpcId(),
    routes: [{
      cidrBlock: "0.0.0.0/0",
      natGatewayId: natGateway.id
    }],
    tags: { Name: "private-route-table" }
  });

  // Associate route tables with subnets
  new aws.ec2.RouteTableAssociation("public-1-assoc", {
    subnetId: publicSubnet.subnetId(),
    routeTableId: publicRouteTable.id
  });
}
```

---

## Best Practices

### 1. Plan CIDR Blocks Carefully

Reserve space for future growth:

```typescript
// Bad: Tight allocation
const vpc = createVpc({ cidrBlock: "10.0.0.0/24", /* ... */ });

// Good: Room to grow
const vpc = createVpc({ cidrBlock: "10.0.0.0/16", /* ... */ });
```

### 2. Use Multiple Availability Zones

For high availability in production:

```typescript
const azs = ["a", "b", "c"];
const privateSubnets = azs.map(az =>
  vpc.createSubnet({
    id: `private-${az}`,
    availabilityZone: `${region}${az}`,
    // ...
  })
);
```

### 3. Separate Public and Private Subnets

- **Public subnets**: Load balancers, bastion hosts
- **Private subnets**: EKS nodes, databases, internal services

### 4. Guard Production-Only Code

```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

if (!isLocalStack(currentStack)) {
  // Create gateways, route tables, etc.
}
```

---

## Related Documentation

- [Cluster](./CLUSTER.md) - Uses VPC and subnets for EKS
- [Database](./DATABASE.md) - Uses subnets for RDS placement
- [Core Concepts](./CORE_CONCEPTS.md) - Stack-aware patterns
