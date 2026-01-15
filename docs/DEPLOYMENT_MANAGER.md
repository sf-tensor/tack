# Deployment Manager

The deployment manager is a companion service that coordinates build + deployment tasks for non-local stacks.

## Responsibilities

- Receives build/deploy tasks via SQS.
- Creates or updates Kubernetes jobs and deployments.
- Works with CodeBuild projects that push container images.

## Components

- SQS queue for deployment messages.
- CodeBuild projects for app builds (and optional task images).
- A manager deployment in-cluster with IAM access.
- ECR repositories for manager and app images.

## Usage

Provide a manager repository and branch when creating the deployment manager:

```ts
createDeploymentManager({
  id: "deployment-manager",
  region,
  cluster,
  managerRepository: { type: "github", org: "your-org", repo: "cicd-manager" },
  managerBranch: "main"
});
```

Apps send deployment tasks to the queue. In production stacks, tasks are represented as suspended CronJobs and the manager activates them as needed.

## Task labeling

Task CronJobs are labeled so the manager can find them. The default label key is `tack.dev/task-type`, and can be customized per app in `BunAppConfig.taskLabelKey`.
