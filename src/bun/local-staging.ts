import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"

import { BunApp } from "./index"
import { buildImage } from "../docker/builder"
import { readSecretsFile } from "../secrets/local"
import { BunAppConfig, BunAppOutputs, EnvEntry, getAppWorkloads, combineBunAppOutputs } from "./types"
import { getOrigin, ResourceArgs } from "../types"
import { createBunKubernetesDeployment } from "./production"

function resolvePublicEnvValue(entry: EnvEntry): string {
	if (typeof entry.value === 'string') {
		return entry.value
	}

	if (entry.value.type === 'value') {
		if (typeof entry.value.value === 'string') {
			return entry.value.value
		}
		throw new Error(`[local-staging] Cannot resolve Output value for ${entry.name} at build time - value must be a plain string`)
	}

	if (entry.value.type === 'secret-arn') {
		const secrets = readSecretsFile()
		const secretName = typeof entry.value.secretName === 'string'
			? entry.value.secretName
			: null

		if (!secretName) {
			throw new Error(`[local-staging] Cannot resolve Output secretName for ${entry.name} - secretName must be a plain string`)
		}

		const secret = secrets.get(secretName)
		if (!secret) {
			throw new Error(`[local-staging] Secret "${secretName}" not found in .secrets file for env var ${entry.name}`)
		}

		if (entry.value.key && typeof secret.parsedValue === 'object') {
			const value = secret.parsedValue[entry.value.key]
			if (value === undefined) {
				throw new Error(`[local-staging] Key "${entry.value.key}" not found in secret "${secretName}" for env var ${entry.name}`)
			}
			return value
		}
		return secret.value
	}

	if (entry.value.type === 'secret') {
		throw new Error(`[local-staging] Cannot resolve K8s secret for ${entry.name} at build time - use secret-arn instead`)
	}

	throw new Error(`[local-staging] Unknown env value type for ${entry.name}`)
}

export function createBunLocalStagingApp(args: ResourceArgs<BunAppConfig>): BunApp {
	if (!fs.existsSync(args.localPath)) {
		const origin = getOrigin(args.repository)
		execSync(`git clone ${origin} ${args.localPath}`, { stdio: "inherit" })
	}

	const dockerFile = path.join(__dirname, 'assets', args.runtime == 'next' ? 'Dockerfile.next' : 'Dockerfile.base')

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tack-bun-local-staging-build-'))

	try {
		const npmrcFile = path.join(tempDir, 'npmrc')
		if (args.npmrc) {
			fs.writeFileSync(npmrcFile, args.npmrc)
		}

		// Create .env file with public env vars (mirrors CodeBuild behavior)
		const workloads = getAppWorkloads(args)
		const outputsByWorkload: { name: string, outputs: BunAppOutputs }[] = []

		for (const workload of workloads) {
			const envFile = path.join(tempDir, `.env.${workload.name}`)
			const publicEnvVars = workload.env
				.filter((e) => e.isPublic === true)
				.map((e) => `${e.name}="${resolvePublicEnvValue(e)}"`)
				.join('\n')
			fs.writeFileSync(envFile, publicEnvVars)

			const secrets = [
				{ id: 'env', src: envFile },
				...(args.npmrc ? [{ id: 'npmrc', src: npmrcFile }] : [])
			]

			const imageTag = buildImage(workload.id, args.localPath, dockerFile, {
				secrets,
				buildArgs: { BUILD_TASK: workload.buildTask }
			})
			let tasksImageTag: string | null = null
			if ((workload.tasks?.length ?? 0) > 0) {
				const tasksDockerFile = path.join(__dirname, 'assets', 'Dockerfile.tasks')
				tasksImageTag = buildImage(`${workload.id}-tasks`, args.localPath, tasksDockerFile, { secrets })
			}

			const workloadArgs: ResourceArgs<BunAppConfig> = {
				...args,
				id: workload.id,
				env: workload.env,
				ports: workload.ports,
				healthRoute: workload.healthRoute,
				tasks: workload.tasks,
				containers: undefined
			}

			outputsByWorkload.push({
				name: workload.name,
				outputs: createBunKubernetesDeployment(workloadArgs, imageTag, tasksImageTag)
			})
		}

		return new BunApp(combineBunAppOutputs(outputsByWorkload), {})
	} finally {
		fs.rmSync(tempDir, { recursive: true })
	}
}
