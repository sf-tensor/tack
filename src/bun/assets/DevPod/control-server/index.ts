import { spawn, type ChildProcess } from 'child_process'
import { mkdir, writeFile, rm, readFile, stat } from 'fs/promises'
import { existsSync, watch } from 'fs'
import { join } from 'path'

interface ProcessState {
	process?: ChildProcess
	status: 'stopped' | 'starting' | 'running' | 'error'
	lastError?: string
	logs: string[]
}

type RunStreamEvent =
	| { type: 'log'; log: string; timestamp: number }
	| { type: 'end'; success: boolean; message: string; exitCode: number | null }

const APP_DIR = '/app'
const MAX_LOGS = 1000
const processState: ProcessState = {
	status: 'stopped',
	logs: []
}

const logSubscribers = new Set<ReadableStreamDefaultController>()

setInterval(() => {
	for (const controller of logSubscribers) {
		try {
			controller.enqueue(`: heartbeat\n\n`)
		} catch {
			logSubscribers.delete(controller)
		}
	}
}, 15000)

let lastPackageJsonHash = ''

function addLog(line: string) {
	const timestamp = new Date().toISOString()
	const logLine = `[${timestamp}] ${line}`
	processState.logs.push(logLine)
	if (processState.logs.length > MAX_LOGS) {
		processState.logs.shift()
	}

	for (const controller of logSubscribers) {
		try {
			controller.enqueue(`data: ${JSON.stringify({ log: logLine, timestamp: Date.now() })}\n\n`)
		} catch {
			logSubscribers.delete(controller)
		}
	}
}

function serializeSseEvent(event: RunStreamEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`
}

function createLineBuffer(onLine: (line: string) => void) {
	let buffer = ''

	return {
		push(chunk: Buffer | string) {
			const lines = `${buffer}${chunk.toString()}`.split(/\r?\n/)
			buffer = lines.pop() || ''

			for (const line of lines) {
				if (line.trim()) onLine(line)
			}
		},
		flush() {
			if (buffer.trim()) onLine(buffer)
			buffer = ''
		}
	}
}

async function startDevServer(task: string = 'dev'): Promise<{ success: boolean; message: string }> {
	if (processState.process) {
		return { success: false, message: 'Dev server already running' }
	}

	processState.status = 'starting'
	addLog(`[DevPod] Starting dev server with bun --bun run ${task}...`)

	try {
		const proc = spawn('bun', ['--bun', 'run', task], {
			cwd: APP_DIR,
			env: { ...process.env, NODE_ENV: 'development' },
			shell: true
		})

		proc.stdout?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[stdout] ${line}`))
		})

		proc.stderr?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[stderr] ${line}`))
		})

		proc.on('exit', (code) => {
			addLog(`[DevPod] Process exited with code ${code}`)
			processState.status = code === 0 ? 'stopped' : 'error'
			processState.process = undefined
		})

		proc.on('error', (err) => {
			addLog(`[DevPod] Process error: ${err.message}`)
			processState.status = 'error'
			processState.lastError = err.message
			processState.process = undefined
		})

		processState.process = proc
		processState.status = 'running'

		return { success: true, message: `Dev server started with task ${task}` }
	} catch (error) {
		processState.status = 'error'
		processState.lastError = error instanceof Error ? error.message : String(error)
		addLog(`[DevPod] Error: ${processState.lastError}`)
		return { success: false, message: processState.lastError }
	}
}

function streamScript(filename: string): Response {
	let proc: ChildProcess | undefined

	const stream = new ReadableStream({
		start(controller) {
			addLog(`[DevPod] Running bun run ${filename}...`)

			try {
				proc = spawn('bun', ['run', filename], {
					cwd: APP_DIR,
					env: { ...process.env },
					shell: true
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				addLog(`[DevPod] Script error: ${message}`)
				controller.enqueue(serializeSseEvent({
					type: 'end',
					success: false,
					message,
					exitCode: null
				}))
				controller.close()
				return
			}

			const stdoutLines = createLineBuffer((line) => {
				const log = `[run] ${line}`
				addLog(log)
				controller.enqueue(serializeSseEvent({
					type: 'log',
					log,
					timestamp: Date.now()
				}))
			})

			const stderrLines = createLineBuffer((line) => {
				const log = `[run:err] ${line}`
				addLog(log)
				controller.enqueue(serializeSseEvent({
					type: 'log',
					log,
					timestamp: Date.now()
				}))
			})

			proc.stdout?.on('data', (data) => stdoutLines.push(data))
			proc.stderr?.on('data', (data) => stderrLines.push(data))

			proc.on('exit', (code) => {
				stdoutLines.flush()
				stderrLines.flush()

				const success = code === 0
				const message = success
					? 'Script completed successfully'
					: `Script failed with code ${code ?? 'unknown'}`
				addLog(success
					? `[DevPod] Script ${filename} completed successfully`
					: `[DevPod] Script ${filename} failed with code ${code ?? 'unknown'}`)

				controller.enqueue(serializeSseEvent({
					type: 'end',
					success,
					message,
					exitCode: code
				}))
				controller.close()
			})

			proc.on('error', (err) => {
				addLog(`[DevPod] Script error: ${err.message}`)
				controller.enqueue(serializeSseEvent({
					type: 'end',
					success: false,
					message: err.message,
					exitCode: null
				}))
				controller.close()
			})
		},
		cancel() {
			if (proc && !proc.killed) {
				proc.kill('SIGTERM')
			}
		}
	})

	return new Response(stream, {
		headers: {
			...corsHeaders,
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	})
}

async function stopDevServer(): Promise<{ success: boolean; message: string }> {
	if (!processState.process) {
		return { success: false, message: 'Dev server not running' }
	}

	addLog('[DevPod] Stopping dev server...')

	return new Promise((resolve) => {
		const proc = processState.process!
		let killed = false

		const forceKillTimer = setTimeout(() => {
			if (!killed && processState.process) {
				addLog('[DevPod] Force killing process...')
				processState.process.kill('SIGKILL')
			}
		}, 5000)

		proc.once('exit', () => {
			killed = true
			clearTimeout(forceKillTimer)
			processState.process = undefined
			processState.status = 'stopped'
			addLog('[DevPod] Dev server stopped')
			resolve({ success: true, message: 'Dev server stopped' })
		})

		proc.kill('SIGTERM')
	})
}

async function startProdServer(): Promise<{ success: boolean; message: string }> {
	if (processState.process) {
		await stopDevServer()
		await new Promise(resolve => setTimeout(resolve, 1000))
	}

	processState.status = 'starting'
	addLog('[DevPod] Building for production...')

	const buildResult = await new Promise<{ success: boolean; message: string }>((resolve) => {
		const buildProc = spawn('bun', ['--bun', 'run', 'build'], {
			cwd: APP_DIR,
			env: { ...process.env, NODE_ENV: 'production' },
			shell: true
		})

		buildProc.stdout?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[build] ${line}`))
		})

		buildProc.stderr?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[build:err] ${line}`))
		})

		buildProc.on('exit', (code) => {
			if (code === 0) {
				addLog('[DevPod] Build complete')
				resolve({ success: true, message: 'Build complete' })
			} else {
				addLog(`[DevPod] Build failed with code ${code}`)
				processState.status = 'error'
				resolve({ success: false, message: `Build failed with code ${code}` })
			}
		})

		buildProc.on('error', (err) => {
			addLog(`[DevPod] Build error: ${err.message}`)
			processState.status = 'error'
			resolve({ success: false, message: err.message })
		})
	})

	if (!buildResult.success) {
		return buildResult
	}

	addLog('[DevPod] Starting production server...')

	try {
		const proc = spawn('bun', ['--bun', 'run', 'start'], {
			cwd: APP_DIR,
			env: { ...process.env, NODE_ENV: 'production' },
			shell: true
		})

		proc.stdout?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[stdout] ${line}`))
		})

		proc.stderr?.on('data', (data) => {
			const lines = data.toString().split('\n').filter((l: string) => l.trim())
			lines.forEach((line: string) => addLog(`[stderr] ${line}`))
		})

		proc.on('exit', (code) => {
			addLog(`[DevPod] Process exited with code ${code}`)
			processState.status = code === 0 ? 'stopped' : 'error'
			processState.process = undefined
		})

		proc.on('error', (err) => {
			addLog(`[DevPod] Process error: ${err.message}`)
			processState.status = 'error'
			processState.lastError = err.message
			processState.process = undefined
		})

		processState.process = proc
		processState.status = 'running'

		return { success: true, message: 'Production server started' }
	} catch (error) {
		processState.status = 'error'
		processState.lastError = error instanceof Error ? error.message : String(error)
		addLog(`[DevPod] Error: ${processState.lastError}`)
		return { success: false, message: processState.lastError }
	}
}

async function runInstall(): Promise<{ success: boolean; message: string }> {
	addLog('[DevPod] Running npm install...')

	try {
		const proc = spawn('npm', ['install'], {
			cwd: APP_DIR,
			shell: true
		})

		return new Promise<{ success: boolean; message: string }>((resolve) => {
			proc.stdout?.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim())
				lines.forEach((line: string) => addLog(`[install] ${line}`))
			})
			proc.stderr?.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim())
				lines.forEach((line: string) => addLog(`[install:err] ${line}`))
			})

			proc.on('exit', (code) => {
				if (code === 0) {
					addLog('[DevPod] Install complete')
					resolve({ success: true, message: 'Install complete' })
				} else {
					addLog(`[DevPod] Install failed with code ${code}`)
					resolve({ success: false, message: `Install failed with code ${code}` })
				}
			})

			proc.on('error', (err) => {
				addLog(`[DevPod] Install error: ${err.message}`)
				resolve({ success: false, message: err.message })
			})
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		addLog(`[DevPod] Install error: ${message}`)
		return { success: false, message }
	}
}

async function runScript(filename: string): Promise<{ success: boolean; message: string; output: string }> {
	addLog(`[DevPod] Running bun run ${filename}...`)
	let output = ''

	try {
		const proc = spawn('bun', ['run', filename], {
			cwd: APP_DIR,
			env: { ...process.env },
			shell: true
		})

		return new Promise<{ success: boolean; message: string; output: string }>((resolve) => {
			proc.stdout?.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim())
				lines.forEach((line: string) => {
					addLog(`[run] ${line}`)
					output += line + '\n'
				})
			})
			proc.stderr?.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim())
				lines.forEach((line: string) => {
					addLog(`[run:err] ${line}`)
					output += line + '\n'
				})
			})

			proc.on('exit', (code) => {
				if (code === 0) {
					addLog(`[DevPod] Script ${filename} completed successfully`)
					resolve({ success: true, message: `Script completed successfully`, output })
				} else {
					addLog(`[DevPod] Script ${filename} failed with code ${code}`)
					resolve({ success: false, message: `Script failed with code ${code}`, output })
				}
			})

			proc.on('error', (err) => {
				addLog(`[DevPod] Script error: ${err.message}`)
				resolve({ success: false, message: err.message, output })
			})
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		addLog(`[DevPod] Script error: ${message}`)
		return { success: false, message, output }
	}
}

async function hashFile(path: string): Promise<string> {
	try {
		const content = await readFile(path)
		const hasher = new Bun.CryptoHasher('sha256')
		hasher.update(content)
		return hasher.digest('hex')
	} catch {
		return ''
	}
}

async function checkPackageJsonAndInstall() {
	const packageJsonPath = join(APP_DIR, 'package.json')
	const hash = await hashFile(packageJsonPath)

	if (hash && hash !== lastPackageJsonHash) {
		if (lastPackageJsonHash !== '') {
			addLog('[DevPod] package.json changed, running auto-install...')
			await runInstall()
		}
		lastPackageJsonHash = hash
	}
}

function setupPackageJsonWatcher() {
	const packageJsonPath = join(APP_DIR, 'package.json')

	hashFile(packageJsonPath).then(hash => { lastPackageJsonHash = hash })

	try {
		watch(packageJsonPath, { persistent: false }, async (eventType) => {
			if (eventType === 'change') {
				await checkPackageJsonAndInstall()
			}
		})
		addLog('[DevPod] Watching package.json for changes')
	} catch { /* File might not exist yet, that's ok */ }
}

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
}

Bun.serve({
	port: 9000,
	idleTimeout: 0, // 2 minutes

	async fetch(req) {
		const url = new URL(req.url)

		if (req.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders })
		}

		if (url.pathname === '/health') {
			return Response.json({
				status: 'ok',
				devServer: processState.status
			}, { headers: corsHeaders })
		}

		if (url.pathname === '/status') {
			return Response.json({
				status: processState.status,
				lastError: processState.lastError,
				hasNodeModules: existsSync(join(APP_DIR, 'node_modules')),
				hasPackageJson: existsSync(join(APP_DIR, 'package.json'))
			}, { headers: corsHeaders })
		}

		if (url.pathname === '/start' && req.method === 'POST') {
			let task = 'dev'
			try {
				const rawBody = await req.text()
				if (rawBody) {
					const body = JSON.parse(rawBody) as { task?: string }
					if (body.task?.trim()) {
						task = body.task.trim()
					}
				}
			} catch {
				return Response.json({ success: false, message: 'Invalid request body' }, {
					status: 400,
					headers: corsHeaders
				})
			}

			const result = await startDevServer(task)
			return Response.json(result, { headers: corsHeaders })
		}

		// Stop dev server
		if (url.pathname === '/stop' && req.method === 'POST') {
			const result = await stopDevServer()
			return Response.json(result, { headers: corsHeaders })
		}

		if (url.pathname === '/restart' && req.method === 'POST') {
			if (processState.process) {
				await stopDevServer()
				await new Promise(resolve => setTimeout(resolve, 1000))
			}
			const result = await startDevServer()
			return Response.json(result, { headers: corsHeaders })
		}

		if (url.pathname === '/prod' && req.method === 'POST') {
			const result = await startProdServer()
			return Response.json(result, { headers: corsHeaders })
		}

		if (url.pathname === '/install' && req.method === 'POST') {
			const result = await runInstall()
			return Response.json(result, { headers: corsHeaders })
		}

		if (url.pathname === '/run' && req.method === 'POST') {
			try {
				const body = await req.json() as { filename: string }
				if (!body.filename) {
					return Response.json({ success: false, message: 'Filename required' }, {
						status: 400,
						headers: corsHeaders
					})
				}
				const result = await runScript(body.filename)
				return Response.json(result, { headers: corsHeaders })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return Response.json({ success: false, message }, {
					status: 500,
					headers: corsHeaders
				})
			}
		}

		if (url.pathname === '/run/stream' && req.method === 'POST') {
			try {
				const body = await req.json() as { filename: string }
				if (!body.filename) {
					return Response.json({ success: false, message: 'Filename required' }, {
						status: 400,
						headers: corsHeaders
					})
				}

				return streamScript(body.filename)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return Response.json({ success: false, message }, {
					status: 500,
					headers: corsHeaders
				})
			}
		}

		if (url.pathname === '/logs' && req.method === 'GET') {
			return Response.json({
				logs: processState.logs
			}, { headers: corsHeaders })
		}

		if (url.pathname === '/logs/stream' && req.method === 'GET') {
			const skipHistory = url.searchParams.get('skipHistory') === 'true'

			const stream = new ReadableStream({
				start(controller) {
					logSubscribers.add(controller)

					// Send existing logs only if not skipping history
					if (!skipHistory) {
						for (const log of processState.logs) {
							controller.enqueue(`data: ${JSON.stringify({ log, timestamp: Date.now() })}\n\n`)
						}
					}
				},
				cancel(controller) {
					logSubscribers.delete(controller)
				}
			})

			return new Response(stream, {
				headers: {
					...corsHeaders,
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive'
				}
			})
		}

		if (url.pathname === '/files' && req.method === 'POST') {
			try {
				const formData = await req.formData()
				const path = formData.get('path') as string
				const content = formData.get('content') as Blob
				const isDelete = formData.get('delete') === 'true'

				if (!path) {
					return Response.json({ success: false, message: 'Path required' }, {
						status: 400,
						headers: corsHeaders
					})
				}

				const normalizedPath = path.replace(/\.\.\//g, '').replace(/^\/+/, '')
				const fullPath = join(APP_DIR, normalizedPath)

				if (!fullPath.startsWith(APP_DIR)) {
					return Response.json({ success: false, message: 'Invalid path' }, {
						status: 400,
						headers: corsHeaders
					})
				}

				if (isDelete) {
					await rm(fullPath, { recursive: true, force: true })
					addLog(`[DevPod] Deleted: ${normalizedPath}`)
					return Response.json({ success: true, message: 'File deleted' }, { headers: corsHeaders })
				}

				const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
				await mkdir(dir, { recursive: true })

				const buffer = Buffer.from(await content.arrayBuffer())
				await writeFile(fullPath, buffer)

				if (normalizedPath === 'package.json') {
					await checkPackageJsonAndInstall()
				}

				return Response.json({ success: true, message: 'File updated' }, { headers: corsHeaders })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				addLog(`[DevPod] File operation error: ${message}`)
				return Response.json({ success: false, message }, {
					status: 500,
					headers: corsHeaders
				})
			}
		}

		if (url.pathname === '/files/batch' && req.method === 'POST') {
			try {
				const files = await req.json() as { path: string; content: string; delete?: boolean }[]
				const results: { path: string; success: boolean; error?: string }[] = []
				let packageJsonUpdated = false

				for (const file of files) {
					try {
						const normalizedPath = file.path.replace(/\.\.\//g, '').replace(/^\/+/, '')
						const fullPath = join(APP_DIR, normalizedPath)

						if (!fullPath.startsWith(APP_DIR)) {
							results.push({ path: file.path, success: false, error: 'Invalid path' })
							continue
						}

						if (file.delete) {
							await rm(fullPath, { recursive: true, force: true })
							results.push({ path: file.path, success: true })
							continue
						}

						const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
						await mkdir(dir, { recursive: true })

						const content = Buffer.from(file.content, 'base64')
						await writeFile(fullPath, content)
						results.push({ path: file.path, success: true })

						if (normalizedPath === 'package.json') {
							packageJsonUpdated = true
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error)
						results.push({ path: file.path, success: false, error: message })
					}
				}

				addLog(`[DevPod] Batch updated ${results.filter(r => r.success).length}/${files.length} files`)

				if (packageJsonUpdated) {
					await checkPackageJsonAndInstall()
				}

				return Response.json({ success: true, results }, { headers: corsHeaders })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return Response.json({ success: false, message }, {
					status: 500,
					headers: corsHeaders
				})
			}
		}

		return new Response('Not found', { status: 404, headers: corsHeaders })
	}
})

setupPackageJsonWatcher()

addLog('[DevPod] Control server started on port 9000')
console.log('[DevPod] Control server listening on port 9000')
