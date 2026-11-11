import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync
} from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

interface LogRecord {
  time: number
  level: LogLevel
  scope: string
  message: string
  detail?: string
}

export interface AppLoggerOptions {
  filePath: string
  maxBytes?: number
  now?: () => number
}

const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{6,}/g

export class AppLogger {
  private readonly filePath: string
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(options: AppLoggerOptions) {
    this.filePath = options.filePath
    this.maxBytes = options.maxBytes ?? 512 * 1024
    this.now = options.now ?? Date.now
  }

  getFilePath(): string {
    return this.filePath
  }

  write(level: LogLevel, scope: string, message: string, detail?: unknown): void {
    const record: LogRecord = {
      time: this.now(),
      level,
      scope,
      message: sanitize(message)
    }
    const detailText = formatDetail(detail)
    if (detailText) {
      record.detail = detailText
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const line = `${JSON.stringify(record)}\n`
      const size = existsSync(this.filePath) ? statSync(this.filePath).size : 0
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        renameSync(this.filePath, `${this.filePath}.1`)
      }
      appendFileSync(this.filePath, line, 'utf8')
    } catch {
      // 日志失败不应影响主流程
    }
  }

  readTail(limit = 200): string[] {
    if (!existsSync(this.filePath)) {
      return []
    }
    let text = ''
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }
    const lines: string[] = []
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) {
        continue
      }
      try {
        const record = JSON.parse(raw) as LogRecord
        if (
          typeof record.time !== 'number' ||
          typeof record.level !== 'string' ||
          typeof record.scope !== 'string' ||
          typeof record.message !== 'string'
        ) {
          continue
        }
        lines.push(
          `${new Date(record.time).toISOString()} [${record.level}] ${record.scope} ${record.message}${
            record.detail ? ` ${record.detail}` : ''
          }`
        )
      } catch {
        continue
      }
    }
    return lines.slice(-Math.max(1, limit))
  }
}

function formatDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) {
    return undefined
  }
  if (detail instanceof Error) {
    return sanitize(detail.message)
  }
  if (typeof detail === 'string') {
    return sanitize(detail)
  }
  try {
    return sanitize(JSON.stringify(detail))
  } catch {
    return sanitize(String(detail))
  }
}

function sanitize(text: string): string {
  return text.replace(SECRET_PATTERN, 'sk-***')
}
