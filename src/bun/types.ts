import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

import { Cluster } from '../cluster'
import { DeploymentManager } from '../cicd/deployManager'
import { currentAccountId, Repository } from '../types'

export interface DevPodConfig {
	nodeModulesCacheSize?: string	/** Size of PVC for node_modules cache (default: '5Gi') */
	ignorePatterns?: string[]		/** Additional file patterns to ignore during sync */
	skipInit?: boolean				/** Skip automatic initialization after deployment (default: false) */
	initTimeoutMs?: number			/** Initialization timeout in ms (default: 180000) */
}

export interface BunContainerConfig {
	name: string
	buildTask: string
	env?: EnvEntry[]
	ports?: { name: string, port: number }[]
	healthRoute?: { path: string, port: number }
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
	containers?: BunContainerConfig[]
	healthRoute?: { path: string, port: number } // this is ignored in development, necessary in all other stacks
	taskLabelKey?: string // label key applied to task CronJobs (default: "tack.dev/task-type")

	/** DevPod-specific configuration (only used in development) */
	devPod?: DevPodConfig

	cluster: Cluster
	deploymentManager: DeploymentManager
}

export interface BunAppOutputs {
	tasks: (k8s.batch.v1.Job | k8s.batch.v1.CronJob)[]
	service: k8s.core.v1.Service
	services?: Record<string, k8s.core.v1.Service>
	taskNames: string[]
	deployment: k8s.apps.v1.Deployment
	deployments?: Record<string, k8s.apps.v1.Deployment>
	iamRole?: aws.iam.Role
}

export interface BunAppWorkload {
	name: string
	id: string
	buildTask: string
	env: EnvEntry[]
	ports: { name: string, port: number }[]
	healthRoute?: { path: string, port: number }
	tasks?: { name: string, command: string }[]
	isPrimary: boolean
}

function validateContainers(containers: BunContainerConfig[]): BunContainerConfig[] {
	const seen = new Set<string>()
	const dnsLabelPattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

	return containers.map((container) => {
		const name = container.name.trim()
		const buildTask = container.buildTask.trim()

		if (name.length === 0) throw new Error('Container name cannot be empty')
		if (!dnsLabelPattern.test(name)) throw new Error(`Container name "${name}" must be lowercase alphanumeric or hyphen and valid for Kubernetes resource names`)
		if (buildTask.length === 0) throw new Error(`Container "${name}" must define a buildTask`)
		if (seen.has(name)) throw new Error(`Duplicate container name "${name}"`)

		seen.add(name)
		return {
			name,
			buildTask,
			env: container.env,
			ports: container.ports,
			healthRoute: container.healthRoute
		}
	})
}

export function getConfiguredContainers(config: Pick<BunAppConfig, 'containers'>): BunContainerConfig[] {
	return validateContainers(config.containers ?? [])
}

function mergeEnvEntries(base: EnvEntry[], overrides: EnvEntry[]): EnvEntry[] {
	const merged = new Map<string, EnvEntry>()

	for (const entry of base) merged.set(entry.name, entry)
	for (const entry of overrides) merged.set(entry.name, entry)

	return Array.from(merged.values())
}

export function getAppWorkloads(config: Pick<BunAppConfig, 'containers' | 'env' | 'ports' | 'healthRoute' | 'tasks'> & { id: string }): BunAppWorkload[] {
	const containers = getConfiguredContainers(config)
	if (containers.length === 0) {
		return [{
			name: 'application',
			id: config.id,
			buildTask: 'build',
			env: config.env,
			ports: config.ports,
			healthRoute: config.healthRoute,
			tasks: config.tasks,
			isPrimary: true
		}]
	}

	return containers.map((container, index) => ({
		name: container.name,
		id: index === 0 ? config.id : `${config.id}-${container.name}`,
		buildTask: container.buildTask,
		env: mergeEnvEntries(config.env, container.env ?? []),
		ports: container.ports ?? config.ports,
		healthRoute: container.healthRoute ?? config.healthRoute,
		tasks: index === 0 ? config.tasks : undefined,
		isPrimary: index === 0
	}))
}

export function combineBunAppOutputs(workloads: { name: string, outputs: BunAppOutputs }[]): BunAppOutputs {
	if (workloads.length === 0) throw new Error('At least one Bun workload is required')

	const [primary] = workloads
	return {
		service: primary.outputs.service,
		services: Object.fromEntries(workloads.map(({ name, outputs }) => [name, outputs.service])),
		deployment: primary.outputs.deployment,
		deployments: Object.fromEntries(workloads.map(({ name, outputs }) => [name, outputs.deployment])),
		tasks: workloads.flatMap(({ outputs }) => outputs.tasks),
		taskNames: workloads.flatMap(({ outputs }) => outputs.taskNames),
		iamRole: primary.outputs.iamRole
	}
}
