import { describe, expect, it } from 'vitest'
import type { Drawing } from '../../src/shared/protocol'
import { pickVisibleEntities } from '../../src/renderer/src/drawing/entities'

const drawing: Drawing = {
  path: 'C:/tmp/demo.dxf',
  name: 'demo.dxf',
  layers: [
    { name: 'WALLS', color: 1, entityCount: 2 },
    { name: 'SYMBOL', color: 3, entityCount: 1 }
  ],
  entities: [
    { kind: 'line', handle: '1', layer: 'WALLS', color: 256, start: [0, 0], end: [10, 0] },
    { kind: 'line', handle: '2', layer: 'WALLS', color: 256, start: [0, 0], end: [0, 5] },
    { kind: 'circle', handle: '3', layer: 'SYMBOL', color: 256, center: [5, 5], radius: 2 }
  ],
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
  unsupported: {}
}

describe('layer visibility', () => {
  it('keeps only entities on visible layers', () => {
    const visible = pickVisibleEntities(drawing, new Set(['SYMBOL']))

    expect(visible.map((entity) => entity.handle)).toEqual(['3'])
  })

  it('shows every entity when all layers are visible', () => {
    const visible = pickVisibleEntities(drawing, new Set(['WALLS', 'SYMBOL']))

    expect(visible).toHaveLength(3)
  })

  it('shows nothing when every layer is hidden', () => {
    expect(pickVisibleEntities(drawing, new Set())).toEqual([])
  })
})
