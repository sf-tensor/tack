# @sf-tensor/tack

Pulumi components for AWS + Kubernetes infrastructure.

## Install

```bash
npm install @sf-tensor/tack
```

## Usage

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

## Configuration

Some modules read Pulumi config values:

- `githubConnectionArn` (required for CodeBuild connections)
- `cloudflareZoneId` (optional, for DNS + TLS validation)

These are read from the current Pulumi project config (e.g., `pulumi config set githubConnectionArn <arn>`).

## License

MIT
