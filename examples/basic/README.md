# Basic Example

This example shows a minimal Pulumi program that wires together VPC, subnets, a cluster, a deployment manager, and a Bun app. It is intentionally small and will likely need edits for your environment.

## Prerequisites

- A Pulumi project (`pulumi new typescript`).
- AWS credentials for the target account.
- `pulumi config set githubConnectionArn <arn>` for CodeBuild GitHub connection.

## Running

1) Copy `examples/basic/index.ts` into your Pulumi project.
2) Replace the placeholder values (VPC CIDR, subnets, repo org/name, localPath, etc.).
3) Run `pulumi up` for `development` or `staging`.

DevPod workflows are only enabled in local stacks.
