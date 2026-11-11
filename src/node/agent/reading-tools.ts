import type { AgentTool } from '@earendil-works/pi-agent-core'
import { drawingEntityCount, type Drawing, type DrawingEntity } from '../../shared/protocol'
import { failure, success } from './tool-result'

const SUMMARY_MODE_NOTE =
  '当前图纸以大图纸摘要模式加载，未展开实体明细。请改用 drawing_summary 获取实体总数、类型与图层统计。'

type DrawingAccessor = () => Drawing | null

interface SearchArgs {
  layer?: string
  kind?: DrawingEntity['kind']
  textContains?: string
  limit?: number
}

const ENTITY_KINDS = ['line', 'polyline', 'circle', 'arc', 'text'] as const

export function createDrawingTools(getDrawing: DrawingAccessor): AgentTool<any>[] {
  return [summaryTool(getDrawing), searchTool(getDrawing), entityTool(getDrawing)]
}

function summaryTool(getDrawing: DrawingAccessor): AgentTool<any> {
  return {
    name: 'drawing_summary',
    label: '图纸摘要',
    description:
      '获取当前图纸的整体摘要：文件名、实体总数、各类实体数量、图层清单（名称/颜色/实体数）、包围盒与未展开实体。回答数量、图层、整体结构类问题前先调用。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async () => {
      const drawing = getDrawing()
      if (!drawing) {
        return failure('当前没有打开图纸，无法读取图纸内容。请先导入 DXF 文件。')
      }
      return success(summarize(drawing))
    }
  }
}

function searchTool(getDrawing: DrawingAccessor): AgentTool<any> {
  return {
    name: 'search_entities',
    label: '检索实体',
    description:
      '按图层、实体类型或文字内容检索图纸实体，返回实体句柄与完整几何信息。kind 取值：line、polyline、circle、arc、text。回答“某图层有什么”“图纸里有哪些文字”等问题时使用。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层名（不区分大小写）' },
        kind: { type: 'string', enum: [...ENTITY_KINDS], description: '实体类型' },
        textContains: { type: 'string', description: '文字内容包含的关键词，仅匹配 TEXT 实体' },
        limit: {
          type: 'number',
          description: '最多返回的实体数量，默认 20，最大 50'
        }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const drawing = getDrawing()
      if (!drawing) {
        return failure('当前没有打开图纸，无法读取图纸内容。请先导入 DXF 文件。')
      }
      if (drawing.summaryOnly) {
        return failure(SUMMARY_MODE_NOTE)
      }

      const args = (params ?? {}) as SearchArgs
      const limit = clampLimit(args.limit)
      const layer = args.layer?.toLowerCase()
      const textContains = args.textContains?.toLowerCase()

      const matched = drawing.entities.filter((entity) => {
        if (layer && entity.layer.toLowerCase() !== layer) {
          return false
        }
        if (args.kind && entity.kind !== args.kind) {
          return false
        }
        if (textContains) {
          if (entity.kind !== 'text' || !entity.text.toLowerCase().includes(textContains)) {
            return false
          }
        }
        return true
      })

      return success({
        total: matched.length,
        returned: Math.min(matched.length, limit),
        entities: matched.slice(0, limit)
      })
    }
  }
}

function entityTool(getDrawing: DrawingAccessor): AgentTool<any> {
  return {
    name: 'get_entity',
    label: '读取实体',
    description: '按实体句柄读取单个实体的完整数据（图层、类型、几何或文字）。',
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '实体句柄，例如 A1' }
      },
      required: ['handle'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const drawing = getDrawing()
      if (!drawing) {
        return failure('当前没有打开图纸，无法读取图纸内容。请先导入 DXF 文件。')
      }
      if (drawing.summaryOnly) {
        return failure(SUMMARY_MODE_NOTE)
      }

      const handle = String((params as { handle?: string })?.handle ?? '')
      const entity = drawing.entities.find((item) => item.handle === handle)
      if (!entity) {
        return failure(`图纸中未找到句柄 #${handle} 的实体。`)
      }
      return success(entity)
    }
  }
}

function summarize(drawing: Drawing): Record<string, unknown> {
  let kindCounts: Record<string, number> = {}
  if (drawing.entityCounts) {
    kindCounts = { ...drawing.entityCounts }
  } else {
    for (const entity of drawing.entities) {
      kindCounts[entity.kind] = (kindCounts[entity.kind] ?? 0) + 1
    }
  }

  return {
    name: drawing.name,
    path: drawing.path,
    entityCount: drawingEntityCount(drawing),
    kindCounts,
    layerCount: drawing.layers.length,
    layers: drawing.layers,
    bounds: drawing.bounds,
    unsupported: drawing.unsupported,
    textCount: kindCounts.text ?? kindCounts.TEXT ?? 0,
    ...(drawing.summaryOnly
      ? { summaryOnly: true, textSamples: drawing.textSamples ?? [] }
      : {})
  }
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 20
  }
  return Math.min(Math.max(Math.trunc(value), 1), 50)
}
