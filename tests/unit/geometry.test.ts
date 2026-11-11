import { describe, expect, it } from 'vitest'
import {
  createFitTransform,
  screenToWorld,
  worldToScreen,
  zoomAt
} from '../../src/renderer/src/drawing/geometry'

describe('drawing view transform', () => {
  it('fits bounds into the canvas with padding', () => {
    const view = createFitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 200, 10)

    expect(view.scale).toBeCloseTo(1.8, 6)
    expect(worldToScreen(view, 0, 0)).toEqual([10, 145])
    expect(worldToScreen(view, 100, 50)).toEqual([190, 55])
  })

  it('maps screen coordinates back to world coordinates', () => {
    const view = createFitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 400, 300, 0)
    const [screenX, screenY] = worldToScreen(view, 25, 40)

    const [worldX, worldY] = screenToWorld(view, screenX, screenY)

    expect(worldX).toBeCloseTo(25, 6)
    expect(worldY).toBeCloseTo(40, 6)
  })

  it('keeps the cursor anchor fixed while zooming', () => {
    const view = createFitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 200, 0)
    const zoomed = zoomAt(view, 100, 100, 2)

    expect(zoomed.scale).toBeCloseTo(view.scale * 2, 6)
    expect(worldToScreen(zoomed, 50, 25)).toEqual([100, 100])
  })
})
