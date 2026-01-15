import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { currentAccountId, Repository } from '../types'
import { Cluster } from '../cluster'
import { DeploymentManager } from '../cicd/deployManager'

export interface DevPodConfig {
	nodeModulesCacheSize?: string	/** Size of PVC for node_modules cache (default: '5Gi') */
	ignorePatterns?: string[]		/** Additional file patterns to ignore during sync */
	skipInit?: boolean				/** Skip automatic initialization after deployment (default: false) */
	initTimeoutMs?: number			/** Initialization timeout in ms (default: 180000) */
}

export type NativeSecretEnvEntry = { type: 'secret-arn'; secretName: pulumi.Input<string>; key?: string }

export function getNativeSecretKey(entry: NativeSecretEnvEntry): pulumi.Output<string> {
	return pulumi.output(entry.secretName).apply((name) => {
		const base = name.toLowerCase().replace(/-/g, '_').replace(/\//g, '_')
		const keyPart = entry.key ? `_${entry.key.toLowerCase()}` : ""
		return `${base}${keyPart}`
	})
}

export function getSecretArn(secretName: pulumi.Input<string>, region: string): pulumi.Output<string> {
	return pulumi.interpolate`arn:aws:secretsmanager:${region}:${currentAccountId}:secret:${secretName}-*`
}

export type EnvEntry = {
	name: string,
	value: string | { type: 'value'; value: pulumi.Input<string> } | { type: 'secret'; name: pulumi.Input<string>; key: string } | NativeSecretEnvEntry,
	isPublic?: boolean
}

export function getEnvironmentVariables(entries: EnvEntry[], id: string): pulumi.Input<k8s.types.input.core.v1.EnvVar>[] {
	return entries.map((env) => {
		if (typeof env.value == 'object') {
			if (env.value.type == 'secret') return { name: env.name, valueFrom: { secretKeyRef: { name: env.value.name, key: env.value.key } } }
			if (env.value.type == 'secret-arn') {
					return {
						name: env.name,
						valueFrom: {
							secretKeyRef: {
								name: `${id}-aws-secrets`,
								key: getNativeSecretKey(env.value)
							}
						}
					}
			}

			return { name: env.name, value: env.value.value }
		}

		return { name: env.name, value: env.value }
	})
}

export interface BunAppConfig {
	runtime: 'next' | 'base'
	localPath: string
	repository: Repository
	branch: string
	env: EnvEntry[]
	tasks?: { name: string, command: string }[]
	npmrc?: string
	ports: { name: string, port: number }[]
	healthRoute?: { path: string, port: number } // this is ignored in development, necessary in all other stacks

	/** DevPod-specific configuration (only used in development) */
	devPod?: DevPodConfig

	cluster: Cluster
	deploymentManager: DeploymentManager
}

export interface BunAppOutputs {
	tasks: (k8s.batch.v1.Job | k8s.batch.v1.CronJob)[]
	service: k8s.core.v1.Service
	taskNames: string[]
	deployment: k8s.apps.v1.Deployment
	iamRole?: aws.iam.Role
}
// Backwards-compatible aliases
export type AppConfig = BunAppConfig
export type AppOutputs = BunAppOutputs
