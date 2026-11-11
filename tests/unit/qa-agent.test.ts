import { describe, expect, it } from 'vitest'
import { QaAgent } from '../../src/node/agent/qa-agent'
import { ModelRuntime } from '../../src/node/model/runtime'
import type { StoredModelSettings } from '../../src/node/model/settings'
import type { AgentStreamEvent, Drawing, KbHit } from '../../src/shared/protocol'

function fixture(): Drawing {
  return {
    path: 'C:/samples/simple.dxf',
    name: 'simple.dxf',
    layers: [
      { name: '0', color: 7, entityCount: 2 },
      { name: 'WALLS', color: 1, entityCount: 2 },
      { name: 'TEXT', color: 3, entityCount: 1 }
    ],
    entities: [
      { kind: 'line', handle: 'A1', layer: '0', color: 256, start: [0, 0], end: [10, 0] },
      { kind: 'line', handle: 'A2', layer: '0', color: 256, start: [10, 0], end: [10, 5] },
      {
        kind: 'polyline',
        handle: 'B1',
        layer: 'WALLS',
        color: 1,
        points: [
          [0, 0],
          [10, 0],
          [10, 5],
          [0, 5]
        ],
        closed: true
      },
      { kind: 'circle', handle: 'B2', layer: 'WALLS', color: 1, center: [5, 2.5], radius: 1.5 },
      {
        kind: 'text',
        handle: 'C1',
        layer: 'TEXT',
        color: 3,
        insert: [1, 1],
        text: '排水沟 600×600',
        height: 2.5,
        rotation: 0
      }
    ],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    unsupported: {}
  }
}

function fakeSetup(drawing: Drawing | null = fixture()): {
  agent: QaAgent
  events: AgentStreamEvent[]
  run: (prompt: string) => Promise<{ text: string; aborted: boolean; error?: string }>
} {
  const settings: StoredModelSettings = {
    provider: 'deepseek',
    model: 'deepseek-flash',
    fakeMode: true,
    apiKey: null
  }
  const models = new ModelRuntime(() => settings)
  const agent = new QaAgent({
    models,
    getSettings: () => settings,
    getDrawing: () => drawing
  })
  const events: AgentStreamEvent[] = []
  return {
    agent,
    events,
    run: (prompt) =>
      agent.ask({ requestId: 'req-1', prompt }, (event) => events.push(event))
  }
}

describe('QaAgent', () => {
  it('calls the drawing summary tool and answers with counts from the tool result', async () => {
    const { events, run } = fakeSetup()

    const result = await run('这张图有多少个实体？')

    const toolStart = events.find((event) => event.type === 'tool_start')
    expect(toolStart).toMatchObject({ type: 'tool_start', name: 'drawing_summary' })
    expect(events.some((event) => event.type === 'tool_end' && event.ok)).toBe(true)
    expect(result.text).toContain('5 个实体')
    expect(result.text).toContain('3 个图层')
    expect(result.aborted).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', aborted: false })
  })

  it('streams text deltas that add up to the final answer', async () => {
    const { events, run } = fakeSetup()

    const result = await run('这张图有哪些图层？')

    const streamed = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.type === 'text_delta' ? event.delta : ''))
      .join('')
    expect(streamed.length).toBeGreaterThan(0)
    expect(result.text).toBe(streamed)
  })

  it('uses the text search tool for questions about drawing text', async () => {
    const { events, run } = fakeSetup()

    const result = await run('图里有哪些文字？')

    const toolStart = events.find((event) => event.type === 'tool_start')
    expect(toolStart).toMatchObject({ type: 'tool_start', name: 'search_entities' })
    expect(result.text).toContain('排水沟 600×600')
    expect(result.text).toContain('#C1')
    expect(events.at(-1)).toMatchObject({
      type: 'run_end',
      references: [{ handle: 'C1', exists: true, kind: 'text', layer: 'TEXT' }]
    })
  })

  it('answers questions about a named layer from the entity search result', async () => {
    const { events, run } = fakeSetup()

    const result = await run('WALLS 图层里有什么？')

    const toolStart = events.find((event) => event.type === 'tool_start')
    expect(toolStart).toMatchObject({
      type: 'tool_start',
      name: 'search_entities',
      args: { layer: 'WALLS' }
    })
    expect(result.text).toContain('图层「WALLS」共有 2 个实体')
    expect(result.text).toContain('#B1')
    expect(result.text).toContain('圆 #B2')
    expect(events.at(-1)).toMatchObject({
      type: 'run_end',
      references: [
        { handle: 'B1', exists: true, layer: 'WALLS' },
        { handle: 'B2', exists: true, layer: 'WALLS' }
      ]
    })
  })

  it('states that no drawing is loaded instead of inventing content', async () => {
    const { events, run } = fakeSetup(null)

    const result = await run('这张图有多少个实体？')

    expect(events.some((event) => event.type === 'tool_start')).toBe(false)
    expect(result.text).toContain('没有打开图纸')
  })

  it('refuses to run in real mode without an API key', async () => {
    const settings: StoredModelSettings = {
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: false,
      apiKey: null
    }
    const agent = new QaAgent({
      models: new ModelRuntime(() => settings),
      getSettings: () => settings,
      getDrawing: () => fixture()
    })

    await expect(
      agent.ask({ requestId: 'req-1', prompt: '你好' }, () => undefined)
    ).rejects.toThrow('API Key')
  })

  it('stops a running answer when the user aborts', async () => {
    const { agent } = fakeSetup()
    let firstDelta: () => void = () => undefined
    const sawDelta = new Promise<void>((resolve) => {
      firstDelta = resolve
    })

    const running = agent.ask({ requestId: 'req-abort', prompt: '这张图有多少个实体？' }, (event) => {
      if (event.type === 'text_delta') {
        firstDelta()
      }
    })

    await sawDelta
    expect(agent.abort()).toBe(true)
    const result = await running
    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('reports that there is nothing to abort when idle', () => {
    const { agent } = fakeSetup()

    expect(agent.abort()).toBe(false)
  })

  it('routes specification questions to the knowledge sub-agent and keeps its sources', async () => {
    const hit: KbHit = {
      docId: 'doc-notes',
      docName: 'notes.dxf',
      text: '排水沟净宽 600x600，壁厚 100mm',
      location: { handle: 'A1F' },
      score: 0.9
    }
    const settings: StoredModelSettings = {
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: true,
      apiKey: null
    }
    const questions: string[] = []
    const agent = new QaAgent({
      models: new ModelRuntime(() => settings),
      getSettings: () => settings,
      getDrawing: () => fixture(),
      knowledge: async (question) => {
        questions.push(question)
        return {
          answer: `知识库检索到相关条款：${hit.text}（出处：${hit.docName}·句柄 #A1F）。`,
          sources: [hit]
        }
      }
    })
    const events: AgentStreamEvent[] = []

    const result = await agent.ask(
      { requestId: 'req-kb', prompt: '排水沟净宽有哪些规范要求？' },
      (event) => events.push(event)
    )

    expect(questions).toEqual(['排水沟净宽有哪些规范要求？'])
    expect(events.find((event) => event.type === 'tool_start')).toMatchObject({
      type: 'tool_start',
      name: 'ask_knowledge'
    })
    expect(result.text).toContain('知识库检索到相关条款')
    expect(events.at(-1)).toMatchObject({ type: 'run_end', sources: [hit] })
  })

  it('keeps answering when the knowledge sub-agent fails and reports the failure', async () => {
    const settings: StoredModelSettings = {
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: true,
      apiKey: null
    }
    const agent = new QaAgent({
      models: new ModelRuntime(() => settings),
      getSettings: () => settings,
      getDrawing: () => fixture(),
      knowledge: async () => {
        throw new Error('知识库子 Agent 超时')
      }
    })
    const events: AgentStreamEvent[] = []

    const result = await agent.ask(
      { requestId: 'req-kb-fail', prompt: '排水沟净宽有哪些规范要求？' },
      (event) => events.push(event)
    )

    expect(result.text).toContain('调用失败')
    const end = events.at(-1)
    expect(end).toMatchObject({ type: 'run_end', aborted: false })
    expect((end as { sources?: unknown }).sources).toBeUndefined()
  })
})
