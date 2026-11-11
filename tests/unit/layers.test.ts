import { describe, expect, it } from 'vitest'
import type { DrawingEntity, DrawingLayer } from '../../src/shared/protocol'
import { boundsOfEntities, planLayerLoads } from '../../src/renderer/src/drawing/layers'

function layer(name: string, entityCount: number): DrawingLayer {
  return { name, color: 7, entityCount }
}

describe('planLayerLoads', () => {
  it('loads layers from smallest to largest and skips empty layers', () => {
    const plan = planLayerLoads([
      layer('注释', 4243),
      layer('EMPTY', 0),
      layer('JMD', 3139),
      layer('PP-COM', 13494)
    ])

    expect(plan.map((item) => item.name)).toEqual(['JMD', '注释', 'PP-COM'])
  })

  it('breaks ties by layer name', () => {
    const plan = planLayerLoads([layer('B', 5), layer('A', 5)])

    expect(plan.map((item) => item.name)).toEqual(['A', 'B'])
  })
})

describe('boundsOfEntities', () => {
  it('covers lines, circles and text', () => {
    const bounds = boundsOfEntities([
      { kind: 'line', handle: '1', layer: 'A', color: 7, start: [0, 0], end: [100, 50] },
      { kind: 'circle', handle: '2', layer: 'A', color: 7, center: [20, 10], radius: 5 },
      {
        kind: 'text',
        handle: '3',
        layer: 'A',
        color: 7,
        insert: [-10, -2],
        text: 'AB',
        height: 10,
        rotation: 0
      }
    ])

    expect(bounds).toEqual({ minX: -10, minY: -2, maxX: 100, maxY: 50 })
  })

  it('returns null when there is no geometry', () => {
    expect(boundsOfEntities([])).toBeNull()
  })

  it('handles entity counts beyond the argument limit of Math.min', () => {
    const entities: DrawingEntity[] = Array.from({ length: 200_000 }, (_, index) => ({
      kind: 'line',
      handle: String(index),
      layer: 'A',
      color: 7,
      start: [index, index - 100_000],
      end: [index + 1, index - 100_000 + 1]
    }))

    expect(boundsOfEntities(entities)).toEqual({
      minX: 0,
      minY: -100_000,
      maxX: 200_000,
      maxY: 100_000
    })
  })
})
