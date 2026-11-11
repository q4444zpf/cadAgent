import { describe, expect, it } from 'vitest'
import { isDrawingOversize, MAX_DXF_BYTES } from '../../src/node/drawing/limits'

const MB = 1024 * 1024

describe('drawing size limit', () => {
  it('accepts a normal single-sheet DXF', () => {
    expect(isDrawingOversize(1.1 * MB)).toBe(false)
  })

  it('switches a combined drawing set to summary mode', () => {
    expect(isDrawingOversize(179 * MB)).toBe(true)
  })

  it('treats the limit itself as allowed', () => {
    expect(isDrawingOversize(MAX_DXF_BYTES)).toBe(false)
  })
})
