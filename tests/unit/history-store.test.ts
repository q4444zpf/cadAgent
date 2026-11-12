import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../../src/node/history/store'
import type {
  DesignParameter,
  EntityReference,
  FileAttachment,
  KbHit
} from '../../src/shared/protocol'

const HIT: KbHit = {
  docId: 'doc-notes',
  docName: 'notes.dxf',
  text: '排水沟净宽 600x600，壁厚 100mm',
  location: { handle: 'A1F' },
  score: 0.9
}

const REFERENCE: EntityReference = {
  handle: 'A1F',
  exists: true,
  kind: 'line',
  layer: 'DRAIN'
}

const PARAMETER: DesignParameter = {
  id: 'width',
  name: '净宽',
  value: '600',
  unit: 'mm',
  basis: 'spec.pdf·第 2 页',
  assumed: false
}

const ATTACHMENT: FileAttachment = {
  path: '图纸/a.dxf',
  name: 'a.dxf',
  kind: 'drawing',
  size: 2048
}

const dirs: string[] = []
const stores: HistoryStore[] = []

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cad-history-'))
  dirs.push(dir)
  return join(dir, 'history.db')
}

function open(path: string): HistoryStore {
  const store = new HistoryStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // 已关闭
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('HistoryStore', () => {
  it('restores sessions and messages after reopening the database', () => {
    const path = databasePath()
    let store = open(path)
    const session = store.createSession({
      title: '这张图有多少个实体？',
      drawingPath: 'F:/samples/simple.dxf',
      drawingName: 'simple.dxf'
    })
    store.appendMessage(session.id, { role: 'user', text: '这张图有多少个实体？' })
    store.appendMessage(session.id, {
      role: 'assistant',
      text: '这张图共 6 个实体。',
      sources: [HIT],
      references: [REFERENCE]
    })
    store.setLastSession(session.id)
    store.close()
    stores.splice(stores.indexOf(store), 1)

    store = open(path)
    const restored = store.getSession(session.id)

    expect(store.getLastSession()).toBe(session.id)
    expect(restored?.title).toBe('这张图有多少个实体？')
    expect(restored?.drawingName).toBe('simple.dxf')
    expect(restored?.messageCount).toBe(2)
    expect(restored?.messages.map((message) => message.text)).toEqual([
      '这张图有多少个实体？',
      '这张图共 6 个实体。'
    ])
    expect(restored?.messages[1].sources).toEqual([HIT])
    expect(restored?.messages[1].references).toEqual([REFERENCE])
  })

  it('keeps generation parameters and validation, and flags a missing file', () => {
    const store = open(databasePath())
    const session = store.createSession({ title: '生成排水沟断面' })
    const filePath = join(dirs[dirs.length - 1], 'drain.dxf')
    writeFileSync(filePath, '0\nEOF\n')

    store.addGeneration(session.id, {
      parameters: [PARAMETER],
      validation: { ok: false, issues: ['图层名称不符合规范'] },
      filePath
    })

    const first = store.getSession(session.id)?.generations[0]
    expect(first?.fileExists).toBe(true)
    expect(first?.parameters).toEqual([PARAMETER])
    expect(first?.validation).toEqual({ ok: false, issues: ['图层名称不符合规范'] })
    expect(first?.filePath).toBe(filePath)

    unlinkSync(filePath)

    const second = store.getSession(session.id)?.generations[0]
    expect(second?.fileExists).toBe(false)
    expect(second?.validation).toEqual({ ok: false, issues: ['图层名称不符合规范'] })
  })

  it('deletes a session without deleting its generated DXF files', () => {
    const store = open(databasePath())
    const session = store.createSession({ title: '生成排水沟断面' })
    const filePath = join(dirs[dirs.length - 1], 'keep.dxf')
    writeFileSync(filePath, '0\nEOF\n')
    store.addGeneration(session.id, { parameters: [PARAMETER], filePath })
    store.appendMessage(session.id, { role: 'user', text: '生成排水沟' })

    expect(store.deleteSession(session.id)).toBe(true)

    expect(store.getSession(session.id)).toBeNull()
    expect(store.listSessions()).toEqual([])
    expect(store.getLastSession()).toBeNull()
    expect(existsSync(filePath)).toBe(true)
  })

  it('lists the most recently updated sessions first with message counts', () => {
    const store = open(databasePath())
    const first = store.createSession({ title: '第一条会话' })
    const second = store.createSession({ title: '第二条会话' })
    store.appendMessage(first.id, { role: 'user', text: '旧会话的新消息' })

    const sessions = store.listSessions()

    expect(sessions.map((session) => session.id)).toEqual([first.id, second.id])
    expect(sessions[0].messageCount).toBe(1)
    expect(sessions[1].messageCount).toBe(0)
  })

  it('returns null for an unknown session', () => {
    const store = open(databasePath())

    expect(store.getSession('missing')).toBeNull()
    expect(store.deleteSession('missing')).toBe(false)
  })

  it('persists the project root and clears it on request', () => {
    const path = databasePath()
    let store = open(path)
    const session = store.createSession({
      title: '项目会话',
      projectRoot: 'F:/工程/某项目'
    })
    expect(session.projectRoot).toBe('F:/工程/某项目')

    store.updateProjectRoot(session.id, null)
    expect(store.getSession(session.id)?.projectRoot).toBeNull()

    store.updateProjectRoot(session.id, 'F:/工程/另一个项目')
    store.close()
    stores.splice(stores.indexOf(store), 1)

    store = open(path)
    expect(store.getSession(session.id)?.projectRoot).toBe('F:/工程/另一个项目')
  })

  it('persists message attachments across reopen', () => {
    const path = databasePath()
    let store = open(path)
    const session = store.createSession({ title: '附件会话' })
    store.appendMessage(session.id, {
      role: 'user',
      text: '对比说明和图纸',
      attachments: [ATTACHMENT]
    })
    store.close()
    stores.splice(stores.indexOf(store), 1)

    store = open(path)
    expect(store.getSession(session.id)?.messages[0].attachments).toEqual([ATTACHMENT])
  })

  it('upgrades a version 2 database without losing sessions', () => {
    const path = databasePath()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        drawing_path TEXT,
        drawing_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        sources_json TEXT,
        references_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE generations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parameters_json TEXT NOT NULL,
        validation_json TEXT,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO sessions (id, title, created_at, updated_at)
        VALUES ('legacy', '旧会话', 1, 1);
      INSERT INTO messages (id, session_id, role, text, created_at)
        VALUES ('m1', 'legacy', 'user', '旧消息', 2);
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const store = open(path)
    const restored = store.getSession('legacy')

    expect(restored?.title).toBe('旧会话')
    expect(restored?.projectRoot).toBeNull()
    expect(restored?.messages[0].text).toBe('旧消息')
    expect(restored?.messages[0].attachments).toBeUndefined()
  })
})
