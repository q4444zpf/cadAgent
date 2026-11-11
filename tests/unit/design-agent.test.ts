import { describe, expect, it } from 'vitest'
import { buildParameterList, DesignAgent } from '../../src/node/design/agent'
import type { KbAnswer } from '../../src/node/agent/kb-agent'
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

function setup(knowledge: (question: string) => Promise<KbAnswer>): DesignAgent {
  return new DesignAgent({
    models: new ModelRuntime(() => settings),
    getSettings: () => settings,
    knowledge
  })
}

describe('DesignAgent', () => {
  it('可研时先查知识库再提交带依据的参数清单', async () => {
    const questions: string[] = []
    const agent = setup(async (question) => {
      questions.push(question)
      return { answer: HIT.text, sources: [HIT] }
    })

    const outcome = await agent.propose('生成一条 600×600 排水沟断面图，壁厚 100mm')

    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain('排水沟')
    expect(outcome.error).toBeUndefined()
    expect(outcome.list?.drawingType).toBe('排水沟')
    expect(outcome.list?.parameters).toHaveLength(4)
    expect(outcome.sources).toEqual([HIT])
    expect(outcome.text).toContain('4 项参数')

    const width = outcome.list?.parameters.find((parameter) => parameter.id === 'width')
    expect(width).toMatchObject({ name: '净宽', value: '600', unit: 'mm', assumed: false })
    expect(width?.basis).toContain('notes.dxf')
    expect(width?.basis).toContain('句柄 #A1F')

    const cover = outcome.list?.parameters.find((parameter) => parameter.id === 'cover')
    expect(cover?.assumed).toBe(true)
    expect(cover?.basis).toContain('假设')
  })

  it('知识库无依据时把参数标为假设', async () => {
    const agent = setup(async () => ({ answer: '依据不足', sources: [] }))

    const outcome = await agent.propose('生成一条排水沟断面图')

    expect(outcome.list?.parameters.every((parameter) => parameter.assumed)).toBe(true)
    expect(outcome.list?.parameters[0].basis).toContain('假设')
    expect(outcome.sources).toEqual([])
  })
})

describe('buildParameterList', () => {
  it('拒绝既无依据也未标为假设的参数', () => {
    expect(() =>
      buildParameterList({
        title: '排水沟断面',
        drawingType: '排水沟',
        parameters: [{ name: '净宽', value: '600', unit: 'mm', basis: '', assumed: false }]
      })
    ).toThrow('参数「净宽」缺少依据，也未标记为假设')
  })

  it('补齐参数标识并允许无依据的假设项', () => {
    const list = buildParameterList({
      title: '排水沟断面',
      drawingType: '排水沟',
      parameters: [
        { name: '净宽', value: ' 600 ', unit: 'mm', basis: 'spec.pdf·第 2 页', assumed: false },
        { name: '盖板厚度', value: '100', basis: ' 假设：按常规取值 ', assumed: true }
      ]
    })

    expect(list.parameters[0]).toMatchObject({ id: 'p1', value: '600' })
    expect(list.parameters[1]).toMatchObject({
      id: 'p2',
      unit: '',
      basis: '假设：按常规取值',
      assumed: true
    })
  })

  it('拒绝空参数清单', () => {
    expect(() =>
      buildParameterList({ title: '排水沟断面', drawingType: '排水沟', parameters: [] })
    ).toThrow('参数清单至少需要一项参数')
  })
})
