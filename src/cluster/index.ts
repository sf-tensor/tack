// Note: for development, a local cluster must be created manually (e.g., using MiniKube)

import * as aws from '@pulumi/aws'
import * as eks from "@pulumi/eks"
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

import { currentStack, isLocalStack, Resource, ResourceArgs } from "../types"
import { Vpc } from '../networking/vpc'
import { Subnet } from '../networking/subnet'
import { createOidcRole } from '../iam/role'

type AWSClusterBacking = { cluster: eks.Cluster, provider: k8s.Provider, nodeGroups: eks.ManagedNodeGroup[], clusterSecurityGroupId: pulumi.Output<string> }

export class Cluster extends Resource<AWSClusterBacking, { provider: k8s.Provider }> {
	public readonly provider: k8s.Provider
	private readonly _nodeGroups: eks.ManagedNodeGroup[]
	private readonly _dependencies: pulumi.Resource[]

	constructor(backing: AWSClusterBacking | { provider: k8s.Provider }, dependencies: pulumi.Resource[]) {
		super(backing)

		this.provider = backing.provider
		this._nodeGroups = 'nodeGroups' in backing ? backing.nodeGroups : []
		this._dependencies = dependencies
	}

	get clusterSecurityGroupId(): pulumi.Output<string> {
		if (isLocalStack(this.stack)) throw new Error('clusterSecurityGroupId is not available for local clusters')

		return this.backing('prod').clusterSecurityGroupId
	}

	dependencies(): pulumi.Resource[] {
		return [...this._nodeGroups, ...this._dependencies]
	}
}

interface ClusterNodeGroupConfig {
	id: string
	instanceTypes: string[]
	amiType: string
	scalingConfig: {
		minSize: number
		maxSize: number
		desiredSize: number
	}
	storage: {
		type: 'ebs' | 'nvme-instance-store'
		ebsDiskSize?: number  // Only used when type is 'ebs'
	}
}

interface ClusterConfig {
	deletionProtection?: boolean
	vpc: Vpc
	privateSubnets: Subnet[]
	publicSubnets: Subnet[]
	nodeGroups: ClusterNodeGroupConfig[]
}

export function createCluster(args: ResourceArgs<ClusterConfig>): Cluster {
	if (isLocalStack(currentStack)) {
		const provider = new k8s.Provider(args.id, {
			kubeconfig: "~/.kube/config",
			cluster: 'minikube'
		})

		return new Cluster({ provider }, [])
	}

	const clusterSecurityGroup = new aws.ec2.SecurityGroup(args.id, {
		vpcId: args.vpc.vpcId(),
		name: `${args.id}-${currentStack}-cluster-sg`,
		description: 'Cluster security group',
		egress: [{
			protocol: '-1',
			fromPort: 0,
			toPort: 0,
			cidrBlocks: ['0.0.0.0/0'],
			description: 'Allow all outbound traffic'
		}],
		region: args.region,
		tags: {
			Name: `${args.id} Cluster Security Group`,
			stack: currentStack
		}
	})

	// Self-referencing ingress rule for node-to-node and control plane communication
	new aws.ec2.SecurityGroupRule(`${args.id}-cluster-sg-self-ingress`, {
		type: 'ingress',
		securityGroupId: clusterSecurityGroup.id,
		sourceSecurityGroupId: clusterSecurityGroup.id,
		protocol: '-1',
		fromPort: 0,
		toPort: 0,
		description: 'Allow all traffic within the cluster security group (node-to-node and control plane communication)'
	})

	const encryptionKey = new aws.kms.Key(`${args.id}-encryption-key`, {
		description: `EKS envelope encryption key for cluster ${args.id}`,
		enableKeyRotation: true,
		deletionWindowInDays: 7,
		policy: pulumi.all([aws.getCallerIdentity()]).apply(([identity]) => JSON.stringify({
			Version: "2012-10-17",
			Id: "eks-secrets-key-policy",
			Statement: [
				{
					Sid: "Enable IAM policies for root account",
					Effect: "Allow",
					Principal: {
						AWS: `arn:aws:iam::${identity.accountId}:root`
					},
					Action: "kms:*",
					Resource: "*"
				},
				{
					Sid: "Allow EKS service to use the key",
					Effect: "Allow",
					Principal: {
						Service: "eks.amazonaws.com"
					},
					Action: [
						"kms:Encrypt",
						"kms:Decrypt",
						"kms:ReEncrypt*",
						"kms:GenerateDataKey*",
						"kms:DescribeKey"
					],
					Resource: "*"
				},
				{
					Sid: "Allow EKS service for grant operations",
					Effect: "Allow",
					Principal: {
						Service: "eks.amazonaws.com"
					},
					Action: [
						"kms:CreateGrant",
						"kms:ListGrants",
						"kms:RevokeGrant"
					],
					Resource: "*",
					Condition: {
						Bool: {
							"kms:GrantIsForAWSResource": "true"
						}
					}
				}
			]
		})),	
		tags: {
			Name: `${args.id} EKS Encryption Key`,
			stack: currentStack
		}
	})

	const serviceRole = new aws.iam.Role(`${args.id}-service-role`, {
		name: `${args.id}-${currentStack}-service-role`,
		assumeRolePolicy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Service: 'eks.amazonaws.com' },
				Action: 'sts:AssumeRole'
			}]
		}),
		tags: {
			Name: `${args.id}-${currentStack}-service-role`,
			stack: currentStack
		}
	})

	new aws.iam.RolePolicyAttachment(`${args.id}-cluster-policy`, {
		role: serviceRole.name,
		policyArn: 'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'
	})

	const nodeGroupRole = new aws.iam.Role(`${args.id}-node-worker-role`, {
		name: `${args.id}-${currentStack}-node-worker-role`,
		assumeRolePolicy: JSON.stringify({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Service: ['eks.amazonaws.com', 'ec2.amazonaws.com'] },
				Action: 'sts:AssumeRole'
			}]
		})
	})

	new aws.iam.RolePolicyAttachment(`${args.id}-node-worker-policy`, {
		role: nodeGroupRole.name,
		policyArn: 'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy'
	})

	new aws.iam.RolePolicyAttachment(`${args.id}-node-ecr-policy`, {
		role: nodeGroupRole.name,
		policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'
	})

	new aws.iam.RolePolicyAttachment(`${args.id}-node-cni-policy`, {
		role: nodeGroupRole.name,
		policyArn: 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy'
	})

	const clusterName = pulumi.interpolate`${args.id}-${currentStack}`
	const cluster = new eks.Cluster(args.id, {
		serviceRole,
		autoMode: {
			enabled: false
		},
		authenticationMode: 'API',
		bootstrapSelfManagedAddons: true,
		clusterSecurityGroup: clusterSecurityGroup,
		createOidcProvider: true,

		deletionProtection: args.deletionProtection ?? (currentStack === 'production'),
		enableConfigMapMutable: false,
		encryptionConfigKeyArn: encryptionKey.arn,

		endpointPublicAccess: true, // TODO: bring this back, but that requires the IaC to be managed via a server inside of the same VPC (currentStack !== 'production'), // public access is only allowed for staging cluster
		endpointPrivateAccess: true,

		fargate: false,
		ipFamily: "ipv4",

		name: clusterName,
		version: "1.34",

		nodeAssociatePublicIpAddress: false,
		nodeRootVolumeEncrypted: true,

		vpcId: args.vpc.vpcId(),
		publicSubnetIds: args.publicSubnets.map(subnet => subnet.subnetId()),
		privateSubnetIds: args.privateSubnets.map(subnet => subnet.subnetId()),
		skipDefaultNodeGroup: true, // we create our own node group below

		useDefaultVpcCni: true,
		upgradePolicy: {
			supportType: 'STANDARD'
		},

		tags: {
			Name: `${args.id} Cluster`,
			stack: currentStack
		}
	})

	for (const subnet of args.publicSubnets) {
		new aws.ec2.Tag(`${subnet.backing('prod').name}-elb-role-tag`, {
			resourceId: subnet.subnetId(),
			key: 'kubernetes.io/role/elb',
			value: "1"
		})

		new aws.ec2.Tag(`${subnet.backing('prod').name}-elb-cluster-tag`, {
			resourceId: subnet.subnetId(),
			key: pulumi.interpolate`kubernetes.io/cluster/${clusterName}`,
			value: "shared"
		})
	}

	const nodeGroups: eks.ManagedNodeGroup[] = []
	for (const nodeGroup of args.nodeGroups) {
		if (nodeGroup.storage.type === 'nvme-instance-store') {
			const bottlerocketUserData = pulumi.all([
				cluster.eksCluster.endpoint,
				cluster.eksCluster.certificateAuthority,
				clusterName
			]).apply(([endpoint, ca, name]) => {
				const toml = `[settings.kubernetes]
api-server = "${endpoint}"
cluster-certificate = "${ca?.data ?? ''}"
cluster-name = "${name}"

[settings.bootstrap-commands.k8s-ephemeral-storage]
commands = [["apiclient", "ephemeral-storage", "init"], ["apiclient", "ephemeral-storage", "bind", "--dirs", "/var/lib/containerd", "/var/lib/kubelet", "/var/log/pods"]]
essential = true
mode = "always"
`
				return Buffer.from(toml).toString('base64')
			})

			const launchTemplate = new aws.ec2.LaunchTemplate(`${args.id}-${nodeGroup.id}-node-launch-template`, {
				name: `${args.id}-${currentStack}-${nodeGroup.id}-nvme-node-launch-template`,
				vpcSecurityGroupIds: [clusterSecurityGroup.id],
				userData: bottlerocketUserData,
				blockDeviceMappings: [
					{
						deviceName: "/dev/xvda",
						ebs: {
							volumeSize: 4,
							volumeType: "gp3",
							deleteOnTermination: "true",
						},
					}
				],
				tags: {
					Name: `${args.id} ${nodeGroup.id} Node Launch Template`,
					stack: currentStack
				}
			})

			const ng = new eks.ManagedNodeGroup(`${args.id}-${nodeGroup.id}-node-group`, {
				cluster: cluster,
				nodeRole: nodeGroupRole,
				subnetIds: args.privateSubnets.map(subnet => subnet.subnetId()),
				nodeGroupName: nodeGroup.id,
				instanceTypes: nodeGroup.instanceTypes,
				amiType: nodeGroup.amiType,
				scalingConfig: {
					minSize: nodeGroup.scalingConfig.minSize,
					maxSize: nodeGroup.scalingConfig.maxSize,
					desiredSize: nodeGroup.scalingConfig.desiredSize
				},
				launchTemplate: {
					id: launchTemplate.id,
					version: launchTemplate.latestVersion.apply(v => v.toString())
				},
				tags: {
					Name: `${args.id} Node Group ${nodeGroup.id}`,
					stack: currentStack
				},
			})
			nodeGroups.push(ng)
		} else {
			// EBS storage: root volume + data volume
			const launchTemplate = new aws.ec2.LaunchTemplate(`${args.id}-${nodeGroup.id}-node-launch-template`, {
				name: `${args.id}-${currentStack}-${nodeGroup.id}-node-launch-template`,
				vpcSecurityGroupIds: [clusterSecurityGroup.id],
				blockDeviceMappings: [
					{
						deviceName: "/dev/xvda",
						ebs: {
							volumeSize: 4,
							volumeType: "gp3",
							deleteOnTermination: "true",
						},
					},
					{
						deviceName: "/dev/xvdb",
						ebs: {
							volumeSize: nodeGroup.storage.ebsDiskSize ?? 50,
							volumeType: "gp3",
							deleteOnTermination: "true",
						},
					}
				],
				tags: {
					Name: `${args.id} ${nodeGroup.id} Node Launch Template`,
					stack: currentStack
				}
			})

			const ng = new eks.ManagedNodeGroup(`${args.id}-${nodeGroup.id}-node-group`, {
				cluster: cluster,
				nodeRole: nodeGroupRole,
				subnetIds: args.privateSubnets.map(subnet => subnet.subnetId()),
				nodeGroupName: nodeGroup.id,
				instanceTypes: nodeGroup.instanceTypes,
				amiType: nodeGroup.amiType,
				scalingConfig: {
					minSize: nodeGroup.scalingConfig.minSize,
					maxSize: nodeGroup.scalingConfig.maxSize,
					desiredSize: nodeGroup.scalingConfig.desiredSize
				},
				launchTemplate: {
					id: launchTemplate.id,
					version: launchTemplate.latestVersion.apply(v => v.toString())
				},
				tags: {
					Name: `${args.id} Node Group ${nodeGroup.id}`,
					stack: currentStack
				},
			})
			nodeGroups.push(ng)
		}
	}

	const csiDriver = new k8s.helm.v3.Release(`${args.id}-csi-secrets-store`, {
		chart: "secrets-store-csi-driver",
		namespace: "kube-system",
		repositoryOpts: {
			repo: "https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts",
		},
		values: {
			syncSecret: { enabled: true },
			enableSecretRotation: true,
			rotationPollInterval: "5m"
		},
	}, { provider: cluster.provider, dependsOn: nodeGroups })
	
	const secretsProvider = new k8s.helm.v3.Release(`${args.id}-secrets-provider-aws`, {
		chart: "secrets-store-csi-driver-provider-aws",
		namespace: "kube-system",
		repositoryOpts: {
			repo: "https://aws.github.io/secrets-store-csi-driver-provider-aws",
		},
		values: {
			"secrets-store-csi-driver": {
				install: false
			},
		},
	}, { dependsOn: csiDriver, provider: cluster.provider })

	const lbControllerRole = createOidcRole({
		name: `${args.id}-${currentStack}-lb-controller`,
		serviceAccount: 'aws-load-balancer-controller',
		oidcProviderArn: cluster.oidcProviderArn,
		oidcProviderUrl: cluster.oidcProviderUrl,
		namespace: 'kube-system'
	})

	const lbControllerPolicy = getLbControllerPolicy(args.id)
	const lbControllerRolePolicyAttachment = new aws.iam.RolePolicyAttachment(`${args.id}-lb-controller-attachment`, {
		role: lbControllerRole.name,
		policyArn: lbControllerPolicy.arn,
	})

	const awsLbController = new k8s.helm.v3.Release(`${args.id}-aws-lb-controller`, {
		chart: "aws-load-balancer-controller",
		namespace: 'kube-system',
		version: "1.10.0",
		repositoryOpts: {
			repo: "https://aws.github.io/eks-charts",
		},
		values: {
			clusterName: clusterName,
			serviceAccount: {
				create: true,
				name: "aws-load-balancer-controller",
				annotations: {
					"eks.amazonaws.com/role-arn": lbControllerRole.arn,
				},
			},
			region: aws.getRegionOutput().region,
			vpcId: args.vpc.vpcId()
		},
	}, { dependsOn: [lbControllerRolePolicyAttachment, ...nodeGroups], provider: cluster.provider });	

	return new Cluster({
		cluster,
		provider: cluster.provider,
		nodeGroups,
		clusterSecurityGroupId: clusterSecurityGroup.id
	}, [secretsProvider, awsLbController])
}

function getLbControllerPolicy(id: string) {
	const policyDocument = aws.iam.getPolicyDocumentOutput({
		statements: [
			{
				effect: "Allow",
				actions: ["iam:CreateServiceLinkedRole"],
				resources: ["*"],
				conditions: [{
					test: "StringEquals",
					variable: "iam:AWSServiceName",
					values: ["elasticloadbalancing.amazonaws.com"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"ec2:DescribeAccountAttributes",
					"ec2:DescribeAddresses",
					"ec2:DescribeAvailabilityZones",
					"ec2:DescribeInternetGateways",
					"ec2:DescribeVpcs",
					"ec2:DescribeVpcPeeringConnections",
					"ec2:DescribeSubnets",
					"ec2:DescribeSecurityGroups",
					"ec2:DescribeInstances",
					"ec2:DescribeNetworkInterfaces",
					"ec2:DescribeTags",
					"ec2:GetCoipPoolUsage",
					"ec2:DescribeCoipPools",
					"elasticloadbalancing:DescribeLoadBalancers",
					"elasticloadbalancing:DescribeLoadBalancerAttributes",
					"elasticloadbalancing:DescribeListeners",
					"elasticloadbalancing:DescribeListenerCertificates",
					"elasticloadbalancing:DescribeSSLPolicies",
					"elasticloadbalancing:DescribeRules",
					"elasticloadbalancing:DescribeTargetGroups",
					"elasticloadbalancing:DescribeTargetGroupAttributes",
					"elasticloadbalancing:DescribeTargetHealth",
					"elasticloadbalancing:DescribeTags",
					"elasticloadbalancing:DescribeTrustStores",
				],
				resources: ["*"],
			},
			{
				effect: "Allow",
				actions: [
					"cognito-idp:DescribeUserPoolClient",
					"acm:ListCertificates",
					"acm:DescribeCertificate",
					"iam:ListServerCertificates",
					"iam:GetServerCertificate",
					"waf-regional:GetWebACL",
					"waf-regional:GetWebACLForResource",
					"waf-regional:AssociateWebACL",
					"waf-regional:DisassociateWebACL",
					"wafv2:GetWebACL",
					"wafv2:GetWebACLForResource",
					"wafv2:AssociateWebACL",
					"wafv2:DisassociateWebACL",
					"shield:GetSubscriptionState",
					"shield:DescribeProtection",
					"shield:CreateProtection",
					"shield:DeleteProtection",
				],
				resources: ["*"],
			},
			{
				effect: "Allow",
				actions: [
					"ec2:AuthorizeSecurityGroupIngress",
					"ec2:RevokeSecurityGroupIngress",
				],
				resources: ["*"],
			},
			{
				effect: "Allow",
				actions: ["ec2:CreateSecurityGroup"],
				resources: ["*"],
			},
			{
				effect: "Allow",
				actions: ["ec2:CreateTags"],
				resources: ["arn:aws:ec2:*:*:security-group/*"],
				conditions: [{
					test: "StringEquals",
					variable: "ec2:CreateAction",
					values: ["CreateSecurityGroup"],
				}, {
					test: "Null",
					variable: "aws:RequestTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: ["ec2:CreateTags", "ec2:DeleteTags"],
				resources: ["arn:aws:ec2:*:*:security-group/*"],
				conditions: [{
					test: "Null",
					variable: "aws:RequestTag/elbv2.k8s.aws/cluster",
					values: ["true"],
				}, {
					test: "Null",
					variable: "aws:ResourceTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"ec2:AuthorizeSecurityGroupIngress",
					"ec2:RevokeSecurityGroupIngress",
					"ec2:DeleteSecurityGroup",
				],
				resources: ["*"],
				conditions: [{
					test: "Null",
					variable: "aws:ResourceTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:CreateLoadBalancer",
					"elasticloadbalancing:CreateTargetGroup",
				],
				resources: ["*"],
				conditions: [{
					test: "Null",
					variable: "aws:RequestTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:CreateListener",
					"elasticloadbalancing:DeleteListener",
					"elasticloadbalancing:CreateRule",
					"elasticloadbalancing:DeleteRule",
				],
				resources: ["*"],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:AddTags",
					"elasticloadbalancing:RemoveTags",
				],
				resources: [
					"arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
					"arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
					"arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
				],
				conditions: [{
					test: "Null",
					variable: "aws:RequestTag/elbv2.k8s.aws/cluster",
					values: ["true"],
				}, {
					test: "Null",
					variable: "aws:ResourceTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:AddTags",
					"elasticloadbalancing:RemoveTags",
				],
				resources: [
					"arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
					"arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
					"arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
					"arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*",
				],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:ModifyLoadBalancerAttributes",
					"elasticloadbalancing:SetIpAddressType",
					"elasticloadbalancing:SetSecurityGroups",
					"elasticloadbalancing:SetSubnets",
					"elasticloadbalancing:DeleteLoadBalancer",
					"elasticloadbalancing:ModifyTargetGroup",
					"elasticloadbalancing:ModifyTargetGroupAttributes",
					"elasticloadbalancing:DeleteTargetGroup",
				],
				resources: ["*"],
				conditions: [{
					test: "Null",
					variable: "aws:ResourceTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: ["elasticloadbalancing:AddTags"],
				resources: [
					"arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
					"arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
					"arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
				],
				conditions: [{
					test: "StringEquals",
					variable: "elasticloadbalancing:CreateAction",
					values: ["CreateTargetGroup", "CreateLoadBalancer"],
				}, {
					test: "Null",
					variable: "aws:RequestTag/elbv2.k8s.aws/cluster",
					values: ["false"],
				}],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:RegisterTargets",
					"elasticloadbalancing:DeregisterTargets",
				],
				resources: ["arn:aws:elasticloadbalancing:*:*:targetgroup/*/*"],
			},
			{
				effect: "Allow",
				actions: [
					"elasticloadbalancing:SetWebAcl",
					"elasticloadbalancing:ModifyListener",
					"elasticloadbalancing:AddListenerCertificates",
					"elasticloadbalancing:RemoveListenerCertificates",
					"elasticloadbalancing:ModifyRule",
				],
				resources: ["*"],
			},
		],
	})

	return new aws.iam.Policy(`${id}-aws-lb-controller-policy`, {
		policy: policyDocument.json,
		description: "IAM policy for AWS Load Balancer Controller",
	})
}