import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import { currentStack, ResourceArgs } from '../types'
import { Cluster } from '../cluster'

export interface ManagerConfig {
	cluster: Cluster
	sqsQueueUrl: pulumi.Input<string>
	iamRoleArn: pulumi.Input<string>
	managerImageUrl: pulumi.Input<string>
	namespace?: string
	taskTimeoutMs?: number  // Default: 600000 (10 minutes)
}

export interface ManagerResources {
	deployment: k8s.apps.v1.Deployment
	serviceAccount: k8s.core.v1.ServiceAccount
	clusterRole: k8s.rbac.v1.ClusterRole
}

export function createDeploymentManagerInCluster(args: ResourceArgs<ManagerConfig>): ManagerResources {
	const namespace = args.namespace ?? 'default'
	const serviceAccountName = 'cicd-manager'

	const serviceAccount = new k8s.core.v1.ServiceAccount(`cicd-manager-sa`, {
		metadata: {
			name: serviceAccountName,
			namespace,
			annotations: {
				'eks.amazonaws.com/role-arn': pulumi.output(args.iamRoleArn).apply(v => v)
			}
		}
	}, { provider: args.cluster.provider, dependsOn: args.cluster.dependencies() })

	const clusterRole = new k8s.rbac.v1.ClusterRole(`cicd-manager-role`, {
		metadata: {
			name: 'cicd-manager-role'
		},
		rules: [
			{
				apiGroups: ['batch'],
				resources: ['jobs', 'cronjobs'],
				verbs: ['get', 'list', 'create', 'delete', 'watch']
			},
			{
				apiGroups: ['apps'],
				resources: ['deployments'],
				verbs: ['get', 'list', 'patch', 'watch']
			},
			{
				apiGroups: [''],
				resources: ['pods'],
				verbs: ['get', 'list', 'watch']
			}
		]
	}, { provider: args.cluster.provider, dependsOn: args.cluster.dependencies() })

	const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(`cicd-manager-binding`, {
		metadata: {
			name: 'cicd-manager-binding'
		},
		roleRef: {
			apiGroup: 'rbac.authorization.k8s.io',
			kind: 'ClusterRole',
			name: clusterRole.metadata.name
		},
		subjects: [{
			kind: 'ServiceAccount',
			name: serviceAccountName,
			namespace
		}]
	}, { provider: args.cluster.provider, dependsOn: [clusterRole] })

	const deployment = new k8s.apps.v1.Deployment(`cicd-manager-deployment`, {
		metadata: {
			name: 'cicd-manager',
			namespace,
			labels: { app: 'cicd-manager' },
			annotations: {
				"pulumi.com/patchForce": "true",
			}
		},
		spec: {
			replicas: 1,
			selector: {
				matchLabels: { app: 'cicd-manager' }
			},
			template: {
				metadata: {
					labels: { app: 'cicd-manager' }
				},
				spec: {
					serviceAccountName,
					containers: [{
						name: 'application',
						image: pulumi.output(args.managerImageUrl).apply(v => v),
						imagePullPolicy: 'Always',
						env: [
							{ name: 'SQS_QUEUE_URL', value: pulumi.output(args.sqsQueueUrl).apply(v => v) },
							{ name: 'NAMESPACE', value: namespace },
							{ name: 'TASK_TIMEOUT_MS', value: String(args.taskTimeoutMs ?? 600000) },
							{ name: 'AWS_REGION', value: args.region }
						],
						resources: {
							requests: { memory: '128Mi', cpu: '100m' },
							limits: { memory: '256Mi', cpu: '500m' }
						},
						livenessProbe: {
							httpGet: { path: '/health', port: 8080 },
							initialDelaySeconds: 10,
							periodSeconds: 30
						}
					}],
					restartPolicy: 'Always'
				}
			}
		}
	}, { provider: args.cluster.provider, dependsOn: [serviceAccount, clusterRoleBinding, ...args.cluster.dependencies()], ignoreChanges: ['spec.template.spec.containers[*].image'] })

	return {
		deployment,
		serviceAccount,
		clusterRole
	}
}

export function createManagerEcrRepository(args: ResourceArgs<{}>): {
	repository: aws.ecr.Repository
	repositoryUrl: pulumi.Output<string>
} {
	const repository = new aws.ecr.Repository(`cicd-manager-ecr`, {
		name: `${currentStack}/cicd-manager`,
		imageTagMutability: 'MUTABLE',
		imageScanningConfiguration: { scanOnPush: true },
		forceDelete: currentStack !== 'production',
		tags: {
			Name: 'CI/CD Manager Image Repository',
			stack: currentStack
		}
	})

	new aws.ecr.LifecyclePolicy(`cicd-manager-lifecycle`, {
		repository: repository.name,
		policy: JSON.stringify({
			rules: [{
				rulePriority: 1,
				description: 'Keep last 5 images',
				selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 5 },
				action: { type: 'expire' }
			}]
		})
	})

	return {
		repository,
		repositoryUrl: repository.repositoryUrl
	}
}
