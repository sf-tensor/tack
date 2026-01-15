import { BunApp } from "./index"
import { createAppEcrRepositories } from '../cicd/ecr'
import { getEnvironmentVariables, BunAppConfig, NativeSecretEnvEntry, getNativeSecretKey, getSecretArn } from "./types"
import { currentAccountId, currentStack, isLocalStack, ResourceArgs } from "../types"
import { createOidcRole } from '../iam/role'
import { createLocalSecretsForApp } from '../secrets/local'

import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

export function createBunKubernetesDeployment(args: ResourceArgs<BunAppConfig>, imageName: pulumi.Input<string>, tasksImageName: pulumi.Input<string> | null): BunApp {
	if (args.healthRoute == null) throw new Error("healthRoute is required in non-development stacks")

	const namespace = 'default'
	const isLocal = isLocalStack(currentStack)
	const taskLabelKey = args.taskLabelKey ?? 'tack.dev/task-type'

	let tasks: (k8s.batch.v1.Job | k8s.batch.v1.CronJob)[] = []
	let taskNames: string[] = []

	for (const task of args.tasks ?? []) {
		const taskName = task.name.replace(' ', '-').toLowerCase()
		const jobName = `${args.id}-${taskName}`
		taskNames.push(jobName)

		if (isLocal) {
			const taskJob = new k8s.batch.v1.Job(`${jobName}-job`, {
				metadata: {
					name: jobName
				},
				spec: {
					ttlSecondsAfterFinished: 0,
					template: {
						spec: {
							restartPolicy: 'OnFailure',
							containers: [{
								name: 'task',
								image: tasksImageName!,
								command: ['/bin/sh', '-c'],
								args: ['ls && bun run ' + task.command],
								env: getEnvironmentVariables(args.env, args.id)
							}]
						}
					},
					backoffLimit: 4
				}
			}, { dependsOn: args.deps, provider: args.cluster.provider })

			tasks.push(taskJob)
		} else {
			const taskLabels: Record<string, string> = {
				app: args.id,
				[taskLabelKey]: 'deployment-task'
			}

			const cronJob = new k8s.batch.v1.CronJob(`${jobName}-cronjob`, {
				metadata: {
					name: jobName,
					labels: taskLabels
				},
				spec: {
					schedule: '0 0 1 1 *',
					suspend: true,
					jobTemplate: {
						spec: {
							ttlSecondsAfterFinished: 3600,
							backoffLimit: 2,
							template: {
								spec: {
									restartPolicy: 'OnFailure',
									containers: [{
										name: 'task',
										image: 'placeholder:latest',
										command: ['/bin/sh', '-c'],
										args: [`bun run ${task.command}`],
										env: getEnvironmentVariables(args.env, args.id)
									}]
								}
							}
						}
					}
				}
			}, { provider: args.cluster.provider, dependsOn: args.deps })
			tasks.push(cronJob)
		}
	}

	const nativeSecrets = args.env
		.filter((e) => typeof e.value == 'object' && e.value.type == 'secret-arn')
		.map((e) => e.value as NativeSecretEnvEntry)

	let sa: k8s.core.v1.ServiceAccount
	let secretProvider: k8s.apiextensions.CustomResource | undefined
	let localSecret: k8s.core.v1.Secret | null = null
	let role: aws.iam.Role | undefined = undefined
	const deploymentDependencies: pulumi.Input<pulumi.Resource>[] = [...(args.deps ?? []), ...tasks, ...args.cluster.dependencies()]

	if (isLocal) {
		localSecret = createLocalSecretsForApp({
			id: args.id,
			nativeSecrets,
			cluster: args.cluster,
			namespace
		})

		sa = new k8s.core.v1.ServiceAccount(`${args.id}-sa`, {
			metadata: {
				name: args.id,
				namespace: "default"
			}
		}, { provider: args.cluster.provider })

		if (localSecret) {
			deploymentDependencies.push(localSecret)
		}
		deploymentDependencies.push(sa)
	} else {
		const secretNames = nativeSecrets.map((s) => s.secretName)
		const secretArns = secretNames.map(secretName => getSecretArn(secretName, args.region))

		role = createOidcRole({
			name: `${args.id}-${currentStack}-role`,
			serviceAccount: args.id,
			oidcProviderArn: args.cluster.backing('prod').cluster.oidcProviderArn,
			oidcProviderUrl: args.cluster.backing('prod').cluster.oidcProviderUrl,
			namespace
		})

		if (secretArns.length > 0) {
			new aws.iam.RolePolicy(`${args.id}-secrets-policy`, {
				role: role.name,
				policy: pulumi.all(secretArns).apply(arns => JSON.stringify({
					Version: "2012-10-17",
					Statement: [{
						Effect: "Allow",
						Action: [
							"secretsmanager:GetSecretValue",
							"secretsmanager:DescribeSecret",
						],
						Resource: arns.filter((value, index, arr) => arr.indexOf(value) === index),
					}]
				}))
			})
		}

		sa = new k8s.core.v1.ServiceAccount(`${args.id}-sa`, {
			metadata: {
				name: args.id,
				namespace: "default",
				annotations: {
					"eks.amazonaws.com/role-arn": role.arn
				},
			},
		}, { provider: args.cluster.provider })

		secretProvider = new k8s.apiextensions.CustomResource(`${args.id}-aws-secrets`, {
			apiVersion: "secrets-store.csi.x-k8s.io/v1",
			kind: "SecretProviderClass",
			metadata: {
				name: `${args.id}-aws-secrets`,
				namespace: "default",
			},
			spec: {
				provider: "aws",
				parameters: {
					region: args.region,
					objects: pulumi.output(pulumi.output(nativeSecrets).apply(secrets => {
						const grouped = new Map<string, typeof secrets>();
						for (const s of secrets) {
							const existing = grouped.get(s.secretName) ?? [];
							existing.push(s);
							grouped.set(s.secretName, existing);
						}

						const objects = Array.from(grouped.entries()).map(([secretName, entries]) => {
							const withKeys = entries.filter(e => e.key)
							const withoutKeys = entries.filter(e => !e.key)

							if (withKeys.length > 0) {
								return {
									objectName: secretName,
									objectType: "secretsmanager",
									jmesPath: withKeys.map(e => ({
										path: e.key!,
										objectAlias: getNativeSecretKey(e)
									})),
								}
							} else {
								return {
									objectName: secretName,
									objectType: "secretsmanager",
									objectAlias: getNativeSecretKey(withoutKeys[0])
								}
							}
						})

						return objects
					})).apply(s => JSON.stringify(s))
				},
				secretObjects: [{
					secretName: `${args.id}-aws-secrets`,
					type: "Opaque",
					data: pulumi.output(nativeSecrets).apply(secrets =>
						secrets.map(s => ({
							objectName: getNativeSecretKey(s),
							key: getNativeSecretKey(s)
						}))
					)
				}]
			},
		}, { provider: args.cluster.provider, dependsOn: args.cluster.dependencies() })

		deploymentDependencies.push(secretProvider, sa)
	}

	// Build deployment spec - only include CSI volume mounts for production
	const containerSpec: k8s.types.input.core.v1.Container = {
		name: 'application',
		image: imageName,
		imagePullPolicy: 'IfNotPresent',
		ports: args.ports.map((p) => ({ containerPort: p.port, name: p.name })),
		env: [
			{ name: "NODE_ENV", value: "production" },
			...getEnvironmentVariables(args.env, args.id)
		],
		readinessProbe: {
			httpGet: { path: args.healthRoute!.path, port: args.healthRoute!.port },
			initialDelaySeconds: 5,
			periodSeconds: 10
		},
		livenessProbe: {
			httpGet: { path: args.healthRoute!.path, port: args.healthRoute!.port },
			initialDelaySeconds: 15,
			periodSeconds: 20
		}
	}

	// Only add CSI volume mounts for production (not local)
	if (!isLocal) {
		containerSpec.volumeMounts = [{
			name: 'secrets-store',
			mountPath: '/mnt/secrets',
			readOnly: true
		}]
	}

	const podSpec: k8s.types.input.core.v1.PodSpec = {
		serviceAccountName: sa.metadata.name,
		containers: [containerSpec]
	}

	// Only add CSI volumes for production (not local)
	if (!isLocal && secretProvider) {
		podSpec.volumes = [{
			name: 'secrets-store',
			csi: {
				driver: 'secrets-store.csi.k8s.io',
				readOnly: true,
				volumeAttributes: {
					secretProviderClass: secretProvider.metadata.name
				}
			}
		}]
	}

	const deployment = new k8s.apps.v1.Deployment(`${args.id}-deployment`, {
		metadata: {
			name: args.id,
			annotations: {
				"pulumi.com/patchForce": "true",
			}
		},
		spec: {
			replicas: 1,
			selector: { matchLabels: { app: args.id } },
			template: {
				metadata: { labels: { app: args.id } },
				spec: podSpec
			}
		}
	}, { dependsOn: deploymentDependencies, provider: args.cluster.provider, ignoreChanges: ['spec.template.spec.containers[*].image'] })

	const service = new k8s.core.v1.Service(`${args.id}-service`, {
		metadata: { name: args.id },
		spec: {
			selector: { app: args.id },
			ports: args.ports.map((p) => ({ port: p.port, targetPort: p.port, name: p.name })),
			type: 'ClusterIP'
		}
	}, { dependsOn: [deployment], provider: args.cluster.provider })

	return new BunApp({
		deployment,
		service,
		tasks,
		taskNames,
		iamRole: role
	}, {})
}

export function createBunProductionApp(
	args: ResourceArgs<BunAppConfig>
): BunApp {
	const hasTasks = (args.tasks?.length ?? 0) > 0

	const ecrRepos = createAppEcrRepositories({
		id: `${args.id}-ecr`,
		appId: args.id,
		includeTasksRepo: hasTasks,
		region: args.region
	})

	const app = createBunKubernetesDeployment(args, ecrRepos.mainRepoUrl.apply(url => `${url}:latest`), ecrRepos.tasksRepoUrl?.apply(url => `${url}:latest`) ?? null)
	args.deploymentManager.createBunAppDeployPipeline(app, args, ecrRepos)
	return app
}
