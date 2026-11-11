import type { Agent, AgentTool } from '@earendil-works/pi-agent-core'
import type { Context, FauxProviderHandle, TranscriptContext } from '@earendil-works/pi-ai'
import { formatKbLocation } from '../../shared/location'
import { isLowConfidence } from '../../shared/protocol'
import type { KbHit } from '../../shared/protocol'
import { describeError, redactSecret } from '../model/errors'
import type { ModelRuntime } from '../model/runtime'
import type { StoredModelSettings } from '../model/settings'
import { lastAssistantTurn, lastToolResult } from './transcript'
import { failure, success } from './tool-result'

type AgentCoreModule = typeof import('@earendil-works/pi-agent-core')
type PiAiModule = typeof import('@earendil-works/pi-ai')

export const KB_TIMEOUT_MS = 45_000

export const KB_SYSTEM_PROMPT = `你是水利与市政工程规范知识库助手，只能通过 search_knowledge 工具检索本地知识库并依据检索结果回答。

规则：
1. 回答前必须调用 search_knowledge 检索；禁止编造规范条文、数值或图集编号。
2. 每条结论后标注出处，格式为【文件名·页码/段落/句柄/行号】。
3. 检索结果为空或与问题无关时，明确回答“知识库中没有检索到相关依据，依据不足”，不要猜测。
4. 用简洁的中文回答，先给结论，再列依据。
5. 来自视觉识别的片段若置信度低于 0.6，必须提示“低置信，需人工核对”，不得作为唯一依据。`

export interface KbAnswer {
  answer: string
  sources: KbHit[]
  error?: string
}

export interface KbAgentDeps {
  models: ModelRuntime
  getSettings: () => StoredModelSettings
  retrieve: (query: string, limit?: number) => Promise<KbHit[]>
  timeoutMs?: number
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

export class KbAgent {
  constructor(private readonly deps: KbAgentDeps) {}

  async ask(question: string): Promise<KbAnswer> {
    const [{ Agent }, resolved] = await Promise.all([
      loadAgentCore(),
      this.deps.models.resolveModel('kb')
    ])

    if (resolved.fakeHandle) {
      await this.scriptFake(resolved.fakeHandle, question)
    }

    const collected: KbHit[] = []
    const agent: Agent = new Agent({
      initialState: {
        systemPrompt: KB_SYSTEM_PROMPT,
        model: resolved.model,
        tools: [this.searchTool(collected)]
      },
      streamFn: (model, context, options) =>
        resolved.models.streamSimple(model, context as Context, options),
      getApiKey: () => {
        const settings = this.deps.getSettings()
        return settings.fakeMode ? undefined : settings.apiKey ?? undefined
      }
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      agent.abort()
    }, this.deps.timeoutMs ?? KB_TIMEOUT_MS)

    let failure: unknown = null
    try {
      await agent.prompt(question)
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
    }

    const final = lastAssistantTurn(agent.state.messages)
    const apiKey = this.deps.getSettings().apiKey
    const error = timedOut
      ? '知识库子 Agent 超时'
      : (final.error ? redactSecret(final.error, apiKey) : undefined) ??
        (failure ? redactSecret(describeError(failure), apiKey) : undefined)

    return {
      answer: final.text,
      sources: dedupe(collected),
      ...(error ? { error } : {})
    }
  }

  private searchTool(collected: KbHit[]): AgentTool<any> {
    return {
      name: 'search_knowledge',
      label: '检索知识库',
      description:
        '在本地知识库中检索工程规范、标准图集、设计说明与参数表，返回带文件名和位置（页码/段落/句柄/行号）的原文片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或问题' },
          limit: { type: 'number', description: '最多返回片段数，默认 5，最大 10' }
        },
        required: ['query'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params) => {
        const args = (params ?? {}) as { query?: string; limit?: number }
        const query = String(args.query ?? '').trim()
        if (!query) {
          return failure('检索关键词不能为空。')
        }
        const limit = clampLimit(args.limit)
        try {
          const hits = await this.deps.retrieve(query, limit)
          collected.push(...hits)
          return success({ query, total: hits.length, hits })
        } catch (error) {
          return failure(`知识库检索失败：${describeError(error)}`)
        }
      }
    }
  }

  private async scriptFake(handle: FauxProviderHandle, question: string): Promise<void> {
    const { fauxAssistantMessage, fauxToolCall } = await loadPiAi()
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall('search_knowledge', { query: question }), {
        stopReason: 'toolUse'
      }),
      (context) => fauxAssistantMessage(kbReply(context as TranscriptContext))
    ])
  }
}

interface KnowledgeData {
  hits?: KbHit[]
}

function kbReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as KnowledgeData | null
  if (!data || !Array.isArray(data.hits)) {
    return '知识库检索失败，无法给出带出处的结论，请稍后重试。'
  }
  if (data.hits.length === 0) {
    return '知识库中没有检索到与该问题相关的条款，依据不足，无法给出有依据的结论。'
  }
  const first = data.hits[0]
  const extra = data.hits.length > 1 ? `此外还有 ${data.hits.length - 1} 条相关片段。` : ''
  const caution = data.hits.every((hit) => isLowConfidence(hit))
    ? '（该结论来自低置信视觉识别，需人工核对，不能作为唯一依据）'
    : ''
  return `知识库检索到相关条款：${first.text}（出处：${first.docName}·${formatKbLocation(first.location)}）。${extra}${caution}`
}

function dedupe(hits: KbHit[]): KbHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.docId}|${JSON.stringify(hit.location)}|${hit.text}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 5
  }
  return Math.min(Math.max(Math.trunc(value), 1), 10)
}

