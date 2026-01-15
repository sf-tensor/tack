import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"

import { execSync } from "child_process"

const BUILD_CONTEXT_IGNORE_PATTERNS = ['node_modules', '.git', '.DS_Store', 'bun.lock']

/**
 * Recursively computes a SHA256 hash of all files in a directory,
 * excluding specified patterns. Files are processed in sorted order
 * for deterministic hashing.
 */
function computeDirectoryHash(dir: string): string {
	const hash = crypto.createHash('sha256')

	function shouldIgnore(filePath: string): boolean {
		return BUILD_CONTEXT_IGNORE_PATTERNS.some(pattern => filePath.includes(pattern))
	}

	function processDirectory(currentDir: string): void {
		const entries = fs.readdirSync(currentDir, { withFileTypes: true })
		const sortedEntries = entries.sort((a, b) => a.name.localeCompare(b.name))

		for (const entry of sortedEntries) {
			const fullPath = path.join(currentDir, entry.name)
			const relativePath = path.relative(dir, fullPath)

			if (shouldIgnore(relativePath)) continue

			if (entry.isDirectory()) {
				hash.update(`dir:${relativePath}`)
				processDirectory(fullPath)
			} else if (entry.isFile()) {
				const statInfo = fs.statSync(fullPath)
				hash.update(`file:${relativePath}:${statInfo.size}:${statInfo.mtimeMs}`)
			}
		}
	}

	processDirectory(dir)
	return hash.digest('hex').substring(0, 16)
}

/**
 * Checks if a Docker image exists and retrieves its content hash label.
 * Returns null if image doesn't exist or has no hash label.
 */
function getImageContentHash(imageName: string, runCommand: (cmd: string, desc?: string) => string): string | null {
	try {
		const result = runCommand(`docker inspect --format='{{index .Config.Labels "image.content-hash"}}' ${imageName}`)

		const hash = result.trim()
		return hash && hash !== '<no value>' ? hash : null
	} catch (error: any) {
		return null
	}
}

export function buildImage(
	imageName: string,
	sourceDir: string,
	dockerfilePath: string,
	secrets: { id: string, src: string }[] = []
): string {
	const getMinikubeDockerEnv = (): Record<string, string> => {
		const output = execSync('minikube -p minikube docker-env --shell bash', { encoding: 'utf-8' })
		const env: Record<string, string> = {}
		for (const line of output.split('\n')) {
			const match = line.match(/^export (.+?)="(.+)"$/)
			if (match) {
				env[match[1]] = match[2]
			}
		}
		return env
	}

	const minikubeEnv = getMinikubeDockerEnv()
	const runCommand = (cmd: string, desc?: string) => {
		try {
			return execSync(cmd, { encoding: 'utf-8', stdio: "pipe", env: { ...process.env, ...minikubeEnv } })
		} catch (error: any) {
			if (desc) {
				console.error(`${desc} failed:`);
				if (error.stdout) process.stdout.write(error.stdout);
				if (error.stderr) process.stderr.write(error.stderr);
			}

			throw error;
		}
	}

	const contentHash = computeDirectoryHash(sourceDir)
	const existingHash = getImageContentHash(imageName, runCommand)
	const imageTag = `${imageName}:${contentHash.substring(0, 12)}`

	if (existingHash === contentHash) return imageTag

	runCommand(
		`docker build ${secrets.map(s => `--secret id=${s.id},src=${s.src}`).join(' ')} --progress=plain -f ${dockerfilePath} -t ${imageTag} --label "image.content-hash=${contentHash}" ${sourceDir}`,
		`Building image: ${imageName}`
	)

	return imageTag
}