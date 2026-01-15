# Overview

Tack is a set of Pulumi components for running a fairly opinionated AWS + Kubernetes stack. It centers on three ideas:

1) A conventional VPC + EKS foundation.
2) A CI/CD flow built around CodeBuild and a deployment manager.
3) A DevPod workflow for local development in a real cluster.

## Modules

- `networking/*`: VPCs, subnets, and a CIDR planner.
- `cluster`: EKS clusters and supporting add-ons.
- `bucket`: S3 + local MinIO buckets.
- `database`: RDS Postgres (prod) + in-cluster Postgres (local).
- `dns` + `certificate`: Cloudflare + ACM helpers.
- `cicd/*`: CodeBuild projects, ECR repos, IAM, queues, and deployment manager wiring.
- `app` + `bun`: App deployment workflows for Next.js or Bun-based services.

This is a library, not a framework. You are expected to compose the pieces in your Pulumi program and adapt where needed.
