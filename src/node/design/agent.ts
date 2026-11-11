import { randomUUID } from 'node:crypto'
import type { Agent, AgentTool } from '@earendil-works/pi-agent-core'
import type {
  Context,
  FauxProviderHandle,
  JsonObject,
  TranscriptContext
} from '@earendil-works/pi-ai'
import { formatKbLocation } from '../../shared/location'
import { ParameterListSchema } from '../../shared/protocol'
import type { KbHit, ParameterList } from '../../shared/protocol'
import { describeError, redactSecret } from '../model/errors'
import type { ModelRuntime } from '../model/runtime'
import type { StoredModelSettings } from '../model/settings'
import { createKnowledgeTool } from '../agent/knowledge-tools'
import type { KbAnswer } from '../agent/kb-agent'
import { lastAssistantTurn, lastToolResult } from '../agent/transcript'
import { failure, success } from '../agent/tool-result'

type AgentCoreModule = typeof import('@earendil-works/pi-agent-core')
type PiAiModule = typeof import('@earendil-works/pi-ai')

export const DESIGN_TIMEOUT_MS = 120_000

export const DESIGN_SYSTEM_PROMPT = `你是水利与市政工程 CAD 生成助手，负责把用户的自然语言生成需求整理成可确认的参数清单。

规则：
1. 涉及规范、标准、图集或设计参数时，必须先调用 ask_knowledge 查证，并保留出处。
2. 只通过 propose_parameters 提交参数清单；每项参数包含名称、取值、单位、依据，无依据的参数必须标为假设（assumed=true）。
3. 禁止直接生成、保存或修改任何 DXF 文件；是否生成由用户在界面上确认。
4. 参数不完整或存在冲突时，在 summary 中列出待确认项，不得编造数值。
5. 用简洁中文说明参数清单与主要假设。`

export interface DesignAgentDeps {
  models: ModelRuntime
  getSettings: () => StoredModelSettings
  knowledge?: (question: string) => Promise<KbAnswer>
  timeoutMs?: number
}

export interface DesignProposalOutcome {
  list?: ParameterList
  text: string
  aborted: boolean
  sources: KbHit[]
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

export function buildParameterList(input: unknown): ParameterList {
  const raw = (input ?? {}) as Record<string, unknown>
  const items = Array.isArray(raw.parameters) ? raw.parameters : []
  if (items.length === 0) {
    throw new Error('参数清单至少需要一项参数')
  }

  const parameters = items.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>
    const name = String(record.name ?? '').trim()
    if (!name) {
      throw new Error(`第 ${index + 1} 项参数缺少名称`)
    }
    const value = String(record.value ?? '').trim()
    if (!value) {
      throw new Error(`参数「${name}」缺少取值`)
    }
    const basis = String(record.basis ?? '').trim()
    const assumed = record.assumed === true
    if (!basis && !assumed) {
      throw new Error(`参数「${name}」缺少依据，也未标记为假设`)
    }
    return {
      id: String(record.id ?? '').trim() || `p${index + 1}`,
      name,
      value,
      unit: String(record.unit ?? '').trim(),
      basis,
      assumed
    }
  })

  return ParameterListSchema.parse({
    id: `param-${randomUUID()}`,
    title: String(raw.title ?? '').trim() || '生成参数清单',
    drawingType: String(raw.drawingType ?? '').trim() || '未指定图型',
    summary: String(raw.summary ?? '').trim(),
    parameters
  })
}

export class DesignAgent {
  private current: Agent | null = null
  private abortRequested = false

  constructor(private readonly deps: DesignAgentDeps) {}

  abort(): boolean {
    if (!this.current) {
      return false
    }
    this.abortRequested = true
    this.current.abort()
    return true
  }

  async propose(prompt: string): Promise<DesignProposalOutcome> {
    if (this.current) {
      throw new Error('上一份参数清单尚未整理完成，请先停止。')
    }

    const [{ Agent }, resolved] = await Promise.all([
      loadAgentCore(),
      this.deps.models.resolveModel()
    ])

    if (resolved.fakeHandle) {
      await this.scriptFake(resolved.fakeHandle)
    }

    const sources: KbHit[] = []
    let proposed: ParameterList | null = null
    const tools: AgentTool<any>[] = []
    const knowledge = this.deps.knowledge
    if (knowledge) {
      tools.push(
        createKnowledgeTool(knowledge, (next) => {
          sources.splice(0, sources.length, ...next)
        })
      )
    }
    tools.push(this.proposeTool((list) => (proposed = list)))

    const agent: Agent = new Agent({
      initialState: {
        systemPrompt: DESIGN_SYSTEM_PROMPT,
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
    const timer = setTimeout(() => {
      this.abortRequested = true
      agent.abort()
    }, this.deps.timeoutMs ?? DESIGN_TIMEOUT_MS)

    let failureCause: unknown = null
    try {
      await agent.prompt(prompt)
    } catch (error) {
      failureCause = error
    } finally {
      clearTimeout(timer)
      this.current = null
    }

    const final = lastAssistantTurn(agent.state.messages)
    const apiKey = this.deps.getSettings().apiKey
    let error =
      (final.error ? redactSecret(final.error, apiKey) : undefined) ??
      (failureCause ? redactSecret(describeError(failureCause), apiKey) : undefined)
    if (!proposed && !error) {
      error = '模型未提交参数清单。'
    }

    return {
      text: final.text,
      aborted: this.abortRequested || final.aborted,
      sources: dedupe(sources),
      ...(proposed ? { list: proposed } : {}),
      ...(error ? { error } : {})
    }
  }

  private proposeTool(onProposal: (list: ParameterList) => void): AgentTool<any> {
    return {
      name: 'propose_parameters',
      label: '提交参数清单',
      description:
        '把整理好的生成参数提交给界面供用户确认。每项参数包含名称、取值、单位与依据；没有依据的参数必须标为假设。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '参数清单标题' },
          drawingType: { type: 'string', description: '图型名称，例如排水沟' },
          summary: { type: 'string', description: '补充说明与待确认项' },
          parameters: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '参数稳定标识，可省略' },
                name: { type: 'string', description: '参数名称' },
                value: { type: 'string', description: '参数取值' },
                unit: { type: 'string', description: '单位' },
                basis: { type: 'string', description: '依据，例如规范文件名·页码' },
                assumed: { type: 'boolean', description: '是否为无依据的假设值' }
              },
              required: ['name', 'value'],
              additionalProperties: false
            }
          }
        },
        required: ['title', 'drawingType', 'parameters'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params) => {
        try {
          const list = buildParameterList(params)
          onProposal(list)
          return success({ list })
        } catch (error) {
          return failure(describeError(error))
        }
      }
    }
  }

  private async scriptFake(handle: FauxProviderHandle): Promise<void> {
    const { fauxAssistantMessage, fauxToolCall } = await loadPiAi()
    handle.setResponses([
      fauxAssistantMessage(
        fauxToolCall('ask_knowledge', {
          question: '排水沟断面设计参数：净宽、壁厚、纵坡与盖板厚度'
        }),
        { stopReason: 'toolUse' }
      ),
      (context) =>
        fauxAssistantMessage(fauxToolCall('propose_parameters', proposalFrom(context as TranscriptContext)), {
          stopReason: 'toolUse'
        }),
      (context) => fauxAssistantMessage(designReply(context as TranscriptContext))
    ])
  }
}

interface KnowledgeData {
  sources?: KbHit[]
}

interface ProposalData {
  list?: ParameterList
}

function proposalFrom(context: TranscriptContext): JsonObject {
  const knowledge = lastToolResult(context) as KnowledgeData | null
  const first = knowledge?.sources?.[0]
  const basis = first ? `${first.docName}·${formatKbLocation(first.location)}` : ''
  const assumed = !first
  const fallback = '假设：知识库暂无直接依据，需设计人员确认'
  return {
    title: '排水沟典型断面',
    drawingType: '排水沟',
    summary: '依据知识库检索结果整理净宽、壁厚与纵坡；盖板厚度为假设值，需结构校核。',
    parameters: [
      { id: 'width', name: '净宽', value: '600', unit: 'mm', basis: basis || fallback, assumed },
      { id: 'wall', name: '壁厚', value: '100', unit: 'mm', basis: basis || fallback, assumed },
      {
        id: 'slope',
        name: '沟底纵坡',
        value: '0.3',
        unit: '%',
        basis: basis || fallback,
        assumed
      },
      {
        id: 'cover',
        name: '盖板厚度',
        value: '100',
        unit: 'mm',
        basis: '假设：按常规构造取值，待结构校核',
        assumed: true
      }
    ]
  }
}

function designReply(context: TranscriptContext): string {
  const data = lastToolResult(context) as ProposalData | null
  const list = data?.list
  if (!list) {
    return '假模型回答：未能整理参数清单，请补充生成需求后重试。'
  }
  const assumed = list.parameters.filter((parameter) => parameter.assumed).length
  const suffix = assumed > 0 ? `，其中 ${assumed} 项为假设` : ''
  return `假模型回答：已整理「${list.title}」的 ${list.parameters.length} 项参数${suffix}。请核对参数并确认后再生成。`
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
