import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SidecarClient } from '../../src/node/sidecar/client'

describe('Node <-> Python sidecar contract', () => {
  const client = new SidecarClient()

  beforeAll(async () => {
    await client.start()
  })

  afterAll(async () => {
    await client.stop()
  })

  it('health returns service identity and runtime versions', async () => {
    const health = await client.health()

    expect(health.service).toBe('cad-service')
    expect(health.version).toBe('0.1.0')
    expect(health.ezdxf).toMatch(/^1\./)
    expect(health.python).toMatch(/^3\.12/)
  })

  it('reports an error when the sidecar process dies, then restarts', async () => {
    const pid = client.getPid()
    expect(pid).toBeTypeOf('number')

    process.kill(pid as number)
    await waitFor(() => client.getStatus().state === 'error')

    expect(client.getStatus().state).toBe('error')

    await client.start()
    expect(client.getStatus().state).toBe('ready')

    const health = await client.health()
    expect(health.ezdxf).toMatch(/^1\./)
  })

  it('parses a DXF file into layers, entities and bounds', async () => {
    const drawing = await client.parseDrawing(path.resolve('samples/fixtures/simple.dxf'))

    expect(drawing.name).toBe('simple.dxf')
    expect(drawing.layers.find((layer) => layer.name === 'WALLS')?.entityCount).toBe(2)
    expect(drawing.entities.filter((entity) => entity.kind === 'line')).toHaveLength(2)
    expect(drawing.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 })
  })

  it('expands block references and dimensions into renderable entities', async () => {
    const block = await client.parseDrawing(path.resolve('samples/fixtures/block.dxf'))

    expect(block.entities).toHaveLength(2)
    expect(block.entities.every((entity) => entity.layer === 'BLOCK')).toBe(true)
    expect(block.bounds).toEqual({ minX: 9, minY: 19, maxX: 11, maxY: 21 })

    const dimension = await client.parseDrawing(path.resolve('samples/fixtures/dim.dxf'))

    expect(dimension.entities).toHaveLength(5)
    expect(dimension.entities.every((entity) => entity.layer === 'DIM')).toBe(true)
    expect(dimension.unsupported).toMatchObject({ POINT: 3, SOLID: 2 })
  })

  it('rejects a missing drawing with a readable error', async () => {
    await expect(
      client.parseDrawing(path.resolve('samples/fixtures/missing.dxf'))
    ).rejects.toThrow(/图纸不存在/)
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met within timeout')
}
