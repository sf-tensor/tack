# @sf-tensor/tack

A strongly-typed, stack-aware Pulumi infrastructure-as-code framework for AWS.

## Features

- **Type-safe**: Full TypeScript support with autocomplete for AWS regions, stack types, and resource configurations
- **Stack-aware**: Built-in support for development, local-staging, staging, and production environments
- **Local development**: Seamless local Kubernetes development with MinIO, PostgreSQL, and DevPod
- **Batteries included**: Networking, EKS clusters, RDS databases, S3 buckets, CI/CD pipelines

## Installation

```bash
npm install @sf-tensor/tack @pulumi/pulumi
```

## Quick Start

```typescript
import {
  NetworkBuilder,
  createCluster,
  createApp,
  createLoadBalancer,
  createDatabaseInstance,
  createBucket
} from '@sf-tensor/tack'

// Plan your network with full type safety
const plan = NetworkBuilder
  .vpc([
    { name: 'main', cidrBlock: '10.0.0.0/16', region: 'us-east-2' }
  ] as const, ['us-east-2a', 'us-east-2b'] as const)
  .subnet('public', '/24')
  .subnet('app', '/22')
  .subnet('database', '/25')
  .build()

// Create EKS cluster
const cluster = createCluster({
  id: 'my-cluster',
  region: 'us-east-2',
  vpc: plan.main.vpc,
  subnets: [
    plan.main.subnets['us-east-2a']['app'],
    plan.main.subnets['us-east-2b']['app']
  ],
  nodeGroups: [{
    id: 'default',
    instanceTypes: ['t3.medium'],
    amiType: 'AL2_x86_64',
    scalingConfig: { minSize: 1, maxSize: 3, desiredSize: 2 },
    storage: { type: 'ebs', ebsDiskSize: 50 }
  }]
})

// Create RDS database (or local PostgreSQL in dev)
const database = createDatabaseInstance({
  id: 'my-db',
  region: 'us-east-2',
  vpc: plan.main.vpc,
  subnets: [
    plan.main.subnets['us-east-2a']['database'],
    plan.main.subnets['us-east-2b']['database']
  ],
  instanceClass: 'db.t3.micro',
  allocatedStorage: 20,
  cluster
})

// Deploy your application
const app = createApp({
  id: 'my-app',
  runtime: 'next',
  localPath: './apps/my-app',
  repository: { type: 'github', org: 'my-org', repo: 'my-app' },
  branch: 'main',
  ports: [{ name: 'http', port: 3000 }],
  healthRoute: { path: '/health', port: 3000 },
  env: [
    { name: 'NODE_ENV', value: 'production' },
    ...database.getEnvEntries('DATABASE')
  ],
  cluster,
  deploymentManager
})
```

## Modules

### Networking (`networking/`)
- `NetworkBuilder` - Fluent API for CIDR planning
- `Vpc` - VPC abstraction
- `Subnet` - Subnet management

### Cluster (`cluster/`)
- `createCluster` - EKS cluster creation with node groups, OIDC, and security

### Database (`database/`)
- `createDatabaseInstance` - RDS PostgreSQL (prod) or local K8s PostgreSQL (dev)
- `Database`, `DatabaseUser` - Connection helpers

### Bucket (`bucket/`)
- `createBucket` - S3 (prod) or MinIO (dev) storage

### App (`app/`)
- `createApp` - Containerized application deployment
- `createBunApp` - Backwards-compatible alias
- DevPod support for local development

### CI/CD (`cicd/`)
- `createDeploymentManager` - CodeBuild pipelines and ECR repositories

### Load Balancer (`loadbalancer/`)
- `createLoadBalancer` - ALB (prod) or nginx ingress (local)

### Certificate (`certificate/`)
- `createCertificate` - ACM certificates with Cloudflare DNS validation

### DNS (`dns/`)
- `createDnsRecord` - Cloudflare DNS records

## Stack-Aware Development

Tack automatically adapts to your Pulumi stack:

| Stack | Database | Storage | Cluster | Secrets |
|-------|----------|---------|---------|---------|
| `development` | K8s PostgreSQL | MinIO | Minikube | Local files |
| `local-staging` | K8s PostgreSQL | MinIO | Minikube | Local files |
| `staging` | RDS | S3 | EKS | Secrets Manager |
| `production` | RDS | S3 | EKS | Secrets Manager |

## Configuration

You can configure tack explicitly or let it auto-detect from Pulumi:

```typescript
import { configure } from '@sf-tensor/tack'

// Optional: explicitly configure
configure({
  stack: 'production',
  githubConnectionArn: 'arn:aws:codestar-connections:...'
})
```

## License

MIT
