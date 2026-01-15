import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as fs from "fs"
import * as crypto from "crypto"
import { execSync } from "child_process"
import * as path from "path"

import { BunApp } from "."
import { getEnvironmentVariables, BunAppConfig, NativeSecretEnvEntry } from "./types"
import { createLocalSecretsForApp } from '../secrets/local'
import { ResourceArgs, currentStack, getOrigin } from "../types"
import { initializeDevPod } from "./init-devpod"

import { buildImage } from "../docker/builder"

export function createBunDevelopmentApp(args: ResourceArgs<BunAppConfig>): BunApp {
	if (!fs.existsSync(args.localPath)) {
		const origin = getOrigin(args.repository)
		execSync(`git clone ${origin} ${args.localPath}`, { stdio: "inherit" })
	}

	const devPodContext = path.join(__dirname, 'assets', 'DevPod')
	const devPodDockerfile = path.join(devPodContext, 'Dockerfile')

	const imageTag = buildImage(`${args.id}-devpod`, devPodContext, devPodDockerfile)

	const nativeSecrets = args.env
		.filter((e) => typeof e.value == 'object' && e.value.type == 'secret-arn')
		.map((e) => e.value as NativeSecretEnvEntry)

	const localSecret = createLocalSecretsForApp({
		id: args.id,
		nativeSecrets,
		cluster: args.cluster,
		namespace: 'default'
	})

	const pvc = new k8s.core.v1.PersistentVolumeClaim(`${args.id}-pvc`, {
		metadata: { name: `${args.id}-cache` },
		spec: {
			accessModes: ['ReadWriteOnce'],
			resources: {
				requests: {
					storage: args.devPod?.nodeModulesCacheSize || '5Gi'
				}
			}
		}
	}, { provider: args.cluster.provider })

	const npmrcConfigMap = args.npmrc ? new k8s.core.v1.ConfigMap(`${args.id}-npmrc`, {
		metadata: { name: `${args.id}-npmrc` },
		data: { '.npmrc': args.npmrc }
	}) : undefined

	const deployment = new k8s.apps.v1.Deployment(`${args.id}-deployment`, {
		metadata: { name: args.id },
		spec: {
			replicas: 1,
			selector: { matchLabels: { app: args.id } },
			template: {
				metadata: { labels: { app: args.id } },
				spec: {
					containers: [{
						name: 'devpod',
						image: imageTag,
						imagePullPolicy: 'Never',
						ports: [
							{ containerPort: 9000, name: 'control' },
							...(args.ports.map((p) => ({ containerPort: p.port, name: p.name })))
						],
						volumeMounts: [
							{ name: 'cache', mountPath: '/app/node_modules' },
							{ name: 'app', mountPath: '/app' },
							...(args.npmrc ? [{ name: 'npmrc', mountPath: '/root/.npmrc', subPath: '.npmrc' }] : [])
						],
						env: [
							...getEnvironmentVariables(args.env, args.id),
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

	const service = new k8s.core.v1.Service(`${args.id}-service`, {
		metadata: { name: args.id },
		spec: {
			selector: { app: args.id },
			ports: [
				{ port: 9000, targetPort: 9000, name: 'control' },
				...args.ports.map((p) => ({ port: p.port, targetPort: p.port, name: p.name })),
			],
			type: 'ClusterIP'
		}
	}, { dependsOn: [deployment], provider: args.cluster.provider })

	const skipInit = args.devPod?.skipInit ?? false
	if (!skipInit) {
		deployment.metadata.name.apply(async (deploymentName) => {
			if (pulumi.runtime.isDryRun()) { return }

			const result = await initializeDevPod({
				appId: args.id,
				localPath: args.localPath,
				namespace: 'default',
				timeoutMs: args.devPod?.initTimeoutMs ?? 180000,
				tasks: args.tasks
			})

			result.cleanup()
		})
	}

	return new BunApp({
		deployment,
		service,
		tasks: [],
		taskNames: [],
		iamRole: undefined
	}, {})
}