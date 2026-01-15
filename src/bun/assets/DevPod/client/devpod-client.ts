#!/usr/bin/env bun

import { watch } from 'fs'
import { readFile, stat, readdir } from 'fs/promises'
import { join, relative } from 'path'
import { spawn, type ChildProcess } from 'child_process'

interface PortMapping {
	local: number
	remote: number
}

interface DevPodConfig {
	podName: string
	namespace: string
	localPath: string
	controlPort: number
	appPorts: PortMapping[]
}

function hashStringToPort(str: string, basePort: number, range: number = 1000): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash) + str.charCodeAt(i)
		hash = hash & hash
	}
	return basePort + (Math.abs(hash) % range)
}

class DevPodClient {
	private config: DevPodConfig
	private portForwardProcess?: ChildProcess
	private controlUrl: string
	private syncQueue: Set<string> = new Set()
	private syncTimer?: ReturnType<typeof setTimeout>
	private reconnectAttempts = 0
	private maxReconnectAttempts = 10
	private isReconnecting = false
	private shouldReconnect = true
	private logStreamAbortController?: AbortController
	private logStreamReconnectAttempts = 0
	private maxLogStreamReconnectAttempts = 5
	private ignorePatterns = [
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

	constructor(config: DevPodConfig) {
		this.config = config
		this.controlUrl = `http://localhost:${config.controlPort}`
	}

	private shouldIgnore(path: string): boolean {
		return this.ignorePatterns.some(pattern => path.includes(pattern))
	}

	private getReconnectDelay(): number {
		const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
		return delay
	}

	private async reconnect(): Promise<boolean> {
		if (this.isReconnecting || !this.shouldReconnect) return false

		this.isReconnecting = true
		this.reconnectAttempts++

		if (this.reconnectAttempts > this.maxReconnectAttempts) {
			console.error(`Max reconnection attempts (${this.maxReconnectAttempts}) exceeded. Giving up.`)
			this.isReconnecting = false
			return false
		}

		const delay = this.getReconnectDelay()
		console.log(`Connection lost. Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)
		await new Promise(resolve => setTimeout(resolve, delay))

		if (this.portForwardProcess) {
			this.portForwardProcess.kill()
			this.portForwardProcess = undefined
		}

		const success = await this.setupPortForwarding()
		this.isReconnecting = false

		if (success) {
			console.log('Reconnected successfully!')
			this.reconnectAttempts = 0
			this.logStreamReconnectAttempts = 0
			this.startLogStreaming()
		}

		return success
	}

	async setupPortForwarding(): Promise<boolean> {
		if (process.env['DEVPOD_FORWARD'] === 'NO') return true

		console.log('Setting up port forwarding...')

		const getPodProc = spawn('kubectl', [
			'get', 'pods',
			`-n=${this.config.namespace}`,
			`-l=app=${this.config.podName}`,
			'-o=jsonpath={.items[0].metadata.name}'
		])

		let podName = ''
		await new Promise<void>((resolve) => {
			getPodProc.stdout?.on('data', (data) => {
				podName += data.toString()
			})
			getPodProc.on('close', resolve)
		})

		if (!podName) {
			console.error(`No pod found with label app=${this.config.podName}`)
			return false
		}

		console.log(`Found pod: ${podName}`)

		const portArgs = [
			`${this.config.controlPort}:9000`,
			...this.config.appPorts.map(p => `${p.local}:${p.remote}`)
		]

		const proc = spawn('kubectl', [
			'port-forward',
			`-n=${this.config.namespace}`,
			`pod/${podName}`,
			...portArgs
		])

		proc.stdout?.on('data', (data) => {
			const msg = data.toString().trim()
			if (msg && !msg.includes('Handling connection for')) {
				console.log(`[kubectl] ${msg}`)
			}
		})

		proc.stderr?.on('data', (data) => {
			const msg = data.toString().trim()
			if (msg && !msg.includes('Forwarding')) {
				console.error(`[kubectl] ${msg}`)
			}
		})

		proc.on('error', (err) => {
			console.error(`Port forward error: ${err.message}`)
		})

		proc.on('close', (code) => {
			if (this.shouldReconnect && !this.isReconnecting) {
				console.error(`Port forward process exited with code ${code}`)
				this.reconnect()
			}
		})

		this.portForwardProcess = proc

		await new Promise(resolve => setTimeout(resolve, 2000))

		try {
			const response = await fetch(`${this.controlUrl}/health`)
			if (response.ok) {
				console.log('Port forwarding active:')
				console.log(`  Control: http://localhost:${this.config.controlPort}`)
				for (const port of this.config.appPorts) {
					console.log(`  App: http://localhost:${port.local} -> pod:${port.remote}`)
				}
				return true
			}
		} catch {
			console.error('Failed to connect to DevPod. Is the pod running?')
			return false
		}

		return true
	}

	async request<T = any>(path: string, options?: RequestInit): Promise<T & { success: boolean; message?: string }> {
		try {
			const response = await fetch(`${this.controlUrl}${path}`, options)
			return await response.json() as T & { success: boolean; message?: string }
		} catch (error) {
			console.error(`Request failed: ${error}`)
			return { success: false, message: String(error) } as T & { success: boolean; message?: string }
		}
	}

	async status() {
		const result = await this.request('/status')
		console.log('\nDevPod Status:')
		console.log(`  Server Status: ${result.status || 'unknown'}`)
		console.log(`  Has package.json: ${result.hasPackageJson ? 'yes' : 'no'}`)
		console.log(`  Has node_modules: ${result.hasNodeModules ? 'yes' : 'no'}`)
		if (result.lastError) {
			console.log(`  Last Error: ${result.lastError}`)
		}
		return result
	}

	async install() {
		console.log('Running bun install...')
		const result = await this.request('/install', { method: 'POST' })
		console.log(result.message || 'Install completed')
		return result
	}

	async start() {
		console.log('Starting dev server...')
		const result = await this.request('/start', { method: 'POST' })
		console.log(result.message || 'Start completed')
		return result
	}

	async stop() {
		console.log('Stopping dev server...')
		const result = await this.request('/stop', { method: 'POST' })
		console.log(result.message || 'Stop completed')
		return result
	}

	async restart() {
		console.log('Restarting dev server...')
		const result = await this.request('/restart', { method: 'POST' })
		console.log(result.message || 'Restart completed')
		return result
	}

	async prod() {
		console.log('Building and starting production server...')
		const result = await this.request('/prod', { method: 'POST' })
		console.log(result.message || 'Production server started')
		return result
	}

	async run(filename: string) {
		console.log(`Running bun run ${filename}...`)
		const result = await this.request<{ output: string }>('/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename })
		})
		if (result.output) {
			console.log('\n--- Output ---')
			console.log(result.output)
		}
		console.log(result.message || 'Run completed')
		return result
	}

	async logs() {
		const result = await this.request<{ logs: string[] }>('/logs')
		if (result.logs) {
			result.logs.forEach((log: string) => console.log(log))
		}
	}

	async streamLogs() {
		console.log('Streaming logs... (Ctrl+C to stop)\n')
		try {
			const response = await fetch(`${this.controlUrl}/logs/stream`)
			const reader = response.body?.getReader()
			const decoder = new TextDecoder()

			if (!reader) {
				console.error('Failed to get log stream')
				return
			}

			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				const text = decoder.decode(value)
				const lines = text.split('\n\n')

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						try {
							const data = JSON.parse(line.slice(6))
							console.log(data.log)
						} catch {
							// Ignore parse errors
						}
					}
				}
			}
		} catch (error) {
			console.error(`Log stream error [1]: ${error}`)
		}
	}

	private startLogStreaming() {
		this.streamLogsBackground().catch(err => {
			if (!this.shouldReconnect) return // Don't log errors during shutdown
			console.error(`Log stream error [2]: ${err}`)
			setTimeout(() => {
				if (this.shouldReconnect) {
					console.log('Reconnecting log stream...')
					this.startLogStreaming()
				}
			}, 2000)
		})
	}

	private async streamLogsBackground() {
		if (this.logStreamAbortController) this.logStreamAbortController.abort()
		this.logStreamAbortController = new AbortController()

		const startTime = new Date()

		const response = await fetch(`${this.controlUrl}/logs/stream?skipHistory=true`, {
			signal: this.logStreamAbortController.signal
		})
		const reader = response.body?.getReader()
		const decoder = new TextDecoder()

		if (!reader) return

		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			const text = decoder.decode(value)
			const lines = text.split('\n\n')

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					try {
						const data = JSON.parse(line.slice(6))
						const logLine: string = data.log || ''

						// Client-side filter: parse timestamp from log message [ISO_TIMESTAMP]
						// Format: [2024-12-19T10:30:00.000Z] message...
						const timestampMatch = logLine.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/)
						if (timestampMatch) {
							const logTime = new Date(timestampMatch[1])
							if (logTime < startTime) {
								continue
							}
						}

						console.log(logLine)
					} catch { /* Ignore parse errors */ }
				}
			}
		}
	}

	async syncFile(relativePath: string) {
		if (this.shouldIgnore(relativePath)) return

		const fullPath = join(this.config.localPath, relativePath)

		try {
			const stats = await stat(fullPath)
			if (!stats.isFile()) return

			const content = await readFile(fullPath)
			const formData = new FormData()
			formData.append('path', relativePath)
			formData.append('content', new Blob([new Uint8Array(content)]))

			const response = await fetch(`${this.controlUrl}/files`, {
				method: 'POST',
				body: formData
			})

			if (response.ok) {
				console.log(`Synced: ${relativePath}`)
			} else {
				const result = await response.json()
				console.error(`Failed to sync ${relativePath}: ${result.message}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// Send delete request
				const formData = new FormData()
				formData.append('path', relativePath)
				formData.append('delete', 'true')
				formData.append('content', new Blob([]))

				await fetch(`${this.controlUrl}/files`, {
					method: 'POST',
					body: formData
				})
				console.log(`Deleted: ${relativePath}`)
			} else {
				console.error(`Error syncing ${relativePath}:`, error)
			}
		}
	}

	private async processSyncQueue() {
		const files = Array.from(this.syncQueue)
		this.syncQueue.clear()

		for (const file of files) {
			await this.syncFile(file)
		}
	}

	async startWatch(streamLogs: boolean = false) {
		console.log(`\nWatching for file changes in ${this.config.localPath}...`)
		console.log('Press Ctrl+C to stop.\n')

		if (streamLogs) {
			this.logStreamReconnectAttempts = 0
			this.startLogStreaming()
		}

		watch(
			this.config.localPath,
			{ recursive: true },
			(_eventType, filename) => {
				if (!filename || this.shouldIgnore(filename)) return

				this.syncQueue.add(filename)

				if (this.syncTimer) clearTimeout(this.syncTimer)
				this.syncTimer = setTimeout(() => {
					this.processSyncQueue()
				}, 100)
			}
		)

		await new Promise(() => { })
	}

	private async getAllFiles(dir: string, baseDir: string = dir): Promise<string[]> {
		const files: string[] = []

		try {
			const entries = await readdir(dir, { withFileTypes: true })

			for (const entry of entries) {
				const fullPath = join(dir, entry.name)
				const relativePath = relative(baseDir, fullPath)

				if (this.shouldIgnore(relativePath)) continue

				if (entry.isDirectory()) {
					const subFiles = await this.getAllFiles(fullPath, baseDir)
					files.push(...subFiles)
				} else if (entry.isFile()) {
					files.push(relativePath)
				}
			}
		} catch (error) {
			console.error(`Error reading directory ${dir}:`, error)
		}

		return files
	}

	async initialSync() {
		console.log('Performing initial sync...')

		const files = await this.getAllFiles(this.config.localPath)
		console.log(`Found ${files.length} files to sync`)

		let synced = 0
		const chunkSize = 20

		for (let i = 0; i < files.length; i += chunkSize) {
			const chunk = files.slice(i, i + chunkSize)

			const batch: { path: string; content: string }[] = []
			for (const file of chunk) {
				try {
					const fullPath = join(this.config.localPath, file)
					const content = await readFile(fullPath)
					batch.push({
						path: file,
						content: content.toString('base64')
					})
				} catch { /* Skip files that can't be read */ }
			}

			if (batch.length > 0) {
				const response = await fetch(`${this.controlUrl}/files/batch`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(batch)
				})

				if (response.ok) {
					synced += batch.length
					const progress = Math.round((synced / files.length) * 100)
					process.stdout.write(`\rProgress: ${synced}/${files.length} (${progress}%)`)
				}
			}
		}

		console.log('\nInitial sync complete')
	}

	async cleanup() {
		this.shouldReconnect = false

		if (this.logStreamAbortController) {
			this.logStreamAbortController.abort()
		}

		if (this.portForwardProcess) {
			this.portForwardProcess.kill()
			console.log('\nPort forwarding stopped')
		}
	}
}

const args = process.argv.slice(2)

interface ParsedArgs {
	command: string
	podName: string
	namespace: string
	controlPort?: number
	appPorts: PortMapping[]
	localPath: string
	extra: string[]
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		command: '',
		podName: '',
		namespace: 'default',
		appPorts: [],
		localPath: process.cwd(),
		extra: []
	}

	let i = 0

	if (args[i] && !args[i].startsWith('-')) {
		result.command = args[i]
		i++
	}

	if (args[i] && !args[i].startsWith('-')) {
		result.podName = args[i]
		i++
	}

	while (i < args.length) {
		const arg = args[i]

		if (arg === '-n' || arg === '--namespace') {
			result.namespace = args[++i] || 'default'
		} else if (arg === '-c' || arg === '--control-port') {
			result.controlPort = parseInt(args[++i] || '')
		} else if (arg === '-a' || arg === '--app-port') {
			const portArg = args[++i] || ''
			if (portArg.includes(':')) {
				const [local, remote] = portArg.split(':').map(p => parseInt(p))
				if (!isNaN(local) && !isNaN(remote)) result.appPorts.push({ local, remote })
			} else {
				const port = parseInt(portArg)
				if (!isNaN(port)) result.appPorts.push({ local: port, remote: port })
			}
		} else if (arg === '-p' || arg === '--path') {
			result.localPath = args[++i] || process.cwd()
		} else {
			result.extra.push(arg)
		}

		i++
	}

	return result
}

const parsed = parseArgs(args)
const command = parsed.command

const needsPodName = command && !['help', '--help', '-h'].includes(command)
if (needsPodName && !parsed.podName) {
	console.error('Error: Pod name is required')
	console.error('Usage: devpod <command> <podname> [-n namespace] [-c control_port] [-a app_port]')
	process.exit(1)
}

const config: DevPodConfig = {
	podName: parsed.podName,
	namespace: parsed.namespace,
	localPath: parsed.localPath,
	controlPort: parsed.controlPort || hashStringToPort(parsed.podName || 'default', 9000),
	appPorts: parsed.appPorts
}

const client = new DevPodClient(config)

function showHelp() {
	console.log(`
DevPod Client - Control your Next.js DevPod

Usage: devpod <command> <podname> [options]

Commands:
  status          Check DevPod status
  install         Run bun install in DevPod
  start           Start the dev server
  stop            Stop the dev server
  restart         Restart the dev server
  run <file>      Run a script/migration with bun
  logs [-f]       View logs (use -f to follow)
  sync            Perform one-time file sync
  watch           Sync files and watch for changes
  dev             Full dev workflow (sync + install + start + watch)
  prod            Build and run production server (npm run build && npm run start)

Options:
  -n, --namespace <ns>       K8s namespace (default: default)
  -c, --control-port <port>  Control port (default: derived from pod name)
  -a, --app-port <mapping>   App port mapping. Can be specified multiple times.
                             Format: local:remote or just port (for same local/remote)
                             Default: derived from pod name -> 3000
  -p, --path <path>          Local project path (default: current directory)

Examples:
  devpod dev my-app
  devpod dev my-app -n production
  devpod dev my-app -c 9100 -a 3100:3000
  devpod dev my-app -a 3100:3000 -a 4100:4000   # Multiple ports (frontend + backend)
  devpod run my-app scripts/migrate.ts
  devpod logs my-app -f
  devpod sync my-app -p /path/to/project
`)
}

async function main() {
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		showHelp()
		process.exit(0)
	}

	const appPortsStr = config.appPorts.map(p => p.local === p.remote ? `${p.local}` : `${p.local}:${p.remote}`).join(', ')
	console.log(`DevPod: ${config.podName} (control: ${config.controlPort}, app: ${appPortsStr})`)

	const connected = await client.setupPortForwarding()
	if (!connected) {
		console.error('Failed to establish connection to DevPod')
		process.exit(1)
	}

	process.on('SIGINT', async () => {
		console.log('\nShutting down...')
		await client.cleanup()
		process.exit(0)
	})

	process.on('SIGTERM', async () => {
		await client.cleanup()
		process.exit(0)
	})

	switch (command) {
		case 'status':
			await client.status()
			await client.cleanup()
			break

		case 'install':
			await client.install()
			await client.cleanup()
			break

		case 'start':
			await client.start()
			await client.cleanup()
			break

		case 'stop':
			await client.stop()
			await client.cleanup()
			break

		case 'restart':
			await client.restart()
			await client.cleanup()
			break

		case 'run':
			if (!parsed.extra[0]) {
				console.error('Usage: devpod run <podname> <filename>')
				await client.cleanup()
				process.exit(1)
			}
			await client.run(parsed.extra[0])
			await client.cleanup()
			break

		case 'logs':
			if (parsed.extra.includes('--follow') || parsed.extra.includes('-f')) {
				await client.streamLogs()
			} else {
				await client.logs()
				await client.cleanup()
			}
			break

		case 'sync':
			await client.initialSync()
			await client.cleanup()
			break

		case 'watch':
			await client.initialSync()
			await client.startWatch()
			break

		case 'dev':
			// Full development workflow
			await client.initialSync()
			await client.install()
			await client.start()
			console.log('\n========================================')
			console.log('Dev server is running!')
			for (const port of config.appPorts) {
				console.log(`App available at: http://localhost:${port.local} (-> pod:${port.remote})`)
			}
			console.log('========================================\n')
			console.log('File watching is active. Changes will sync automatically.')
			console.log('Press Ctrl+C to stop.\n')
			await client.startWatch(true)  // Enable log streaming
			break

		case 'prod':
			await client.initialSync()
			await client.install()
			await client.prod()
			console.log('\n========================================')
			console.log('Production server is running!')
			for (const port of config.appPorts) {
				console.log(`App available at: http://localhost:${port.local} (-> pod:${port.remote})`)
			}
			console.log('========================================\n')
			console.log('Press Ctrl+C to stop.\n')
			await client.startWatch(true)  // Enable log streaming
			break

		default:
			console.error(`Unknown command: ${command}`)
			showHelp()
			await client.cleanup()
			process.exit(1)
	}
}

main().catch(async (error) => {
	console.error('Error:', error)
	await client.cleanup()
	process.exit(1)
})
