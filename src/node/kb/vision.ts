import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { VisionRecognitionSchema } from '../../shared/protocol'
import type { VisionRecognition } from '../../shared/protocol'
import type { ModelRuntime } from '../model/runtime'
import type { StoredModelSettings } from '../model/settings'

export const VISION_PROMPT = `你是工程扫描图识别助手。请读取图纸图片，只输出 JSON（不要代码块或额外说明）：
{"description": "图纸内容的简明文字描述，包含可见构件、尺寸与图签文字", "points": ["逐条可检索的要点，包含构件名与数值"], "confidence": 0到1之间的小数，表示整体识别置信度}
只描述图中可见内容；看不清的部分标注“不清晰”，禁止编造规范数值。`

const FAKE_REPLY = JSON.stringify({
  description:
    '扫描图纸为排水沟剖面示意，标注排水沟净宽 600×600，壁厚 100mm，沟底纵坡 0.3%。',
  points: ['排水沟净宽 600mm', '壁厚 100mm', '沟底纵坡 0.3%'],
  confidence: 0.55
})

export interface VisionRecognizerDeps {
  models: ModelRuntime
  getSettings: () => StoredModelSettings
}

export class VisionRecognizer {
  constructor(private readonly deps: VisionRecognizerDeps) {}

  async recognize(path: string): Promise<VisionRecognition> {
    const mimeType = mimeFor(path)
    if (!mimeType) {
      throw new Error('视觉识别失败：仅支持 PNG/JPG 图片')
    }

    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (error) {
      throw new Error(`视觉识别失败：无法读取图片（${describe(error)}）`)
    }
    if (!hasImageSignature(bytes, mimeType)) {
      throw new Error('视觉识别失败：图片文件已损坏或不是有效的 PNG/JPG')
    }

    const settings = this.deps.getSettings()
    const reply = await this.deps.models.complete(VISION_PROMPT, {
      image: { data: bytes.toString('base64'), mimeType },
      lane: 'vision',
      ...(settings.fakeMode ? { fakeReply: FAKE_REPLY } : {})
    })
    return parseVisionReply(reply)
  }
}

export function parseVisionReply(text: string): VisionRecognition {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('视觉识别失败：模型未返回 JSON 结果')
  }

  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('视觉识别失败：模型返回的 JSON 无法解析')
  }

  const parsed = VisionRecognitionSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('视觉识别失败：结果缺少描述、要点或置信度字段')
  }

  const description = parsed.data.description.trim()
  const points = parsed.data.points.map((point) => point.trim()).filter(Boolean)
  if (!description && points.length === 0) {
    throw new Error('视觉识别失败：结果中没有可入库的内容')
  }
  return {
    description,
    points,
    confidence: roundConfidence(parsed.data.confidence)
  }
}

function mimeFor(path: string): string | null {
  const suffix = extname(path).toLowerCase()
  if (suffix === '.png') {
    return 'image/png'
  }
  if (suffix === '.jpg' || suffix === '.jpeg') {
    return 'image/jpeg'
  }
  return null
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (bytes.length < 8) {
    return false
  }
  if (mimeType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function roundConfidence(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1)
  return Math.round(clamped * 100) / 100
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
