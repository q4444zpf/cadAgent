import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../../src/node/history/store'
import type { DesignParameter, EntityReference, KbHit } from '../../src/shared/protocol'

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
})
