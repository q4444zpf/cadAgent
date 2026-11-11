import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Drawing } from '../../src/shared/protocol'
import { createDrawingTools } from '../../src/node/agent/reading-tools'

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
    unsupported: { SPLINE: 2 }
  }
}

async function call(
  tools: AgentTool<any>[],
  name: string,
  args: unknown
): Promise<{ text: string; data: any; isError: boolean }> {
  const tool = tools.find((item) => item.name === name)
  if (!tool) {
    throw new Error(`tool ${name} missing`)
  }
  const result = await tool.execute('call-1', args as never)
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { text, data, isError: result.isError === true }
}

describe('drawing tools', () => {
  it('summarizes counts, layers and bounds for the current drawing', async () => {
    const tools = createDrawingTools(() => fixture())
    const { data } = await call(tools, 'drawing_summary', {})

    expect(data).toMatchObject({
      name: 'simple.dxf',
      entityCount: 5,
      layerCount: 3,
      textCount: 1,
      kindCounts: { line: 2, polyline: 1, circle: 1, text: 1 },
      unsupported: { SPLINE: 2 }
    })
    expect(data.layers).toEqual([
      { name: '0', color: 7, entityCount: 2 },
      { name: 'WALLS', color: 1, entityCount: 2 },
      { name: 'TEXT', color: 3, entityCount: 1 }
    ])
  })

  it('finds entities by layer regardless of case', async () => {
    const tools = createDrawingTools(() => fixture())
    const { data } = await call(tools, 'search_entities', { layer: 'walls' })

    expect(data.total).toBe(2)
    expect(data.entities.map((entity: { handle: string }) => entity.handle)).toEqual(['B1', 'B2'])
  })

  it('finds text entities by content and ignores text filters for other kinds', async () => {
    const tools = createDrawingTools(() => fixture())

    const texts = await call(tools, 'search_entities', { kind: 'text', textContains: '排水' })
    expect(texts.data.total).toBe(1)
    expect(texts.data.entities[0]).toMatchObject({ handle: 'C1', text: '排水沟 600×600' })

    const lines = await call(tools, 'search_entities', { kind: 'line', textContains: '排水' })
    expect(lines.data.total).toBe(0)
  })

  it('caps the number of returned entities while reporting the full match count', async () => {
    const tools = createDrawingTools(() => fixture())
    const { data } = await call(tools, 'search_entities', { limit: 2 })

    expect(data.total).toBe(5)
    expect(data.returned).toBe(2)
    expect(data.entities).toHaveLength(2)
  })

  it('returns the full entity for a known handle and an error for an unknown one', async () => {
    const tools = createDrawingTools(() => fixture())

    const found = await call(tools, 'get_entity', { handle: 'B1' })
    expect(found.isError).toBe(false)
    expect(found.data).toMatchObject({ handle: 'B1', kind: 'polyline', layer: 'WALLS' })

    const missing = await call(tools, 'get_entity', { handle: 'ZZZ' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('ZZZ')
  })

  it('refuses to answer when no drawing is loaded', async () => {
    const tools = createDrawingTools(() => null)
    const { isError, text } = await call(tools, 'drawing_summary', {})

    expect(isError).toBe(true)
    expect(text).toContain('没有打开图纸')
  })
})

describe('drawing tools in summary mode', () => {
  function summaryFixture(): Drawing {
    return {
      path: 'C:/samples/02.dxf',
      name: '02.dxf',
      layers: [{ name: 'GCD', color: 3, entityCount: 45088 }],
      entities: [],
      bounds: { minX: 428685, minY: 2916986, maxX: 1083206, maxY: 5853287 },
      unsupported: {},
      summaryOnly: true,
      entityCounts: { INSERT: 222621, LINE: 27807, TEXT: 8321 },
      textSamples: ['排水沟', '涵洞']
    }
  }

  it('answers counts from the summary payload instead of the empty entity list', async () => {
    const tools = createDrawingTools(() => summaryFixture())
    const { data } = await call(tools, 'drawing_summary', {})

    expect(data).toMatchObject({
      entityCount: 258749,
      textCount: 8321,
      summaryOnly: true,
      textSamples: ['排水沟', '涵洞'],
      kindCounts: { INSERT: 222621, LINE: 27807, TEXT: 8321 }
    })
  })

  it('rejects entity search instead of pretending the drawing has no entities', async () => {
    const tools = createDrawingTools(() => summaryFixture())
    const { isError, text } = await call(tools, 'search_entities', { layer: 'GCD' })

    expect(isError).toBe(true)
    expect(text).toContain('摘要模式')
    expect(text).toContain('drawing_summary')
  })

  it('rejects entity lookup in summary mode', async () => {
    const tools = createDrawingTools(() => summaryFixture())
    const { isError, text } = await call(tools, 'get_entity', { handle: 'A1' })

    expect(isError).toBe(true)
    expect(text).toContain('摘要模式')
  })
})
