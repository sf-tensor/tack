import { join, relative } from 'path'
import { readFile, readdir } from 'fs/promises'
import { spawn, type ChildProcess } from 'child_process'

// Hash a string to a port number for deterministic pod-based port assignment
function hashStringToPort(str: string, basePort: number, range: number = 1000): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash) + str.charCodeAt(i)
		hash = hash & hash // Convert to 32-bit integer
	}
	return basePort + (Math.abs(hash) % range)
}

export interface Task {
	name: string
	command: string
}

export interface InitDevPodConfig {
	appId: string
	localPath: string
	namespace?: string
	controlPort?: number
	timeoutMs?: number
	tasks?: Task[]
}

export interface InitResult {
	success: boolean
	message: string
	cleanup: () => void
}

const IGNORE_PATTERNS = [
	'node_modules',
	'.next',
	'.git',
	'dist',
	'build',
	'.DS_Store',
	'.turbo',
	'.vercel',
	'coverage',
	'.nyc_output'
]

function shouldIgnore(path: string): boolean {
	return IGNORE_PATTERNS.some(pattern => path.includes(pattern))
}

async function getAllFiles(dir: string, baseDir: string = dir): Promise<string[]> {
	const files: string[] = []

	try {
		const entries = await readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = join(dir, entry.name)
			const relativePath = relative(baseDir, fullPath)

			if (shouldIgnore(relativePath)) continue

			if (entry.isDirectory()) {
				const subFiles = await getAllFiles(fullPath, baseDir)
				files.push(...subFiles)
			} else if (entry.isFile()) {
				files.push(relativePath)
			}
		}
	} catch (error) {
		console.error(`[DevPod Init] Error reading directory ${dir}:`, error)
	}

	return files
}

async function findPodName(appId: string, namespace: string): Promise<string | null> {
	return new Promise((resolve) => {
		const proc = spawn('kubectl', [
			'get', 'pods',
			`-n=${namespace}`,
			`-l=app=${appId}`,
			'-o=jsonpath={.items[0].metadata.name}'
		])

		let podName = ''
		proc.stdout?.on('data', (data) => {
			podName += data.toString()
		})
		proc.on('close', (code) => {
			resolve(code === 0 && podName ? podName.trim() : null)
		})
		proc.on('error', () => resolve(null))
	})
}

async function isPodReady(podName: string, namespace: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('kubectl', [
			'get', 'pod', podName,
			`-n=${namespace}`,
			'-o=jsonpath={.status.conditions[?(@.type=="Ready")].status}'
		])

		let status = ''
		proc.stdout?.on('data', (data) => {
			status += data.toString()
		})
		proc.on('close', () => {
			resolve(status.trim() === 'True')
		})
		proc.on('error', () => resolve(false))
	})
}

async function waitForPodReady(appId: string, namespace: string, timeoutMs: number): Promise<boolean> {
	const startTime = Date.now()
	const checkInterval = 2000

	console.log(`[DevPod Init] Waiting for pod ${appId} to be ready...`)

	while (Date.now() - startTime < timeoutMs) {
		const podName = await findPodName(appId, namespace)
		if (podName) {
			const ready = await isPodReady(podName, namespace)
			if (ready) {
				console.log(`[DevPod Init] Pod ${podName} is ready`)
				return true
			}
		}
		await new Promise(resolve => setTimeout(resolve, checkInterval))
	}

	return false
}

function startPortForward(podName: string, namespace: string, localPort: number, remotePort: number): ChildProcess {
	const proc = spawn('kubectl', [
		'port-forward',
		`-n=${namespace}`,
		`pod/${podName}`,
		`${localPort}:${remotePort}`
	])

	proc.stderr?.on('data', (data) => {
		const msg = data.toString().trim()
		if (msg && !msg.includes('Forwarding') && !msg.includes('Handling connection')) {
			console.error(`[DevPod Init] Port forward: ${msg}`)
		}
	})

	proc.on('error', (err) => {
		console.error(`[DevPod Init] Port forward error: ${err.message}`)
	})

	return proc
}

async function healthCheck(controlUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${controlUrl}/health`)
		return response.ok
	} catch {
		return false
	}
}

async function waitForHealthCheck(controlUrl: string, timeoutMs: number = 30000): Promise<boolean> {
	const startTime = Date.now()

	while (Date.now() - startTime < timeoutMs) {
		if (await healthCheck(controlUrl)) {
			return true
		}
		await new Promise(resolve => setTimeout(resolve, 1000))
	}

	return false
}

async function initialSync(localPath: string, controlUrl: string): Promise<{ success: boolean; synced: number; total: number }> {
	console.log(`[DevPod Init] Syncing files from ${localPath}...`)

	const files = await getAllFiles(localPath)
	console.log(`[DevPod Init] Found ${files.length} files to sync`)

	const chunkSize = 20
	let synced = 0

	for (let i = 0; i < files.length; i += chunkSize) {
		const chunk = files.slice(i, i + chunkSize)
		const batch: { path: string; content: string }[] = []

		for (const file of chunk) {
			try {
				const fullPath = join(localPath, file)
				const content = await readFile(fullPath)
				batch.push({
					path: file,
					content: content.toString('base64')
				})
			} catch {
				// Skip files that can't be read
			}
		}

		if (batch.length > 0) {
			try {
				const response = await fetch(`${controlUrl}/files/batch`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(batch)
				})

				if (response.ok) {
					synced += batch.length
					const progress = Math.round((synced / files.length) * 100)
					process.stdout.write(`\r[DevPod Init] Progress: ${synced}/${files.length} (${progress}%)`)
				}
			} catch (error) {
				console.error(`\n[DevPod Init] Sync batch failed:`, error)
			}
		}
	}

	console.log(`\n[DevPod Init] Sync complete: ${synced}/${files.length} files`)
	return { success: synced > 0 || files.length === 0, synced, total: files.length }
}

async function runInstall(controlUrl: string): Promise<{ success: boolean; message: string }> {
	console.log('[DevPod Init] Running bun install...')

	try {
		const response = await fetch(`${controlUrl}/install`, { method: 'POST' })
		const result = await response.json() as { success: boolean; message: string }
		console.log(`[DevPod Init] Install result: ${result.message}`)
		return result
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[DevPod Init] Install failed: ${message}`)
		return { success: false, message }
	}
}

async function runTask(controlUrl: string, task: Task): Promise<{ success: boolean; message: string }> {
	console.log(`[DevPod Init] Running task "${task.name}": ${task.command}`)

	try {
		const response = await fetch(`${controlUrl}/run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: task.command })
		})
		const result = await response.json() as { success: boolean; message: string; output?: string }
		if (result.success) {
			console.log(`[DevPod Init] Task "${task.name}" completed successfully`)
		} else {
			console.error(`[DevPod Init] Task "${task.name}" failed: ${result.message}`)
			if (result.output) {
				console.error(`[DevPod Init] Task output:\n${result.output}`)
			}
		}
		return result
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[DevPod Init] Task "${task.name}" error: ${message}`)
		return { success: false, message }
	}
}

async function runTasks(controlUrl: string, tasks: Task[]): Promise<{ success: boolean; message: string }> {
	if (tasks.length === 0) {
		return { success: true, message: 'No tasks to run' }
	}

	console.log(`[DevPod Init] Running ${tasks.length} task(s)...`)

	for (const task of tasks) {
		const result = await runTask(controlUrl, task)
		if (!result.success) {
			return { success: false, message: `Task "${task.name}" failed: ${result.message}` }
		}
	}

	return { success: true, message: `All ${tasks.length} task(s) completed successfully` }
}

export async function initializeDevPod(config: InitDevPodConfig): Promise<InitResult> {
	const namespace = config.namespace || 'default'
	// Use a unique local port derived from appId to avoid conflicts when multiple DevPods initialize in parallel
	const localPort = config.controlPort || hashStringToPort(config.appId, 19000, 1000)
	const remotePort = 9000 // Control server always listens on 9000 inside the pod
	const timeoutMs = config.timeoutMs || 180000
	const controlUrl = `http://localhost:${localPort}`

	let portForwardProcess: ChildProcess | undefined

	const cleanup = () => {
		if (portForwardProcess) {
			portForwardProcess.kill()
			portForwardProcess = undefined
		}
	}

	try {
		// Step 1: Wait for pod to be ready
		const podReady = await waitForPodReady(config.appId, namespace, timeoutMs)
		if (!podReady) {
			return { success: false, message: 'Timeout waiting for pod to be ready', cleanup }
		}

		// Step 2: Find the pod name and start port forwarding
		const podName = await findPodName(config.appId, namespace)
		if (!podName) {
			return { success: false, message: `No pod found with label app=${config.appId}`, cleanup }
		}

		console.log(`[DevPod Init] Starting port forwarding to ${podName} (localhost:${localPort} -> pod:${remotePort})...`)
		portForwardProcess = startPortForward(podName, namespace, localPort, remotePort)

		// Wait for port forward to establish
		await new Promise(resolve => setTimeout(resolve, 2000))

		// Step 3: Wait for health check to pass
		console.log('[DevPod Init] Waiting for control server health check...')
		const healthCheckPassed = await waitForHealthCheck(controlUrl)
		if (!healthCheckPassed) {
			return { success: false, message: 'Control server health check failed', cleanup }
		}
		console.log('[DevPod Init] Control server is healthy')

		// Step 4: Perform initial file sync
		const syncResult = await initialSync(config.localPath, controlUrl)
		if (!syncResult.success) {
			return { success: false, message: 'File sync failed', cleanup }
		}

		// Step 5: Run bun install
		const installResult = await runInstall(controlUrl)
		if (!installResult.success) {
			return { success: false, message: `Install failed: ${installResult.message}`, cleanup }
		}

		// Step 6: Run tasks (e.g., database migrations)
		const tasks = config.tasks || []
		if (tasks.length > 0) {
			const tasksResult = await runTasks(controlUrl, tasks)
			if (!tasksResult.success) {
				return { success: false, message: tasksResult.message, cleanup }
			}
		}

		const tasksSummary = tasks.length > 0 ? `, ${tasks.length} task(s) completed` : ''
		return {
			success: true,
			message: `Initialized: synced ${syncResult.synced} files, dependencies installed${tasksSummary}`,
			cleanup
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { success: false, message: `Initialization error: ${message}`, cleanup }
	}
}
