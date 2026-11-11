import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DesignParameterSchema,
  KbHitSchema,
  ValidationReportSchema
} from '../../shared/protocol'
import type {
  DesignParameter,
  EntityReference,
  GenerationRecordView,
  HistoryMessage,
  HistorySessionSummary,
  HistorySessionView,
  KbHit,
  ValidationReport
} from '../../shared/protocol'

interface SessionRow {
  id: string
  title: string
  drawing_path: string | null
  drawing_name: string | null
  created_at: number
  updated_at: number
  message_count: number
  generation_count: number
}

interface MessageRow {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources_json: string | null
  references_json: string | null
  error: string | null
  created_at: number
}

interface GenerationRow {
  id: string
  parameters_json: string
  validation_json: string | null
  file_path: string
  created_at: number
}

export interface HistoryStoreOptions {
  now?: () => number
}

export interface CreateSessionInput {
  title: string
  drawingPath?: string | null
  drawingName?: string | null
}

export interface AppendMessageInput {
  role: 'user' | 'assistant'
  text: string
  sources?: KbHit[]
  references?: EntityReference[]
  error?: string
}

export interface AddGenerationInput {
  parameters: DesignParameter[]
  validation?: ValidationReport | null
  filePath: string
}

export class HistoryStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(filePath: string, options: HistoryStoreOptions = {}) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.now = options.now ?? Date.now
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  createSession(input: CreateSessionInput): HistorySessionSummary {
    const id = randomUUID()
    const now = this.now()
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, drawing_path, drawing_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.title, input.drawingPath ?? null, input.drawingName ?? null, now, now)
    return this.summary(id) as HistorySessionSummary
  }

  listSessions(): HistorySessionSummary[] {
    const rows = this.db
      .prepare(`${sessionSelect()} ORDER BY s.updated_at DESC, s.rowid DESC`)
      .all() as unknown as SessionRow[]
    return rows.map(toSummary)
  }

  getSession(sessionId: string): HistorySessionView | null {
    const summary = this.summary(sessionId)
    if (!summary) {
      return null
    }
    const messages = this.db
      .prepare(
        'SELECT id, role, text, sources_json, references_json, error, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(sessionId) as unknown as MessageRow[]
    const generations = this.db
      .prepare(
        'SELECT id, parameters_json, validation_json, file_path, created_at FROM generations WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(sessionId) as unknown as GenerationRow[]

    return {
      ...summary,
      messages: messages.map(toMessage),
      generations: generations.map(toGeneration)
    }
  }

  appendMessage(sessionId: string, input: AppendMessageInput): HistoryMessage | null {
    if (!this.exists(sessionId)) {
      return null
    }
    const id = randomUUID()
    const createdAt = this.now()
    this.db
      .prepare(
        'INSERT INTO messages (id, session_id, role, text, sources_json, references_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        sessionId,
        input.role,
        input.text,
        input.sources?.length ? JSON.stringify(input.sources) : null,
        input.references?.length ? JSON.stringify(input.references) : null,
        input.error ?? null,
        createdAt
      )
    this.touch(sessionId)
    return toMessage({
      id,
      role: input.role,
      text: input.text,
      sources_json: input.sources?.length ? JSON.stringify(input.sources) : null,
      references_json: input.references?.length ? JSON.stringify(input.references) : null,
      error: input.error ?? null,
      created_at: createdAt
    })
  }

  updateDrawing(
    sessionId: string,
    drawing: { path: string; name: string } | null
  ): void {
    if (!this.exists(sessionId)) {
      return
    }
    this.db
      .prepare('UPDATE sessions SET drawing_path = ?, drawing_name = ?, updated_at = ? WHERE id = ?')
      .run(drawing?.path ?? null, drawing?.name ?? null, this.now(), sessionId)
  }

  addGeneration(
    sessionId: string,
    input: AddGenerationInput
  ): GenerationRecordView | null {
    if (!this.exists(sessionId)) {
      return null
    }
    const id = randomUUID()
    const createdAt = this.now()
    this.db
      .prepare(
        'INSERT INTO generations (id, session_id, parameters_json, validation_json, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        sessionId,
        JSON.stringify(input.parameters),
        input.validation ? JSON.stringify(input.validation) : null,
        input.filePath,
        createdAt
      )
    this.touch(sessionId)
    return toGeneration({
      id,
      parameters_json: JSON.stringify(input.parameters),
      validation_json: input.validation ? JSON.stringify(input.validation) : null,
      file_path: input.filePath,
      created_at: createdAt
    })
  }

  deleteSession(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    if (Number(result.changes) > 0 && this.getLastSession() === sessionId) {
      this.clearLastSession()
    }
    return Number(result.changes) > 0
  }

  setLastSession(sessionId: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('last_session', sessionId)
  }

  getLastSession(): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_session'")
      .get() as { value?: string } | undefined
    return row?.value ?? null
  }

  clearLastSession(): void {
    this.db.prepare("DELETE FROM meta WHERE key = 'last_session'").run()
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.db.close()
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined
    if ((row?.user_version ?? 0) >= 2) {
      return
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        drawing_path TEXT,
        drawing_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        sources_json TEXT,
        references_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parameters_json TEXT NOT NULL,
        validation_json TEXT,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS generations_session ON generations(session_id, created_at);
      PRAGMA user_version = 2;
    `)
  }

  private exists(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM sessions WHERE id = ?').get(sessionId))
  }

  private touch(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(this.now(), sessionId)
  }

  private summary(sessionId: string): HistorySessionSummary | null {
    const row = this.db
      .prepare(`${sessionSelect()} WHERE s.id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined
    return row ? toSummary(row) : null
  }
}

function sessionSelect(): string {
  return `
    SELECT s.id, s.title, s.drawing_path, s.drawing_name, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM generations g WHERE g.session_id = s.id) AS generation_count
    FROM sessions s
  `
}

function toSummary(row: SessionRow): HistorySessionSummary {
  return {
    id: row.id,
    title: row.title,
    drawingPath: row.drawing_path,
    drawingName: row.drawing_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count),
    generationCount: Number(row.generation_count)
  }
}

function toMessage(row: MessageRow): HistoryMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    ...(parseSources(row.sources_json) ? { sources: parseSources(row.sources_json) } : {}),
    ...(parseReferences(row.references_json)
      ? { references: parseReferences(row.references_json) }
      : {}),
    ...(row.error ? { error: row.error } : {})
  }
}

function toGeneration(row: GenerationRow): GenerationRecordView {
  return {
    id: row.id,
    createdAt: row.created_at,
    filePath: row.file_path,
    fileExists: existsSync(row.file_path),
    parameters: parseParameters(row.parameters_json),
    validation: parseValidation(row.validation_json)
  }
}

function parseSources(raw: string | null): KbHit[] | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const parsed = KbHitSchema.array().safeParse(JSON.parse(raw))
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function parseReferences(raw: string | null): EntityReference[] | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as EntityReference[])
      : undefined
  } catch {
    return undefined
  }
}

function parseParameters(raw: string): DesignParameter[] {
  try {
    const parsed = DesignParameterSchema.array().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function parseValidation(raw: string | null): ValidationReport | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = ValidationReportSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
