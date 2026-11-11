import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseVisionReply, VisionRecognizer } from '../../src/node/kb/vision'
import { ModelRuntime } from '../../src/node/model/runtime'
import type { StoredModelSettings } from '../../src/node/model/settings'

const settings: StoredModelSettings = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  fakeMode: true,
  apiKey: null
}

function recognizer(): VisionRecognizer {
  return new VisionRecognizer({
    models: new ModelRuntime(() => settings),
    getSettings: () => settings
  })
}

describe('VisionRecognizer', () => {
  it('recognizes a scanned drawing into description, points and confidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cad-vision-'))
    const path = join(dir, 'scan.png')
    await copyFile('samples/kb/scan.png', path)

    const result = await recognizer().recognize(path)

    expect(result.description).toContain('排水沟净宽')
    expect(result.points).toContain('壁厚 100mm')
    expect(result.confidence).toBe(0.55)
  })

  it('rejects a damaged image instead of guessing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cad-vision-'))
    const path = join(dir, 'broken.png')
    await writeFile(path, 'not really a png')

    await expect(recognizer().recognize(path)).rejects.toThrow('图片文件已损坏')
  })

  it('rejects unsupported image formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cad-vision-'))
    const path = join(dir, 'scan.bmp')
    await writeFile(path, Buffer.from([0x42, 0x4d, 0, 0]))

    await expect(recognizer().recognize(path)).rejects.toThrow('仅支持 PNG/JPG')
  })
})

describe('parseVisionReply', () => {
  it('parses JSON wrapped in code fences and clamps confidence', () => {
    const parsed = parseVisionReply(
      '```json\n{"description":"排水沟剖面","points":["净宽 600mm"," "],"confidence":1.7}\n```'
    )

    expect(parsed.description).toBe('排水沟剖面')
    expect(parsed.points).toEqual(['净宽 600mm'])
    expect(parsed.confidence).toBe(1)
  })

  it('reports a missing JSON reply', () => {
    expect(() => parseVisionReply('看不清这张图')).toThrow('未返回 JSON')
  })

  it('reports missing fields', () => {
    expect(() => parseVisionReply('{"description":"只有描述"}')).toThrow('缺少描述、要点或置信度')
  })
})
