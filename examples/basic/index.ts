import {
  createVpc,
  createCluster,
  createDeploymentManager,
  createBunApp,
  stackSwitch,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-2";

const vpc = createVpc({
  id: "vpc",
  name: "example-vpc",
  cidrBlock: "10.42.0.0/16",
  region
});

const publicSubnet = vpc.createSubnet({
  id: "public-1",
  name: "public-1",
  availabilityZone: "us-east-2a",
  cidrBlock: "10.42.0.0/24",
  region
});

const privateSubnet = vpc.createSubnet({
  id: "private-1",
  name: "private-1",
  availabilityZone: "us-east-2a",
  cidrBlock: "10.42.1.0/24",
  region
});

const cluster = createCluster({
  id: "cluster",
  region,
  vpc,
  nodeGroups: [
    {
      id: "standard",
      amiType: "BOTTLEROCKET_ARM_64",
      instanceTypes: stackSwitch({ production: ["m6gd.xlarge"], staging: ["m6gd.large"] }, ["m6gd.large"]),
      scalingConfig: { minSize: 1, maxSize: 4, desiredSize: 2 },
      storage: { type: "nvme-instance-store" }
    }
  ],
  privateSubnets: [privateSubnet],
  publicSubnets: [publicSubnet]
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
  taskLabelKey: "tack.sh/task-type",
  region,
  cluster,
  deploymentManager
});
