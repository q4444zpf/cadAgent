import type { Agent, AgentTool } from '@earendil-works/pi-agent-core'
import type { Context, FauxProviderHandle, TranscriptContext } from '@earendil-works/pi-ai'
import type { AgentAsk, AgentStreamEvent, Drawing, EntityReference, KbHit } from '../../shared/protocol'
import { describeError, redactSecret } from '../model/errors'
import type { ModelRuntime } from '../model/runtime'
import type { StoredModelSettings } from '../model/settings'
import type { KbAnswer } from './kb-agent'
import { createKnowledgeTool } from './knowledge-tools'
import { formatAttachmentContext } from './project-tools'
import { createDrawingTools } from './reading-tools'
import { extractReferences } from './references'
import { lastAssistantTurn, lastToolResult } from './transcript'

type AgentCoreModule = typeof import('@earendil-works/pi-agent-core')
type PiAiModule = typeof import('@earendil-works/pi-ai')

export const QA_TIMEOUT_MS = 120_000

export const SYSTEM_PROMPT = `你是水利与市政工程 CAD 图纸阅读助手，可以通过工具读取当前打开的 DXF 图纸，也可以处理项目文件夹内的文件。

规则：
1. 只依据工具返回的数据回答，禁止编造图纸中不存在的图层、实体、尺寸或文字。
2. 回答数量、图层名、坐标或文字内容前，必须调用工具核实；数据不足时明确说明“图纸中未找到……”或“无法确定”。
3. 引用具体实体时使用 #句柄 形式，例如 #A1。
4. 用简洁的中文回答，先给结论，再给依据。
5. 涉及规范、标准、图集或设计参数要求的问题，先调用 ask_knowledge；引用其结论时保留出处。
6. 不讨论与当前图纸无关的话题。
7. 处理项目内文件时，先用 scan_project 了解目录与文件；读取文件内容用 read_file，查看压缩包用 list_archive，解压用 extract_archive。路径一律使用相对项目根的路径。
8. 未调用工具不得声称看过文件内容；文件读取结果被截断时说明只看到部分内容。
9. 解压永远不会覆盖已有文件；显式目标已存在时向用户询问新的目录名。RAR/7z 暂不支持，请让用户先手动解压。
10. 用户要求查看或分析项目内某张图纸时，先调用 open_project_drawing 切换当前图纸，再用读图工具核实。`

export interface QaAgentDeps {
  models: ModelRuntime
  getSettings: () => StoredModelSettings
  getDrawing: () => Drawing | null
  knowledge?: (question: string) => Promise<KbAnswer>
  createProjectTools?: () => AgentTool<any>[]
  timeoutMs?: number
}

export interface AskOutcome {
  text: string
  aborted: boolean
  sources: KbHit[]
  references: EntityReference[]
  error?: string
}

let agentCore: Promise<AgentCoreModule> | null = null
let piAi: Promise<PiAiModule> | null = null

function loadAgentCore(): Promise<AgentCoreModule> {
  agentCore ??= import('@earendil-works/pi-agent-core')
  return agentCore
}

function loadPiAi(): Promise<PiAiModule> {
  piAi ??= import('@earendil-works/pi-ai')
  return piAi
}

export class QaAgent {
  private current: Agent | null = null
  private abortRequested = false

  constructor(private readonly deps: QaAgentDeps) {}

  abort(): boolean {
    if (!this.current) {
      return false
    }
    this.abortRequested = true
    this.current.abort()
    return true
  }

  async ask(
    input: AgentAsk,
    emit: (event: AgentStreamEvent) => void
  ): Promise<AskOutcome> {
    if (this.current) {
      throw new Error('上一条回答尚未结束，请先停止。')
    }

    const [{ Agent }, resolved] = await Promise.all([
      loadAgentCore(),
      this.deps.models.resolveModel()
    ])

    if (resolved.fakeHandle) {
      await this.scriptFake(resolved.fakeHandle, input.prompt)
    }

    const sources: KbHit[] = []
    const tools = createDrawingTools(this.deps.getDrawing)
    tools.push(...(this.deps.createProjectTools?.() ?? []))
    const knowledge = this.deps.knowledge
    if (knowledge) {
      tools.push(
        createKnowledgeTool(knowledge, (next) => {
          sources.splice(0, sources.length, ...next)
        })
      )
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: resolved.model,
        tools
      },
      streamFn: (model, context, options) =>
        resolved.models.streamSimple(model, context as Context, options),
      getApiKey: () => {
        const settings = this.deps.getSettings()
        return settings.fakeMode ? undefined : settings.apiKey ?? undefined
      }
    })

    this.current = agent
    this.abortRequested = false
    const requestId = input.requestId
    let streamed = ''

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update') {
        if (event.assistantMessageEvent.type === 'text_delta') {
          streamed += event.assistantMessageEvent.delta
          emit({
            type: 'text_delta',
            requestId,
            delta: event.assistantMessageEvent.delta
          })
        }
        return
      }
      if (event.type === 'tool_execution_start') {
        emit({
          type: 'tool_start',
          requestId,
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args
        })
        return
      }
      if (event.type === 'tool_execution_end') {
        emit({
          type: 'tool_end',
          requestId,
          callId: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          output: toolOutput(event.result),
          durationMs: event.durationMs
        })
      }
    })

    const timer = setTimeout(() => {
      this.abortRequested = true
      agent.abort()
    }, this.deps.timeoutMs ?? QA_TIMEOUT_MS)

    let failure: unknown = null
    try {
      await agent.prompt(formatAttachmentContext(input.prompt, input.attachments))
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
      unsubscribe()
      this.current = null
    }

    const final = lastAssistantTurn(agent.state.messages)
    const text = final.text || streamed
    const apiKey = this.deps.getSettings().apiKey
    const error =
      (final.error ? redactSecret(final.error, apiKey) : undefined) ??
      (failure ? redactSecret(describeError(failure), apiKey) : undefined)
    const aborted = this.abortRequested || final.aborted
    const references = extractReferences(text, this.deps.getDrawing())

    emit({
      type: 'run_end',
      requestId,
      text,
      aborted,
      references,
      ...(sources.length ? { sources } : {}),
      ...(error ? { error } : {})
    })

    return {
      text,
      aborted,
      sources: dedupeSources(sources),
      references,
      ...(error ? { error } : {})
    }
  }

  private async scriptFake(handle: FauxProviderHandle, prompt: string): Promise<void> {
    const { fauxAssistantMessage, fauxToolCall } = await loadPiAi()

    if (this.deps.createProjectTools && PROJECT_HINT.test(prompt)) {
      const archive = prompt.match(/[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*\.(?:tar\.gz|tgz|zip|tar)/i)?.[0]
      if (/解压/.test(prompt) && archive) {
        handle.setResponses([
          fauxAssistantMessage(fauxToolCall('extract_archive', { path: archive }), {
            stopReason: 'toolUse'
          }),
          (context) => fauxAssistantMessage(extractReply(context as TranscriptContext))
        ])
        return
      }
      const document = prompt.match(
        /[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*\.(?:pdf|docx|txt|md|csv|dxf)/i
      )?.[0]
      if (/读取|内容|说明/.test(prompt) && document) {
        handle.setResponses([
          fauxAssistantMessage(fauxToolCall('read_file', { path: document }), {
            stopReason: 'toolUse'
          }),
          (context) => fauxAssistantMessage(readReply(context as TranscriptContext))
        ])
        return
      }
      handle.setResponses([
        fauxAssistantMessage(fauxToolCall('scan_project', {}), { stopReason: 'toolUse' }),
        (context) => fauxAssistantMessage(scanReply(context as TranscriptContext))
      ])
      return
    }

    if (this.deps.knowledge && KNOWLEDGE_HINT.test(prompt)) {
      handle.setResponses([
        fauxAssistantMessage(fauxToolCall('ask_knowledge', { question: prompt }), {
          stopReason: 'toolUse'
        }),
        (context) => fauxAssistantMessage(knowledgeReply(context as TranscriptContext))
      ])
      return
    }

    if (!this.deps.getDrawing()) {
      handle.setResponses([
        fauxAssistantMessage('假模型回答：当前没有打开图纸，无法回答图纸问题。请先导入 DXF 文件。')
      ])
      return
    }

    const layer = this.matchLayer(prompt)
    const wantsText = /文字|标注|写了|内容|说明/.test(prompt)
    handle.setResponses([
      fauxAssistantMessage(
        layer
          ? fauxToolCall('search_entities', { layer })
          : wantsText
            ? fauxToolCall('search_entities', { kind: 'text' })
            : fauxToolCall('drawing_summary', {}),
        { stopReason: 'toolUse' }
      ),
      (context) =>
        fauxAssistantMessage(
          layer
            ? layerReply(context as TranscriptContext, layer)
            : wantsText
              ? textReply(context as TranscriptContext)
              : summaryReply(context as TranscriptContext)
        )
    ])
  }

  private matchLayer(prompt: string): string | null {
    const layers = this.deps.getDrawing()?.layers ?? []
    const lowered = prompt.toLowerCase()
    return (
      layers
        .map((layer) => layer.name)
        .filter((name) => name.length >= 2)
        .sort((left, right) => right.length - left.length)
        .find((name) => lowered.includes(name.toLowerCase())) ?? null
    )
  }
}

const KIND_LABELS: Record<string, string> = {
  line: '直线',
  polyline: '多段线',
  circle: '圆',
  arc: '圆弧',
  text: '文字'
}

const KNOWLEDGE_HINT = /规范|标准|图集|条文|要求|规定|做法/
const PROJECT_HINT = /项目|文件夹|压缩包|解压|扫描/

function toolOutput(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}

function dedupeSources(sources: KbHit[]): KbHit[] {
  const seen = new Set<string>()
  return sources.filter((hit) => {
    const key = `${hit.docId}|${JSON.stringify(hit.location)}|${hit.text}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

interface KnowledgeData {
  answer?: string
  sources?: KbHit[]
}function knowledgeReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as KnowledgeData | null
  if (!data || typeof data.answer !== 'string') {
    return '假模型回答：知识库子 Agent 调用失败，无法给出带出处的结论。'
  }
  const count = (data.sources ?? []).length
  const suffix = count > 0 ? `（共 ${count} 条出处，可在下方展开查看原文）` : ''
  return `假模型回答：${data.answer}${suffix}`
}

interface SummaryData {
  entityCount?: number
  layerCount?: number
  kindCounts?: Record<string, number>
  layers?: { name?: string }[]
}

interface ScanData {
  totals?: { files?: number; dirs?: number; archives?: number }
  entries?: { name?: string }[]
}

function scanReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as ScanData | null
  if (!data?.totals) {
    return '假模型回答：无法读取项目扫描结果。'
  }
  const names = (data.entries ?? [])
    .map((entry) => entry.name)
    .filter(Boolean)
    .slice(0, 10)
    .join('、')
  return `假模型回答：项目内共 ${data.totals.files ?? 0} 个文件、${data.totals.dirs ?? 0} 个目录、${data.totals.archives ?? 0} 个压缩包${names ? `。直接子项：${names}` : ''}。`
}

interface ExtractData {
  target?: string
  filesExtracted?: number
}

function extractReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as ExtractData | null
  if (!data?.target) {
    return '假模型回答：解压失败，未返回目标目录。'
  }
  return `假模型回答：已解压到「${data.target}」，共 ${data.filesExtracted ?? 0} 个文件。`
}

interface ReadData {
  path?: string
  kind?: string
  content?: string
  truncated?: boolean
}

function readReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as ReadData | null
  if (!data?.path) {
    return '假模型回答：无法读取文件内容。'
  }
  const content = (data.content ?? '').slice(0, 300)
  return `假模型回答：文件「${data.path}」（${data.kind ?? '未知'}）内容：${content}${data.truncated ? '…（已截断）' : ''}`
}

function summaryReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as SummaryData | null
  if (!data || typeof data.entityCount !== 'number') {
    return '假模型回答：无法从图纸工具结果中读取摘要信息。'
  }
  const kinds = Object.entries(data.kindCounts ?? {})
    .map(([kind, count]) => `${KIND_LABELS[kind] ?? kind} ${count}`)
    .join('、')
  const layers = (data.layers ?? [])
    .map((layer) => layer.name)
    .filter((name): name is string => Boolean(name))
    .join('、')
  return `假模型回答：这张图纸共 ${data.entityCount} 个实体、${data.layerCount ?? 0} 个图层。实体构成：${kinds || '无'}。图层：${layers || '无'}。`
}

interface TextData {
  total?: number
  entities?: { handle?: string; text?: string }[]
}

interface LayerData {
  layer?: string
  total?: number
  returned?: number
  entities?: { kind?: string; handle?: string }[]
}

function layerReply(context: TranscriptContext, layer: string): string {
  const data = lastToolResult(context) as LayerData | null
  if (!data) {
    return `假模型回答：无法从图纸工具结果中读取图层「${layer}」的信息。`
  }
  const total = data.total ?? data.returned ?? (data.entities ?? []).length
  const items = (data.entities ?? [])
    .map((entity) => `${KIND_LABELS[entity.kind ?? ''] ?? entity.kind ?? '实体'} #${entity.handle}`)
    .join('、')
  return `假模型回答：图层「${layer}」共有 ${total} 个实体${items ? `：${items}。` : '。'}`
}

function textReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as TextData | null
  if (!data) {
    return '假模型回答：无法从图纸工具结果中读取文字信息。'
  }
  const items = (data.entities ?? [])
    .filter((entity) => entity.text)
    .map((entity) => `「${entity.text}」(#${entity.handle})`)
    .join('；')
  const total = data.total ?? (data.entities ?? []).length
  return `假模型回答：图纸中共有 ${total} 条文字${items ? `：${items}。` : '。'}`
}
