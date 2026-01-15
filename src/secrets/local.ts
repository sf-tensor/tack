import * as fs from 'fs'
import * as path from 'path'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import { Cluster } from '../cluster'
import { NativeSecretEnvEntry, getNativeSecretKey } from '../bun/types'

const SECRETS_FILE_PATH = '.secrets'

interface ParsedSecret {
	secretName: string
	value: string
	parsedValue: Record<string, string> | string
}

/**
 * Reads and parses the .secrets file
 * Format: secretName:JSON_or_plain_value
 * Example: staging/elastic-cloud/stripe-key:{"secret_key":"sk_test_xxx","publishable_key":"pk_test_xxx"}
 */
export function readSecretsFile(filePath: string = SECRETS_FILE_PATH): Map<string, ParsedSecret> {
	const secrets = new Map<string, ParsedSecret>()

	const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath)

	if (!fs.existsSync(resolvedPath)) {
		console.warn(`[local-secrets] No .secrets file found at ${resolvedPath}`)
		return secrets
	}

	const content = fs.readFileSync(resolvedPath, 'utf-8')
	const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'))

	for (const line of lines) {
		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) {
			console.warn(`[local-secrets] Invalid line format (missing colon): ${line.substring(0, 50)}...`)
			continue
		}

		const secretName = line.substring(0, colonIndex).trim()
		const valueStr = line.substring(colonIndex + 1).trim()

		let parsedValue: Record<string, string> | string
		try {
			parsedValue = JSON.parse(valueStr)
		} catch {
			parsedValue = valueStr
		}

		secrets.set(secretName, {
			secretName,
			value: valueStr,
			parsedValue
		})
	}

	return secrets
}

/**
 * Creates a K8s Secret from the .secrets file for a specific app
 * This mimics the AWS SecretProviderClass behavior but reads from local file
 */
export function createLocalSecretsForApp(args: {
	id: string
	nativeSecrets: NativeSecretEnvEntry[]
	cluster: Cluster
	namespace?: string
}): k8s.core.v1.Secret | null {
	const secrets = readSecretsFile()
	const namespace = args.namespace ?? 'default'

	if (args.nativeSecrets.length === 0) {
		return null
	}

	const stringData: Record<string, pulumi.Input<string>> = {}

	for (const entry of args.nativeSecrets) {
		const key = getNativeSecretKey(entry)

		const secretValue = pulumi.output(entry.secretName).apply(name => {
			const secret = secrets.get(name)
			if (!secret) {
				console.warn(`[local-secrets] Secret "${name}" not found in .secrets file`)
				return ''
			}

			if (entry.key) {
				if (typeof secret.parsedValue === 'object') {
					return secret.parsedValue[entry.key] ?? ''
				}
				console.warn(`[local-secrets] Secret "${name}" is not JSON, but key "${entry.key}" was requested`)
				return ''
			}

			return secret.value
		})

		// We need to resolve the key synchronously since it's used as object property
		// getNativeSecretKey returns Output<string>, but we need to handle it
		pulumi.output(key).apply(k => {
			stringData[k] = secretValue
		})
	}

	// Build stringData synchronously by computing keys upfront
	const computedStringData: Record<string, pulumi.Input<string>> = {}

	for (const entry of args.nativeSecrets) {
		// Compute key synchronously from the secretName pattern
		const secretNameStr = typeof entry.secretName === 'string' ? entry.secretName : ''
		const base = secretNameStr.toLowerCase().replace(/-/g, '_').replace(/\//g, '_')
		const keyPart = entry.key ? `_${entry.key.toLowerCase()}` : ""
		const computedKey = `${base}${keyPart}`

		const secretValue = pulumi.output(entry.secretName).apply(name => {
			const secret = secrets.get(name)
			if (!secret) {
				console.warn(`[local-secrets] Secret "${name}" not found in .secrets file`)
				return ''
			}

			if (entry.key) {
				if (typeof secret.parsedValue === 'object') {
					return secret.parsedValue[entry.key] ?? ''
				}
				console.warn(`[local-secrets] Secret "${name}" is not JSON, but key "${entry.key}" was requested`)
				return ''
			}

			return secret.value
		})

		computedStringData[computedKey] = secretValue
	}

	return new k8s.core.v1.Secret(`${args.id}-local-secrets`, {
		metadata: {
			name: `${args.id}-aws-secrets`,
			namespace
		},
		stringData: computedStringData
	}, { provider: args.cluster.provider })
}

export interface LocalSecretsConfig {
	id: string
	nativeSecrets: NativeSecretEnvEntry[]
	cluster: Cluster
	namespace?: string
}
