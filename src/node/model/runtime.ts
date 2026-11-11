import type {
  AssistantMessage,
  Context,
  FauxProviderHandle,
  Model,
  Models,
  MutableModels
} from '@earendil-works/pi-ai'
import type { ConnectionTestResult, ModelProvider } from '../../shared/protocol'
import { classifyModelError } from './errors'
import type { StoredModelSettings } from './settings'

export const FAKE_REPLY = '这是假模型的固定回复。'

export interface CompleteOptions {
  image?: { data: string; mimeType: string }
  lane?: string
  fakeReply?: string
}

export interface ResolvedModel {
  models: Models
  model: Model<any>
  fakeHandle?: FauxProviderHandle
}

type PiAiModule = typeof import('@earendil-works/pi-ai')

interface FakeSetup {
  handle: FauxProviderHandle
  models: MutableModels
}

export class ModelRuntime {
  private piAi: Promise<PiAiModule> | null = null
  private fakes = new Map<string, Promise<FakeSetup>>()
  private builtin: Promise<Models> | null = null

  constructor(private readonly getSettings: () => StoredModelSettings) {}

  async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
    const settings = this.getSettings()
    const content = options.image
      ? [
          { type: 'text' as const, text: prompt },
          { type: 'image' as const, data: options.image.data, mimeType: options.image.mimeType }
        ]
      : prompt
    const context: Context = {
      messages: [{ role: 'user', content, timestamp: Date.now() }]
    }

    if (settings.fakeMode) {
      const [{ handle, models }, { fauxAssistantMessage }] = await Promise.all([
        this.getFake(options.lane ?? 'main'),
        this.getPiAi()
      ])
      handle.setResponses([fauxAssistantMessage(options.fakeReply ?? FAKE_REPLY)])
      const reply = await models.complete(handle.getModel(), context)
      return extractText(reply) || options.fakeReply || FAKE_REPLY
    }

    if (!settings.apiKey) {
      throw new Error('尚未配置 API Key')
    }

    const models = await this.getBuiltinModels()
    const model = models.getModel(settings.provider, settings.model)
    if (!model) {
      throw new Error(`未找到模型 ${settings.provider}/${settings.model}`)
    }

    const reply = await models.complete(model, context, { apiKey: settings.apiKey })
    const text = extractText(reply)
    if (!text && reply.errorMessage) {
      throw new Error(reply.errorMessage)
    }
    return text
  }

  async resolveModel(lane = 'main'): Promise<ResolvedModel> {
    const settings = this.getSettings()

    if (settings.fakeMode) {
      const { handle, models } = await this.getFake(lane)
      return { models, model: handle.getModel(), fakeHandle: handle }
    }

    if (!settings.apiKey) {
      throw new Error('尚未配置 API Key')
    }

    const models = await this.getBuiltinModels()
    const model = models.getModel(settings.provider, settings.model)
    if (!model) {
      throw new Error(`未找到模型 ${settings.provider}/${settings.model}`)
    }
    return { models, model }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const settings = this.getSettings()

    if (!settings.fakeMode && !settings.apiKey) {
      return { ok: false, kind: 'auth', message: '鉴权失败：尚未配置 API Key' }
    }

    try {
      await this.complete('这是一次连接测试。')
      return {
        ok: true,
        message: settings.fakeMode
          ? '连接成功（假模型，固定回复）'
          : `连接成功（${settings.provider}/${settings.model}）`
      }
    } catch (error) {
      const classified = classifyModelError(error, settings.apiKey)
      return { ok: false, kind: classified.kind, message: classified.message }
    }
  }

  async listProviders(): Promise<ModelProvider[]> {
    const models = await this.getBuiltinModels()
    return models
      .getProviders()
      .map((provider) => ({ id: provider.id, name: provider.name ?? provider.id }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async listModels(provider: string): Promise<string[]> {
    const models = await this.getBuiltinModels()
    return models
      .getModels(provider)
      .map((model) => model.id)
      .sort((left, right) => left.localeCompare(right))
  }

  private getPiAi(): Promise<PiAiModule> {
    this.piAi ??= import('@earendil-works/pi-ai')
    return this.piAi
  }

  private getFake(lane: string): Promise<FakeSetup> {
    const cached = this.fakes.get(lane)
    if (cached) {
      return cached
    }
    const setup = (async () => {
      const { createModels, fauxProvider } = await this.getPiAi()
      const handle = fauxProvider({
        provider: `cad-fake-${lane}`,
        models: [{ id: 'fake-1', name: '假模型' }],
        tokensPerSecond: 200
      })
      const models = createModels()
      models.setProvider(handle.provider)
      return { handle, models }
    })()
    this.fakes.set(lane, setup)
    return setup
  }

  private getBuiltinModels(): Promise<Models> {
    this.builtin ??= import('@earendil-works/pi-ai/providers/all').then((module) =>
      module.builtinModels()
    )
    return this.builtin
  }
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}
