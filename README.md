# @sf-tensor/tack

Opinionated Pulumi components for AWS + Kubernetes infrastructure. This repo reflects how we run our own infra; it is not a generic platform. If your workflows look similar, you can use it directly or fork and adapt it.

## What this is

- A library of Pulumi components for VPCs, EKS clusters, app deployments, CI/CD pipelines, buckets, databases, DNS, and secrets.
- First-class DevPod support for local development against a Kubernetes cluster.
- A deployment manager + CodeBuild setup for automated builds, container pushes, and task execution.

## What this is not

- A drop-in, multi-tenant platform that fits every org or cloud setup.
- A polished product with all edge cases covered.

## Prerequisites

- AWS account + credentials available to Pulumi.
- Pulumi CLI installed and authenticated.
- Node.js 18+ (this package is published for Node consumers).
- `kubectl` and access to your cluster for DevPod workflows.

## Install

```bash
npm install @sf-tensor/tack
```

## Quick start (minimal)

```ts
import * as pulumi from "@pulumi/pulumi";
import {
  createCluster,
  createBucket,
  createDeploymentManager,
  createBunApp,
  currentStack,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-2";

const cluster = createCluster({
  id: "cluster",
  region,
  vpc: /* your VPC */,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch({ production: ["m6gd.xlarge"], staging: ["m6gd.large"] }, ["m6gd.large"]),
      scalingConfig: { minSize: 1, maxSize: 4, desiredSize: 2 },
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets: [],
  publicSubnets: []
});

const bucket = createBucket({
  id: "data",
  bucketName: `example-${currentStack}`,
  isPublic: false,
  region
});

const deploymentManager = createDeploymentManager({
  id: "deployment-manager",
  region,
  cluster,
  managerRepository: { type: "github", org: "your-org", repo: "cicd-manager" },
  managerBranch: "main"
});

createBunApp({
  id: "app",
  runtime: "next",
  localPath: "/path/to/app",
  repository: { type: "github", org: "your-org", repo: "app" },
  branch: "main",
  env: [{ name: "NODE_ENV", value: "production" }],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },
  region,
  cluster,
  deploymentManager
});
```

See `examples/basic` for a fuller walkthrough.

## Multi-workload apps

One `createBunApp` call can now fan out into multiple related workloads from the same repo. Each workload gets its own Deployment, Service, image, and CI/CD pipeline, while still sharing the app-level defaults you define.

```ts
const app = createBunApp({
  id: "app",
  runtime: "base",
  localPath: "/path/to/app",
  repository: { type: "github", org: "your-org", repo: "app" },
  branch: "main",
  env: [{ name: "NODE_ENV", value: "production" }],
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/health", port: 3000 },
  containers: [
    {
      name: "api",
      buildTask: "build",
      env: [{ name: "PORT", value: "3000" }]
    },
    {
      name: "rates",
      buildTask: "build:rates",
      env: [{ name: "PORT", value: "3001" }],
      ports: [{ name: "http", port: 3001 }],
      healthRoute: { path: "/health", port: 3001 }
    }
  ],
  region,
  cluster,
  deploymentManager
});

// Primary workload
export const apiService = app.service.metadata.name;

// Secondary workloads
export const ratesService = app.services.rates.metadata.name;
```

## Docs

- [docs/OVERVIEW.md](docs/OVERVIEW.md)
- [docs/DEV_POD.md](docs/DEV_POD.md)
- [docs/DEPLOYMENT_MANAGER.md](docs/DEPLOYMENT_MANAGER.md)

## Configuration

These are read from the current Pulumi project config:

- `githubConnectionArn` (required for CodeBuild connections)
- `cloudflareZoneId` (optional, for DNS + TLS validation)

Example:

```bash
pulumi config set githubConnectionArn <arn>
```

## Stack conventions

Tack expects stack names in this set:

- `development`
- `local-staging`
- `staging`
- `production`

Local stacks (`development`, `local-staging`) enable DevPod and other local conveniences.

## DevPod

DevPod is a first-class workflow for developing against a cluster. It sets up a dev pod, syncs your local files, and forwards ports. See [docs/DEV_POD.md](docs/DEV_POD.md).

## Deployment manager

The deployment manager is a companion service that handles deployment tasks and CodeBuild orchestration for non-local stacks. See [docs/DEPLOYMENT_MANAGER.md](docs/DEPLOYMENT_MANAGER.md).

## Notes and limitations

- This repo assumes AWS + EKS + CodeBuild and does not aim to abstract those away.
- Some defaults (resource names, labels) reflect our internal workflows; you should expect to adjust them.
- Bun app tasks still attach to the primary workload when `containers[]` is used.
- We do not currently support GovCloud out of the box.

## License

MIT
