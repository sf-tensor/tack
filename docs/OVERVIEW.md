# Overview

Tack is an opinionated Pulumi library for running AWS + Kubernetes infrastructure. It's designed around three core pillars:

1. **Conventional VPC + EKS foundation** - Production-ready networking and Kubernetes clusters
2. **CodeBuild CI/CD flow** - Automated builds and deployments via a deployment manager
3. **DevPod workflow** - First-class local development against a real cluster

## Philosophy

Tack reflects how we run our own infrastructure. It's not a generic, multi-tenant platform—it's a composition library with strong opinions:

- **Bottlerocket OS** for EKS nodes (security-focused, minimal attack surface)
- **CodeBuild** for CI/CD (tight AWS integration, no external services)
- **Cloudflare** for DNS and TLS (simple, reliable, fast propagation)
- **Stack-aware resources** that adapt to local vs. production environments

If your workflows look similar, use it directly. If not, fork and adapt it.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              PULUMI PROGRAM                                │
│                                                                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   createVpc │  │createCluster│  │ createBucket│  │createBunApp │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
└─────────┼────────────────┼────────────────┼────────────────┼───────────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STACK DETECTION                                   │
│                                                                             │
│         currentStack === 'development' || 'local-staging'                   │
│                              ? LOCAL                                        │
│                              : AWS                                          │
└─────────────────────────────────────────────────────────────────────────────┘
          │                                                  │
          ▼                                                  ▼
┌──────────────────────────────┐       ┌──────────────────────────────────────┐
│       LOCAL RESOURCES        │       │           AWS RESOURCES              │
│                              │       │                                      │
│  ┌────────────────────────┐  │       │  ┌────────────────────────────────┐  │
│  │      Minikube          │  │       │  │            EKS                 │  │
│  │   (K8s Provider)       │  │       │  │  ┌──────────────────────────┐  │  │
│  └────────────────────────┘  │       │  │  │  Managed Node Groups     │  │  │
│                              │       │  │  │  - Bottlerocket AMI      │  │  │
│  ┌────────────────────────┐  │       │  │  │  - NVMe or EBS storage   │  │  │
│  │       MinIO            │  │       │  │  └──────────────────────────┘  │  │
│  │   (S3-compatible)      │  │       │  │  ┌──────────────────────────┐  │  │
│  └────────────────────────┘  │       │  │  │  Add-ons                 │  │  │
│                              │       │  │  │  - AWS LB Controller     │  │  │
│  ┌────────────────────────┐  │       │  │  │  - CSI Secrets Driver    │  │  │
│  │   PostgreSQL Pod       │  │       │  │  │  - OIDC Provider         │  │  │
│  │   (In-cluster DB)      │  │       │  │  └──────────────────────────┘  │  │
│  └────────────────────────┘  │       │  └────────────────────────────────┘  │
│                              │       │                                      │
│  ┌────────────────────────┐  │       │  ┌────────────────────────────────┐  │
│  │    nginx Ingress       │  │       │  │           S3 Buckets           │  │
│  └────────────────────────┘  │       │  └────────────────────────────────┘  │
│                              │       │                                      │
│  ┌────────────────────────┐  │       │  ┌────────────────────────────────┐  │
│  │      DevPod            │  │       │  │        RDS PostgreSQL          │  │
│  │  - File sync           │  │       │  │  - Multi-AZ optional           │  │
│  │  - Port forwarding     │  │       │  │  - Automated backups           │  │
│  └────────────────────────┘  │       │  └────────────────────────────────┘  │
│                              │       │                                      │
└──────────────────────────────┘       │  ┌────────────────────────────────┐  │
                                       │  │           ALB                  │  │
                                       │  │  - ACM Certificates            │  │
                                       │  │  - Cloudflare DNS              │  │
                                       │  └────────────────────────────────┘  │
                                       │                                      │
                                       │  ┌────────────────────────────────┐  │
                                       │  │         CodeBuild              │  │
                                       │  │  - GitHub webhooks             │  │
                                       │  │  - ECR push                    │  │
                                       │  │  - SQS task queue              │  │
                                       │  └────────────────────────────────┘  │
                                       │                                      │
                                       └──────────────────────────────────────┘
```

## Module Dependency Graph

```
                                    ┌─────────┐
                                    │  types  │
                                    │ (core)  │
                                    └────┬────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
       ┌────────────┐            ┌─────────────┐           ┌─────────────┐
       │ networking │            │   cluster   │           │   bucket    │
       │  (vpc)     │            │   (eks)     │           │  (s3/minio) │
       └─────┬──────┘            └──────┬──────┘           └─────────────┘
             │                          │
             │                          │
             ▼                          ▼
       ┌────────────┐            ┌─────────────┐
       │  database  │◄───────────│    bun      │
       │ (rds/pg)   │            │   (apps)    │
       └────────────┘            └──────┬──────┘
                                        │
                         ┌──────────────┼──────────────┐
                         │              │              │
                         ▼              ▼              ▼
                  ┌────────────┐ ┌────────────┐ ┌────────────┐
                  │    cicd    │ │loadbalancer│ │  secrets   │
                  │ (codebuild)│ │  (alb/ng)  │ │   (k8s)    │
                  └────────────┘ └─────┬──────┘ └────────────┘
                                       │
                              ┌────────┴────────┐
                              │                 │
                              ▼                 ▼
                       ┌────────────┐    ┌────────────┐
                       │certificate │    │    dns     │
                       │   (acm)    │    │(cloudflare)│
                       └────────────┘    └────────────┘
```

## Modules

| Module | Purpose | Local Implementation | AWS Implementation |
|--------|---------|---------------------|-------------------|
| `networking/*` | VPCs, subnets, CIDR planning | No-op (returns empty) | AWS VPC, Subnets |
| `cluster` | Kubernetes clusters | Minikube provider | EKS with add-ons |
| `bucket` | Object storage | MinIO in-cluster | S3 buckets |
| `database` | PostgreSQL databases | In-cluster PostgreSQL | RDS PostgreSQL |
| `bun` | App deployment | DevPod with file sync | K8s Deployment + CodeBuild |
| `cicd/*` | Build pipelines | Stub (no-op) | CodeBuild, ECR, SQS |
| `loadbalancer` | Traffic routing | nginx Ingress | ALB with ACM certs |
| `dns` | DNS records | Skipped | Cloudflare CNAME |
| `certificate` | TLS certificates | Skipped | ACM with DNS validation |
| `iam` | AWS IAM roles | Skipped | OIDC-based roles |
| `secrets` | Secret management | K8s Secrets | K8s + AWS Secrets Manager |
| `docker` | Container building | Local Docker build | CodeBuild |

## Key Design Decisions

### Why Bottlerocket?

We use [Bottlerocket](https://aws.amazon.com/bottlerocket/) for EKS nodes because:
- Minimal OS footprint reduces attack surface
- Automatic security updates without node replacement
- Immutable root filesystem
- Built-in support for NVMe instance storage

### Why CodeBuild?

We chose CodeBuild over GitHub Actions or external CI because:
- Native AWS IAM integration (no credential management)
- Direct ECR access without docker login
- VPC connectivity for accessing private resources
- Pay-per-build pricing

### Why Cloudflare?

We use Cloudflare for DNS and TLS because:
- Fast global DNS propagation
- Simple API for automation
- Free SSL certificates
- DDoS protection included

### Why a Deployment Manager?

The deployment manager pattern separates concerns:
- CodeBuild builds images (stateless, scalable)
- Deployment manager updates Kubernetes (stateful, careful)
- SQS provides reliable task delivery
- In-cluster manager has direct K8s API access

## Library vs Framework

Tack is a **library**, not a framework. This means:

- **You compose the pieces** in your Pulumi program
- **You control the execution order** and dependencies
- **You can use parts independently** (just VPC, just buckets, etc.)
- **You can extend or modify** by wrapping or forking

```typescript
// You write this—Tack doesn't hide it from you
const vpc = createVpc({ /* ... */ });
const cluster = createCluster({ vpc, /* ... */ });
const bucket = createBucket({ /* ... */ });

// You can add your own resources alongside Tack's
const customAlarm = new aws.cloudwatch.MetricAlarm({ /* ... */ });
```

## When to Use Tack

**Good fit:**
- Building on AWS with EKS
- Deploying Bun/Next.js applications
- Using GitHub for source control
- Want local development with file sync
- Comfortable with opinionated choices

**Not a good fit:**
- Multi-cloud requirements
- Need GovCloud support
- Using non-GitHub source control
- Require heavy customization of every component
- Prefer raw Terraform/CloudFormation

## Documentation Map

| Document | Purpose |
|----------|---------|
| [Getting Started](./GETTING_STARTED.md) | First project setup |
| [Core Concepts](./CORE_CONCEPTS.md) | Stacks, types, patterns |
| [Networking](./NETWORKING.md) | VPC, subnets, CIDR |
| [Cluster](./CLUSTER.md) | EKS configuration |
| [Bun Apps](./BUN_APPS.md) | Application deployment |
| [Buckets](./BUCKETS.md) | S3/MinIO storage |
| [Database](./DATABASE.md) | RDS/PostgreSQL |
| [DevPod](./DEV_POD.md) | Local development |
| [Deployment Manager](./DEPLOYMENT_MANAGER.md) | CI/CD orchestration |
| [CI/CD](./CICD.md) | CodeBuild, ECR |
| [Load Balancer](./LOAD_BALANCER.md) | ALB, certificates, DNS |
| [IAM](./IAM.md) | OIDC roles |
| [Secrets](./SECRETS.md) | Secret management |
| [Examples](./EXAMPLES.md) | Complete code examples |
