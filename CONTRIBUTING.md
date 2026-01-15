# Contributing to Tack

Thank you for your interest in contributing to Tack! This document provides guidelines for contributing to the project.

## Development Setup

### Prerequisites

- Node.js 18 or later
- npm or bun
- TypeScript knowledge
- Familiarity with Pulumi

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/sf-tensor/tack.git
   cd tack
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Run type checking:
   ```bash
   npm run lint
   ```

## Making Changes

### Code Style

- Use TypeScript strict mode
- Follow existing patterns in the codebase
- Export types from module `types.ts` files
- Use meaningful variable and function names

### Project Structure

```
src/
├── app/          # Application deployment
├── bucket/       # S3/MinIO storage
├── certificate/  # ACM certificates
├── cicd/         # CI/CD pipelines
├── cluster/      # EKS cluster management
├── database/     # RDS/PostgreSQL databases
├── dns/          # Cloudflare DNS
├── docker/       # Docker image building
├── iam/          # IAM roles and policies
├── loadbalancer/ # ALB/nginx ingress
├── networking/   # VPC and subnet management
├── secrets/      # Secret management
├── index.ts      # Main exports
└── types.ts      # Core types
```

### Stack-Aware Development

Tack automatically adapts to different Pulumi stacks. When adding new features:

- Consider both local (`development`, `local-staging`) and production (`staging`, `production`) stacks
- Use `isLocalStack()` to conditionally create resources
- Local stacks use Kubernetes-native alternatives (MinIO, PostgreSQL pods)
- Production stacks use AWS-managed services (S3, RDS)

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with clear, focused commits
3. Ensure the project builds without errors: `npm run build`
4. Ensure type checking passes: `npm run lint`
5. Update documentation if needed
6. Submit a pull request with a clear description of changes

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Pulumi and Node.js versions
- Relevant stack configuration

## License

By contributing to Tack, you agree that your contributions will be licensed under the MIT License.
