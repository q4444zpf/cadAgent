import { describe, expect, it } from 'vitest'
import { aciToRgb, resolveEntityColor } from '../../src/renderer/src/drawing/aci'

describe('ACI color mapping', () => {
  it('maps the seven standard colors', () => {
    expect(aciToRgb(1)).toEqual([255, 0, 0])
    expect(aciToRgb(3)).toEqual([0, 255, 0])
    expect(aciToRgb(7)).toEqual([255, 255, 255])
  })

  it('maps hue groups and their shades', () => {
    expect(aciToRgb(10)).toEqual([255, 0, 0])
    expect(aciToRgb(20)).toEqual([255, 64, 0])
    expect(aciToRgb(12)).toEqual([165, 0, 0])
  })

  it('maps the grayscale tail', () => {
    expect(aciToRgb(251)).toEqual([91, 91, 91])
  })

  it('falls back to the layer color for BYLAYER and BYBLOCK', () => {
    expect(resolveEntityColor(256, 3)).toBe('#00ff00')
    expect(resolveEntityColor(0, 1)).toBe('#ff0000')
    expect(resolveEntityColor(5, 1)).toBe('#0000ff')
    expect(resolveEntityColor(256, 256)).toBe('#ffffff')
  })
})
