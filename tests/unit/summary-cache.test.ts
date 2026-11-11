import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Drawing } from '../../src/shared/protocol'
import {
  readSummaryCache,
  summaryCacheKey,
  writeSummaryCache
} from '../../src/node/drawing/summary-cache'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cad-summary-cache-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function summaryDrawing(): Drawing {
  return {
    path: 'C:/samples/02.dxf',
    name: '02.dxf',
    layers: [{ name: 'GCD', color: 3, entityCount: 45088 }],
    entities: [],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    unsupported: {},
    summaryOnly: true,
    entityCounts: { INSERT: 222621, LINE: 27807 },
    textSamples: ['排水沟']
  }
}

describe('summary cache', () => {
  it('keys on path, size and mtime', () => {
    const base = { path: 'C:/samples/02.dxf', size: 179, mtimeMs: 1000 }
    expect(summaryCacheKey(base)).toBe(summaryCacheKey({ ...base }))
    expect(summaryCacheKey(base)).not.toBe(summaryCacheKey({ ...base, size: 180 }))
    expect(summaryCacheKey(base)).not.toBe(summaryCacheKey({ ...base, mtimeMs: 1001 }))
  })

  it('round-trips a summary drawing', async () => {
    const drawing = summaryDrawing()
    const key = summaryCacheKey({ path: drawing.path, size: 179, mtimeMs: 1000 })
    await writeSummaryCache(dir, key, drawing)
    await expect(readSummaryCache(dir, key)).resolves.toEqual(drawing)
  })

  it('ignores a drawing that is not in summary mode', async () => {
    const key = 'normal'
    await writeSummaryCache(dir, key, { ...summaryDrawing(), summaryOnly: false })
    await expect(readSummaryCache(dir, key)).resolves.toBeNull()
  })

  it('treats missing or corrupt entries as a cache miss', async () => {
    await expect(readSummaryCache(dir, 'missing')).resolves.toBeNull()
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    await expect(readSummaryCache(dir, 'broken')).resolves.toBeNull()
  })

  it('writes one json file per key', async () => {
    const key = summaryCacheKey({ path: 'a.dxf', size: 1, mtimeMs: 2 })
    await writeSummaryCache(dir, key, summaryDrawing())
    const raw = await readFile(join(dir, `${key}.json`), 'utf8')
    expect(JSON.parse(raw).summaryOnly).toBe(true)
  })
})
