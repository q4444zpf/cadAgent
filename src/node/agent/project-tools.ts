import type { AgentTool } from '@earendil-works/pi-agent-core'
import { relative } from 'node:path'
import { drawingEntityCount, type DrawingOpenResult, type FileAttachment } from '../../shared/protocol'
import type { SidecarClient } from '../sidecar/client'
import { resolveProjectPath } from '../project/workspace'
import { failure, success } from './tool-result'

const NO_PROJECT = '请先打开项目文件夹，再处理项目内文件。'
const MAX_SCAN_ENTRIES_IN_TOOL = 50
const MAX_ARCHIVE_ENTRIES_IN_TOOL = 100
const MAX_CONTENT_CHARS_IN_TOOL = 8000

const ATTACHMENT_KIND_LABELS: Record<FileAttachment['kind'], string> = {
  drawing: '图纸',
  archive: '压缩包',
  document: '文档',
  text: '文本',
  image: '图片',
  other: '文件'
}

export interface ProjectToolsDeps {
  getRoot: () => string | null
  sidecar: SidecarClient
  openDrawing: (filePath: string) => Promise<DrawingOpenResult>
}

export function createProjectTools(deps: ProjectToolsDeps): AgentTool<any>[] {
  return [scanTool(deps), listTool(deps), extractTool(deps), readTool(deps), openTool(deps)]
}

function scanTool(deps: ProjectToolsDeps): AgentTool<any> {
  return {
    name: 'scan_project',
    label: '扫描项目',
    description:
      '扫描项目文件夹中的文件与压缩包，返回直接子项、递归统计与扩展名分布。path 默认为项目根，extension 可按扩展名过滤（如 dxf、pdf、zip）。回答“项目里有哪些文件/图纸/压缩包”前先调用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的目录路径，默认 "."' },
        extension: { type: 'string', description: '只统计某扩展名，例如 dxf' },
        limit: { type: 'number', description: '返回条目上限，默认 200，最大 1000' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const root = deps.getRoot()
      if (!root) {
        return failure(NO_PROJECT)
      }
      const args = (params ?? {}) as { path?: string; extension?: string; limit?: number }
      try {
        const target = args.path?.trim() || '.'
        resolveProjectPath(root, target)
        const result = await deps.sidecar.scanProject(root, target, {
          ...(args.extension ? { extension: args.extension } : {}),
          ...(args.limit ? { limit: args.limit } : {})
        })
        const entries = result.entries.slice(0, MAX_SCAN_ENTRIES_IN_TOOL)
        return success({
          ...result,
          entries,
          ...(result.entries.length > MAX_SCAN_ENTRIES_IN_TOOL
            ? { omittedEntries: result.entries.length - MAX_SCAN_ENTRIES_IN_TOOL }
            : {})
        })
      } catch (error) {
        return failure(sidecarMessage(error))
      }
    }
  }
}

function listTool(deps: ProjectToolsDeps): AgentTool<any> {
  return {
    name: 'list_archive',
    label: '查看压缩包',
    description:
      '列出项目内 ZIP、TAR、TAR.GZ 压缩包的成员（不解压）。path 必须是相对项目根的压缩包路径。RAR/7z 暂不支持。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的压缩包路径，例如 资料/归档.zip' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const root = deps.getRoot()
      if (!root) {
        return failure(NO_PROJECT)
      }
      try {
        const path = requiredPath(params)
        resolveProjectPath(root, path)
        const result = await deps.sidecar.listArchive(root, path)
        const entries = result.entries.slice(0, MAX_ARCHIVE_ENTRIES_IN_TOOL)
        return success({
          ...result,
          entries,
          ...(result.entries.length > MAX_ARCHIVE_ENTRIES_IN_TOOL
            ? { omittedEntries: result.entries.length - MAX_ARCHIVE_ENTRIES_IN_TOOL }
            : {})
        })
      } catch (error) {
        return failure(sidecarMessage(error))
      }
    }
  }
}

function extractTool(deps: ProjectToolsDeps): AgentTool<any> {
  return {
    name: 'extract_archive',
    label: '解压压缩包',
    description:
      '把项目内压缩包解压到项目内目录。不覆盖已有文件：省略 target 时自动解压到包旁 <包名>_解压（重名追加 -2）；显式 target 已存在会失败，此时应向用户询问新目录名。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的压缩包路径' },
        target: { type: 'string', description: '相对项目根的目标目录，可省略' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const root = deps.getRoot()
      if (!root) {
        return failure(NO_PROJECT)
      }
      try {
        const args = (params ?? {}) as { path?: string; target?: string }
        const path = requiredPath(args)
        resolveProjectPath(root, path)
        if (args.target) {
          resolveProjectPath(root, args.target)
        }
        const result = await deps.sidecar.extractArchive(
          root,
          path,
          args.target?.trim() || undefined
        )
        return success(result)
      } catch (error) {
        return failure(sidecarMessage(error))
      }
    }
  }
}

function readTool(deps: ProjectToolsDeps): AgentTool<any> {
  return {
    name: 'read_file',
    label: '读取文件',
    description:
      '读取项目内文件内容：文本、PDF、DOCX 返回文字，DXF 返回图纸摘要，图片只返回元数据。path 必须是相对项目根的文件路径。回答文件内容前必须先调用，禁止臆测。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的文件路径' },
        maxChars: { type: 'number', description: '最多返回的字符数，默认 20000' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const root = deps.getRoot()
      if (!root) {
        return failure(NO_PROJECT)
      }
      try {
        const args = (params ?? {}) as { path?: string; maxChars?: number }
        const path = requiredPath(args)
        resolveProjectPath(root, path)
        const result = await deps.sidecar.readFile(
          root,
          path,
          typeof args.maxChars === 'number' ? args.maxChars : undefined
        )
        const content = result.content
        if (content === undefined || content.length <= MAX_CONTENT_CHARS_IN_TOOL) {
          return success(result)
        }
        return success({
          ...result,
          content: content.slice(0, MAX_CONTENT_CHARS_IN_TOOL),
          contentTruncated: true
        })
      } catch (error) {
        return failure(sidecarMessage(error))
      }
    }
  }
}

function openTool(deps: ProjectToolsDeps): AgentTool<any> {
  return {
    name: 'open_project_drawing',
    label: '打开项目图纸',
    description:
      '把项目内的 DXF/DWG 图纸切换为当前图纸（DWG 自动转换），随后可用 drawing_summary、search_entities 等读图工具分析。仅在用户要求查看或分析某张图纸时调用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的图纸路径' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const root = deps.getRoot()
      if (!root) {
        return failure(NO_PROJECT)
      }
      try {
        const path = requiredPath(params)
        const absolute = resolveProjectPath(root, path)
        const result = await deps.openDrawing(absolute)
        if (!result.ok) {
          return failure(result.error.message)
        }
        const drawing = result.drawing
        return success({
          name: drawing.name,
          path: relative(root, absolute).replace(/\\/g, '/'),
          entityCount: drawingEntityCount(drawing),
          layerCount: drawing.layers.length,
          summaryOnly: Boolean(drawing.summaryOnly),
          bounds: drawing.bounds
        })
      } catch (error) {
        return failure(sidecarMessage(error))
      }
    }
  }
}

export function formatAttachmentContext(prompt: string, attachments?: FileAttachment[]): string {
  if (!attachments?.length) {
    return prompt
  }
  const lines = attachments.map(
    (file) => `- ${file.path}（${ATTACHMENT_KIND_LABELS[file.kind]}，${formatSize(file.size)}）`
  )
  return [
    '用户附加的文件（相对项目根）：',
    ...lines,
    '需要内容时请调用工具读取，不要臆测文件内容。',
    '',
    prompt
  ].join('\n')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function requiredPath(params: unknown): string {
  const path = String((params as { path?: string })?.path ?? '').trim()
  if (!path) {
    throw new Error('缺少相对项目根的 path 参数')
  }
  return path
}

function sidecarMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^(handler_error|file_not_found|value_error):\s*/, '')
}
