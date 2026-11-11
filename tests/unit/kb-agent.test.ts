import { describe, expect, it } from 'vitest'
import { KbAgent } from '../../src/node/agent/kb-agent'
import { ModelRuntime } from '../../src/node/model/runtime'
import type { StoredModelSettings } from '../../src/node/model/settings'
import type { KbHit } from '../../src/shared/protocol'

const settings: StoredModelSettings = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  fakeMode: true,
  apiKey: null
}

const HIT: KbHit = {
  docId: 'doc-notes',
  docName: 'notes.dxf',
  text: '排水沟净宽 600x600，壁厚 100mm',
  location: { handle: 'A1F' },
  score: 0.9
}

function setup(
  retrieve: (query: string) => Promise<KbHit[]>
): { agent: KbAgent; queries: string[] } {
  const queries: string[] = []
  const models = new ModelRuntime(() => settings)
  const agent = new KbAgent({
    models,
    getSettings: () => settings,
    retrieve: async (query) => {
      queries.push(query)
      return retrieve(query)
    }
  })
  return { agent, queries }
}

describe('KbAgent', () => {
  it('answers with the retrieved snippet and returns its sources', async () => {
    const { agent, queries } = setup(async () => [HIT])

    const result = await agent.ask('排水沟净宽有哪些规范要求？')

    expect(queries).toEqual(['排水沟净宽有哪些规范要求？'])
    expect(result.answer).toContain('排水沟净宽 600x600')
    expect(result.answer).toContain('notes.dxf')
    expect(result.answer).toContain('句柄 #A1F')
    expect(result.sources).toEqual([HIT])
    expect(result.error).toBeUndefined()
  })

  it('states insufficient evidence when nothing is retrieved', async () => {
    const { agent } = setup(async () => [])

    const result = await agent.ask('隧道照明亮度规范要求是什么？')

    expect(result.answer).toContain('依据不足')
    expect(result.sources).toEqual([])
  })

  it('reports retrieval failure without inventing an answer', async () => {
    const { agent } = setup(async () => {
      throw new Error('sidecar request timed out: kb_search')
    })

    const result = await agent.ask('排水沟净宽有哪些规范要求？')

    expect(result.answer).toContain('检索失败')
    expect(result.sources).toEqual([])
  })

  it('flags low-confidence vision hits as needing manual review', async () => {
    const lowConfidence: KbHit = {
      ...HIT,
      docName: 'scan.png',
      text: '扫描图纸识别：排水沟净宽 600mm',
      location: { region: '要点 1' },
      sourceType: 'vision',
      confidence: 0.55
    }
    const { agent } = setup(async () => [lowConfidence])

    const result = await agent.ask('排水沟净宽有哪些要求？')

    expect(result.answer).toContain('扫描图纸识别')
    expect(result.answer).toContain('低置信')
    expect(result.answer).toContain('人工核对')
    expect(result.answer).toContain('不能作为唯一依据')
  })

  it('does not add the low-confidence warning for text sources', async () => {
    const { agent } = setup(async () => [{ ...HIT, sourceType: 'text' }])

    const result = await agent.ask('排水沟净宽有哪些规范要求？')

    expect(result.answer).toContain('排水沟净宽 600x600')
    expect(result.answer).not.toContain('人工核对')
  })
})
