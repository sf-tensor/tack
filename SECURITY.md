# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please email security concerns to the maintainers. You can find maintainer contact information in the repository's package.json or by reaching out through GitHub's private vulnerability reporting feature.

When reporting a vulnerability, please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact of the vulnerability
- Any suggested fixes (if available)

## Response Timeline

- **Initial Response**: We aim to acknowledge receipt of your report within 48 hours.
- **Status Update**: We will provide an update on the status of your report within 7 days.
- **Resolution**: We will work to resolve verified vulnerabilities as quickly as possible and will keep you informed of our progress.

## Disclosure Policy

- We will work with you to understand and resolve the issue promptly.
- We will credit reporters who follow responsible disclosure practices (unless you prefer to remain anonymous).
- We will notify affected users once a fix is available.

## Security Best Practices

When using this library:

1. **Keep dependencies updated**: Regularly update `@sf-tensor/tack` and its dependencies to receive security patches.
2. **Review IAM policies**: The library creates IAM roles and policies. Review these to ensure they follow the principle of least privilege for your use case.
3. **Protect secrets**: Never commit secrets, AWS credentials, or sensitive configuration to version control.
4. **Use private subnets**: Deploy workloads in private subnets when possible, using the provided VPC and subnet configurations.
5. **Enable encryption**: The library enables encryption by default for EKS secrets and RDS databases. Do not disable these features in production.

Thank you for helping keep this project and its users safe.
