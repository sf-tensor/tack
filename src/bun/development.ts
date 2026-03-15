import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as fs from 'fs'
import { execSync } from 'child_process'
import * as path from 'path'

import { BunApp } from '.'
import { BunAppConfig, BunAppOutputs, NativeSecretEnvEntry, combineBunAppOutputs, getAppWorkloads, getEnvironmentVariables } from './types'
import { createLocalSecretsForApp } from '../secrets/local'
import { ResourceArgs, currentStack, getOrigin } from '../types'
import { initializeDevPod } from './init-devpod'

import { buildImage } from '../docker/builder'

export function createBunDevelopmentApp(args: ResourceArgs<BunAppConfig>): BunApp {
	if (!fs.existsSync(args.localPath)) {
		const origin = getOrigin(args.repository)
		execSync(`git clone ${origin} ${args.localPath}`, { stdio: 'inherit' })
	}

	const devPodContext = path.join(__dirname, 'assets', 'DevPod')
	const devPodDockerfile = path.join(devPodContext, 'Dockerfile')

	const imageTag = buildImage(`${args.id}-devpod`, devPodContext, devPodDockerfile)
	const npmrcConfigMap = args.npmrc ? new k8s.core.v1.ConfigMap(`${args.id}-npmrc`, {
		metadata: { name: `${args.id}-npmrc` },
		data: { '.npmrc': args.npmrc }
	}) : undefined

	const outputsByWorkload: { name: string, outputs: BunAppOutputs }[] = []
	const workloads = getAppWorkloads(args)

	for (const workload of workloads) {
		const nativeSecrets = workload.env
			.filter((e) => typeof e.value == 'object' && e.value.type == 'secret-arn')
			.map((e) => e.value as NativeSecretEnvEntry)

		const localSecret = createLocalSecretsForApp({
			id: workload.id,
			nativeSecrets,
			cluster: args.cluster,
			namespace: 'default'
		})

		const pvc = new k8s.core.v1.PersistentVolumeClaim(`${workload.id}-pvc`, {
			metadata: { name: `${workload.id}-cache` },
			spec: {
				accessModes: ['ReadWriteOnce'],
				resources: {
					requests: {
						storage: args.devPod?.nodeModulesCacheSize || '5Gi'
					}
				}
			}
		}, { provider: args.cluster.provider })

		const deployment = new k8s.apps.v1.Deployment(`${workload.id}-deployment`, {
			metadata: { name: workload.id },
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: workload.id } },
				template: {
					metadata: { labels: { app: workload.id } },
					spec: {
						containers: [{
							name: 'devpod',
							image: imageTag,
							imagePullPolicy: 'Never',
							ports: [
								{ containerPort: 9000, name: 'control' },
								...(workload.ports.map((p) => ({ containerPort: p.port, name: p.name })))
							],
							volumeMounts: [
								{ name: 'app', mountPath: '/app' },
								{ name: 'cache', mountPath: '/app/node_modules' },
								...(args.npmrc ? [{ name: 'npmrc', mountPath: '/root/.npmrc', subPath: '.npmrc' }] : [])
							],
							env: [
								...getEnvironmentVariables(workload.env, workload.id),
								{ name: 'STACK', value: currentStack },
								{ name: 'COMMIT_HASH', value: 'DEVELOP' },
								{ name: 'DEPLOYMENT_ID', value: 'DEVELOPMENT-LIVE' }
							],
							readinessProbe: {
								httpGet: { path: '/health', port: 9000 },
								initialDelaySeconds: 5,
								periodSeconds: 10
							},
							livenessProbe: {
								httpGet: { path: '/health', port: 9000 },
								initialDelaySeconds: 15,
								periodSeconds: 20
							}
						}],
						volumes: [
							{ name: 'cache', persistentVolumeClaim: { claimName: pvc.metadata.name } },
							{ name: 'app', emptyDir: {} },
							...(args.npmrc ? [{ name: 'npmrc', configMap: { name: npmrcConfigMap!.metadata.name } }] : [])
						]
					}
				}
			}
		}, { dependsOn: [...(args.deps ?? []), ...(localSecret ? [localSecret] : [])], provider: args.cluster.provider })

		const service = new k8s.core.v1.Service(`${workload.id}-service`, {
			metadata: { name: workload.id },
			spec: {
				selector: { app: workload.id },
				ports: [
					{ port: 9000, targetPort: 9000, name: 'control' },
					...workload.ports.map((p) => ({ port: p.port, targetPort: p.port, name: p.name })),
				],
				type: 'ClusterIP'
			}
		}, { dependsOn: [deployment], provider: args.cluster.provider })

		const skipInit = args.devPod?.skipInit ?? false
		if (!skipInit) {
			deployment.metadata.name.apply(async () => {
				if (pulumi.runtime.isDryRun()) return

				const result = await initializeDevPod({
					appId: workload.id,
					localPath: args.localPath,
					namespace: 'default',
					timeoutMs: args.devPod?.initTimeoutMs ?? 180000,
					tasks: workload.tasks
				})

				result.cleanup()
			})
		}

		outputsByWorkload.push({
			name: workload.name,
			outputs: {
				deployment,
				service,
				tasks: [],
				taskNames: [],
				iamRole: undefined
			}
		})
	}

	return new BunApp(combineBunAppOutputs(outputsByWorkload), {})
}
