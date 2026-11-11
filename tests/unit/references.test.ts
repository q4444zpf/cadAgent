import { describe, expect, it } from 'vitest'
import { extractReferences } from '../../src/node/agent/references'
import type { Drawing } from '../../src/shared/protocol'

const drawing: Drawing = {
  path: 'C:/samples/simple.dxf',
  name: 'simple.dxf',
  layers: [
    { name: '0', color: 7, entityCount: 1 },
    { name: 'WALLS', color: 1, entityCount: 2 }
  ],
  entities: [
    { kind: 'line', handle: 'A1', layer: '0', color: 256, start: [0, 0], end: [10, 0] },
    { kind: 'polyline', handle: 'B1', layer: 'WALLS', color: 1, points: [[0, 0], [5, 5]], closed: false },
    { kind: 'circle', handle: 'B2', layer: 'WALLS', color: 1, center: [5, 5], radius: 2 }
  ],
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  unsupported: {}
}

describe('extractReferences', () => {
  it('resolves a single cited handle to its entity metadata', () => {
    expect(extractReferences('该圆位于 #B2。', drawing)).toEqual([
      { handle: 'B2', exists: true, kind: 'circle', layer: 'WALLS' }
    ])
  })

  it('keeps the order of multiple cited handles and removes duplicates', () => {
    expect(extractReferences('#B1、#B2 与 #B1 都属于 WALLS。', drawing).map((ref) => ref.handle)).toEqual([
      'B1',
      'B2'
    ])
  })

  it('reports a missing handle without throwing', () => {
    expect(extractReferences('请查看 #ZZ9。', drawing)).toEqual([{ handle: 'ZZ9', exists: false }])
  })

  it('ignores text without handle citations', () => {
    expect(extractReferences('这张图纸共有 4 个实体。', drawing)).toEqual([])
  })

  it('matches handles case-insensitively and returns the canonical handle', () => {
    expect(extractReferences('#b1', drawing)).toEqual([
      { handle: 'B1', exists: true, kind: 'polyline', layer: 'WALLS' }
    ])
  })

  it('treats every citation as missing when no drawing is open', () => {
    expect(extractReferences('参考 #A1。', null)).toEqual([{ handle: 'A1', exists: false }])
  })
})
