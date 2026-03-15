# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-15

### Added

- Bun apps can now define `containers[]` as separate workload definitions under a single `createBunApp` call.
- Each Bun workload can override app-level `env`, `ports`, and `healthRoute`.
- `BunApp` now exposes `services` and `deployments` maps in addition to the primary `service` and `deployment`.

### Changed

- Multi-container Bun apps are now rendered as separate Deployments and Services instead of multiple containers inside one pod.
- Each Bun workload now gets its own ECR repository, CodeBuild project, and application image built from its specific `buildTask`.
- Local development and local-staging now instantiate one workload per configured Bun container so per-workload ports and env overrides are preserved across stacks.

### Documentation

- Documented the Bun workload model, per-workload routing, and per-workload CI/CD behavior in the Bun app, load balancer, CI/CD, and README docs.

## [0.0.6] - 2026-02-05

### Added

- Initial open-source release
- Pulumi components for AWS infrastructure:
  - EKS cluster management
  - VPC configuration
  - Aurora PostgreSQL and MySQL database support
  - S3 bucket management
  - CloudFront distribution
  - Secrets management via AWS Secrets Manager
- Kubernetes components:
  - Deployment management
  - Service configuration
  - Ingress with AWS ALB support
  - ConfigMap and Secret management
  - CronJob support
- Cloudflare integration for DNS management
