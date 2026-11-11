import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ModelSettings,
  ModelSettingsSave,
  PublicModelSettings
} from '../../shared/protocol'

export interface SecretCodec {
  isAvailable(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(cipher: Buffer): Promise<string>
}

export interface StoredModelSettings extends ModelSettings {
  apiKey: string | null
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super('系统凭据库不可用，无法安全保存 API Key')
  }
}

export const DEFAULT_SETTINGS: ModelSettings = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  fakeMode: false
}

interface SettingsFile extends ModelSettings {
  version: 1
  apiKeyCipher: string | null
}

export class SettingsStore {
  private active: StoredModelSettings | null = null

  constructor(private readonly options: { filePath: string; codec: SecretCodec }) {}

  async init(): Promise<void> {
    let file: Partial<SettingsFile> = {}
    try {
      file = JSON.parse(await readFile(this.options.filePath, 'utf8')) as Partial<SettingsFile>
    } catch {
      file = {}
    }

    const available = await this.options.codec.isAvailable()
    this.active = {
      provider: typeof file.provider === 'string' && file.provider ? file.provider : DEFAULT_SETTINGS.provider,
      model: typeof file.model === 'string' && file.model ? file.model : DEFAULT_SETTINGS.model,
      fakeMode: file.fakeMode === true,
      apiKey: await this.decrypt(file.apiKeyCipher, available)
    }
  }

  getActive(): StoredModelSettings {
    if (!this.active) {
      throw new Error('settings store is not initialized')
    }
    return this.active
  }

  async getPublic(): Promise<PublicModelSettings> {
    const active = this.getActive()
    return {
      provider: active.provider,
      model: active.model,
      fakeMode: active.fakeMode,
      hasApiKey: Boolean(active.apiKey),
      secretStorage: (await this.options.codec.isAvailable()) ? 'os' : 'unavailable'
    }
  }

  async save(input: ModelSettingsSave): Promise<PublicModelSettings> {
    const current = this.getActive()
    const available = await this.options.codec.isAvailable()
    let apiKey = current.apiKey

    if (input.apiKey !== undefined) {
      if (!input.apiKey) {
        apiKey = null
      } else {
        if (!available) {
          throw new SecretStorageUnavailableError()
        }
        apiKey = input.apiKey
      }
    }

    this.active = {
      provider: input.provider,
      model: input.model,
      fakeMode: input.fakeMode,
      apiKey
    }

    const cipher =
      apiKey && available ? (await this.options.codec.encrypt(apiKey)).toString('base64') : null

    const file: SettingsFile = {
      version: 1,
      provider: this.active.provider,
      model: this.active.model,
      fakeMode: this.active.fakeMode,
      apiKeyCipher: cipher
    }

    await mkdir(dirname(this.options.filePath), { recursive: true })
    await writeFile(this.options.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')

    return this.getPublic()
  }

  private async decrypt(cipher: string | null | undefined, available: boolean): Promise<string | null> {
    if (typeof cipher !== 'string' || !cipher || !available) {
      return null
    }
    try {
      return await this.options.codec.decrypt(Buffer.from(cipher, 'base64'))
    } catch {
      return null
    }
  }
}
