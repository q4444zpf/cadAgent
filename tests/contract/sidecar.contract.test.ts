import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
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

  it('keeps the drawing open and loads entities one layer at a time', async () => {
    const file = path.resolve('samples/fixtures/block.dxf')

    const summary = await client.openDrawing(file)

    expect(summary.summaryOnly).toBe(true)
    expect(summary.layers.find((layer) => layer.name === 'BLOCK')?.entityCount).toBe(1)

    const entities = await client.layerEntities(file, 'BLOCK')
    expect(entities).toHaveLength(2)
    expect(entities.every((entity) => entity.layer === 'BLOCK')).toBe(true)
    expect(await client.layerEntities(file, 'MISSING')).toEqual([])

    await client.closeDrawing()
  })
})

describe('project filesystem tools', () => {
  const client = new SidecarClient()
  let root = ''

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'cad-project-'))
    mkdirSync(path.join(root, 'docs'))
    mkdirSync(path.join(root, 'node_modules'))
    writeFileSync(path.join(root, 'readme.md'), '# 项目说明\n', 'utf-8')
    writeFileSync(path.join(root, 'docs', 'note.txt'), '纵坡 0.3%\n', 'utf-8')
    writeFileSync(path.join(root, 'node_modules', 'skip.txt'), 'ignored', 'utf-8')
    copyFileSync(path.resolve('samples/fixtures/simple.dxf'), path.join(root, 'simple.dxf'))
    copyFileSync(
      path.resolve('samples/fixtures/archives/sample.zip'),
      path.join(root, 'sample.zip')
    )
    copyFileSync(
      path.resolve('samples/fixtures/archives/sample.tar.gz'),
      path.join(root, 'sample.tar.gz')
    )
    await client.start()
  })

  afterAll(async () => {
    await client.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('scans the project root and ignores dependency directories', async () => {
    const result = await client.scanProject(root)

    expect(result.path).toBe('.')
    expect(result.totals.files).toBe(5)
    expect(result.totals.archives).toBe(2)
    const names = result.entries.map((entry) => entry.name)
    expect(names).toContain('readme.md')
    expect(names).toContain('docs')
    expect(names).not.toContain('node_modules')
    expect(result.byExtension.md).toBe(1)
  })

  it('filters scans by extension and rejects paths outside the project', async () => {
    const result = await client.scanProject(root, '.', { extension: 'zip' })

    expect(result.totals.files).toBe(1)
    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'sample.zip', type: 'archive', format: 'zip' })
    ])

    await expect(client.scanProject(root, '../')).rejects.toThrow(/超出项目范围/)
  })

  it('lists ZIP and TAR archives', async () => {
    const zip = await client.listArchive(root, 'sample.zip')
    expect(zip.format).toBe('zip')
    expect(zip.entryCount).toBe(2)
    expect(zip.entries.map((entry) => entry.name)).toEqual(['readme.txt', 'docs/spec.md'])

    const tar = await client.listArchive(root, 'sample.tar.gz')
    expect(tar.format).toBe('tar.gz')
    expect(tar.entryCount).toBe(2)
    expect(tar.totalUncompressedBytes).toBeGreaterThan(0)
  })

  it('extracts beside the archive without overwriting', async () => {
    const first = await client.extractArchive(root, 'sample.zip')
    expect(first.target).toBe('sample_解压')
    expect(first.filesExtracted).toBe(2)
    expect(readFileSync(path.join(root, 'sample_解压', 'readme.txt'), 'utf-8')).toContain(
      '项目压缩包示例'
    )

    const second = await client.extractArchive(root, 'sample.zip')
    expect(second.target).toBe('sample_解压-2')
    expect(existsSync(path.join(root, 'sample_解压-2', 'docs', 'spec.md'))).toBe(true)

    await expect(client.extractArchive(root, 'sample.zip', 'sample_解压')).rejects.toThrow(
      /不会覆盖/
    )
  })

  it('reads text files and summarizes DXF without expanding entities', async () => {
    const text = await client.readFile(root, 'docs/note.txt')
    expect(text.kind).toBe('text')
    expect(text.content).toBe('纵坡 0.3%\n')
    expect(text.encoding).toBe('utf-8')

    const dxf = await client.readFile(root, 'simple.dxf')
    expect(dxf.kind).toBe('dxf')
    expect(dxf.summary?.summaryOnly).toBe(true)
    expect(dxf.summary?.layers.find((layer) => layer.name === 'WALLS')?.entityCount).toBe(2)
  })

  it('refuses to read secrets and unsupported formats', async () => {
    writeFileSync(path.join(root, '.env'), 'API_KEY=secret', 'utf-8')
    writeFileSync(path.join(root, 'blob.bin'), 'binary', 'utf-8')

    await expect(client.readFile(root, '.env')).rejects.toThrow(/敏感文件/)
    await expect(client.readFile(root, 'blob.bin')).rejects.toThrow(/不支持读取/)
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
