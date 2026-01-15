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

4. Verify the build completes without errors

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
4. Update documentation if needed
5. Submit a pull request with a clear description of changes

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Pulumi and Node.js versions
- Relevant stack configuration

## Releasing (Maintainers)

Releases are automated via GitHub Actions when a version tag is pushed.

### Release Process

1. Update the version in `package.json`:
   ```bash
   npm version patch  # or minor, major
   ```

2. Update `CHANGELOG.md` with the new version and changes

3. Commit the version bump:
   ```bash
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "Release vX.Y.Z"
   ```

4. Create and push the tag:
   ```bash
   git tag vX.Y.Z
   git push origin master --tags
   ```

5. The release workflow will automatically:
   - Build the project
   - Verify the tag matches `package.json` version
   - Publish to npm with provenance
   - Create a GitHub Release with auto-generated notes

### Pre-releases

For pre-release versions (alpha, beta, rc), use:
```bash
npm version prerelease --preid=alpha  # 0.1.0 -> 0.1.1-alpha.0
npm version prerelease --preid=beta   # 0.1.0 -> 0.1.1-beta.0
npm version prerelease --preid=rc     # 0.1.0 -> 0.1.1-rc.0
```

Pre-release tags (containing `-`) are automatically marked as pre-releases on GitHub.

## License

By contributing to Tack, you agree that your contributions will be licensed under the MIT License.
