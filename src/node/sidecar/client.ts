import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import {
  DrawingEntitySchema,
  DrawingSchema,
  HealthResultSchema,
  KbDocumentSchema,
  KbHitSchema,
  SidecarResponseSchema,
  type Drawing,
  type DrawingEntity,
  type HealthResult,
  type KbDocument,
  type KbHit,
  type KbRecognition,
  type SidecarStatus
} from '../../shared/protocol'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const PARSE_REQUEST_TIMEOUT_MS = 120_000
const SUMMARY_REQUEST_TIMEOUT_MS = 180_000
const LAYER_REQUEST_TIMEOUT_MS = 180_000

export interface SidecarClientOptions {
  projectDir?: string
  command?: string
  args?: string[]
  requestTimeoutMs?: number
}

export class SidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, PendingRequest>()
  private status: SidecarStatus = { state: 'stopped' }
  private listeners = new Set<(status: SidecarStatus) => void>()
  private stderrTail: string[] = []
  private startPromise: Promise<void> | null = null
  private stopping = false

  constructor(private readonly options: SidecarClientOptions = {}) {}

  getStatus(): SidecarStatus {
    return this.status
  }

  getPid(): number | undefined {
    return this.child?.pid
  }

  isBusy(): boolean {
    return this.pending.size > 0
  }

  onStatusChange(listener: (status: SidecarStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.status.state === 'ready') {
      return
    }
    if (!this.startPromise) {
      const promise = this.doStart().finally(() => {
        this.startPromise = null
      })
      this.startPromise = promise
      return promise
    }
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    this.rejectPending(new Error('sidecar stopped'))

    if (child) {
      child.stdin.end()
      child.kill()
      await Promise.race([
        once(child, 'exit').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ])
    }

    this.setStatus({ state: 'stopped' })
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async health(): Promise<HealthResult> {
    const result = await this.request('health')
    return HealthResultSchema.parse(result)
  }

  async parseDrawing(path: string): Promise<Drawing> {
    const result = await this.request('parse_dxf', { path }, PARSE_REQUEST_TIMEOUT_MS)
    return DrawingSchema.parse(result)
  }

  async openDrawing(path: string): Promise<Drawing> {
    const result = await this.request('open_dxf', { path }, SUMMARY_REQUEST_TIMEOUT_MS)
    return DrawingSchema.parse(result)
  }

  async layerEntities(path: string, layer: string): Promise<DrawingEntity[]> {
    const result = (await this.request(
      'layer_entities',
      { path, layer },
      LAYER_REQUEST_TIMEOUT_MS
    )) as { entities?: unknown }
    return DrawingEntitySchema.array().parse(result.entities ?? [])
  }

  async closeDrawing(): Promise<void> {
    try {
      await this.request('close_dxf')
    } catch {
      // 关闭缓存失败不影响后续打开图纸
    }
  }

  async kbImport(
    root: string,
    path: string,
    recognition?: KbRecognition
  ): Promise<KbDocument> {
    const result = await this.request('kb_import', {
      root,
      path,
      ...(recognition ? { recognition } : {})
    })
    return KbDocumentSchema.parse(result)
  }

  async kbList(root: string): Promise<KbDocument[]> {
    const result = (await this.request('kb_list', { root })) as { documents?: unknown }
    return KbDocumentSchema.array().parse(result.documents ?? [])
  }

  async kbDelete(root: string, docId: string): Promise<boolean> {
    const result = (await this.request('kb_delete', { root, docId })) as { deleted?: unknown }
    return result.deleted === true
  }

  async kbRebuild(
    root: string
  ): Promise<{ documents: number; failed: number; chunks: number }> {
    return (await this.request('kb_rebuild', { root })) as {
      documents: number
      failed: number
      chunks: number
    }
  }

  async kbSearch(root: string, query: string, limit = 5): Promise<KbHit[]> {
    const result = (await this.request('kb_search', { root, query, limit })) as { hits?: unknown }
    return KbHitSchema.array().parse(result.hits ?? [])
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const child = this.child
    if (!child) {
      throw new Error('sidecar is not running')
    }

    const id = randomUUID()

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar request timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      const line = `${JSON.stringify({ id, method, params })}\n`
      child.stdin.write(line, (error) => {
        if (!error) {
          return
        }
        const pending = this.pending.get(id)
        if (pending) {
          this.pending.delete(id)
          clearTimeout(pending.timer)
          reject(error)
        }
      })
    })
  }

  private async doStart(): Promise<void> {
    this.stopping = false
    this.setStatus({ state: 'starting' })

    const { command, args, cwd } = this.resolveCommand()
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    this.child = child

    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) {
          this.stderrTail = [...this.stderrTail.slice(-19), line]
        }
      }
    })
    child.on('exit', (code) => this.handleExit(code))
    child.on('error', (error) => {
      this.rejectPending(error)
      if (!this.stopping) {
        this.setStatus({ state: 'error', detail: error.message })
      }
    })

    try {
      await once(child, 'spawn')
      const health = await this.health()
      this.setStatus({ state: 'ready', health })
    } catch (error) {
      child.kill()
      this.child = null
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
      this.setStatus({ state: 'error', detail: this.describe(error) })
      throw error
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      const error = new Error('sidecar returned invalid JSON')
      this.rejectPending(error)
      this.setStatus({ state: 'error', detail: error.message })
      return
    }

    const parsed = SidecarResponseSchema.safeParse(raw)
    if (!parsed.success) {
      const error = new Error('sidecar response failed schema validation')
      this.rejectPending(error)
      this.setStatus({ state: 'error', detail: error.message })
      return
    }

    const response = parsed.data
    if (response.id === null) {
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }

    this.pending.delete(response.id)
    clearTimeout(pending.timer)

    if (response.ok) {
      pending.resolve(response.result)
    } else {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
    }
  }

  private handleExit(code: number | null): void {
    this.child = null
    const suffix = this.stderrTail.at(-1)
    this.rejectPending(
      new Error(`sidecar exited with code ${code}${suffix ? `: ${suffix}` : ''}`)
    )
    if (!this.stopping) {
      this.setStatus({ state: 'error', detail: suffix ?? `exited with code ${code}` })
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private resolveCommand(): { command: string; args: string[]; cwd: string } {
    const cwd = path.resolve(this.options.projectDir ?? path.join(process.cwd(), 'python'))

    if (this.options.command) {
      return { command: this.options.command, args: this.options.args ?? [], cwd }
    }

    const venvPython =
      process.platform === 'win32'
        ? path.join(cwd, '.venv', 'Scripts', 'python.exe')
        : path.join(cwd, '.venv', 'bin', 'python')

    if (existsSync(venvPython)) {
      return { command: venvPython, args: ['-m', 'cad_service'], cwd }
    }

    return { command: 'uv', args: ['run', '--quiet', 'python', '-m', 'cad_service'], cwd }
  }

  private setStatus(status: SidecarStatus): void {
    this.status = status
    for (const listener of this.listeners) {
      listener(status)
    }
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  }
}
