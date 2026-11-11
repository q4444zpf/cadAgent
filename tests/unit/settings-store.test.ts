import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SecretStorageUnavailableError,
  SettingsStore,
  type SecretCodec
} from '../../src/node/model/settings'

function testCodec(available = true): SecretCodec {
  return {
    isAvailable: async () => available,
    encrypt: async (plain) =>
      Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: async (cipher) => {
      const text = cipher.toString('utf8')
      if (!text.startsWith('enc:')) {
        throw new Error('bad cipher')
      }
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    }
  }
}

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cad-settings-'))
  filePath = join(dir, 'settings.json')
})

describe('settings store', () => {
  it('persists model settings and decrypts the api key on reload', async () => {
    const store = new SettingsStore({ filePath, codec: testCodec() })
    await store.init()
    await store.save({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: false,
      apiKey: 'sk-test-secret'
    })

    const reloaded = new SettingsStore({ filePath, codec: testCodec() })
    await reloaded.init()

    expect(reloaded.getActive()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: false,
      apiKey: 'sk-test-secret'
    })
  })

  it('never writes the api key in plaintext', async () => {
    const store = new SettingsStore({ filePath, codec: testCodec() })
    await store.init()
    await store.save({
      provider: 'openai',
      model: 'gpt-4.1',
      fakeMode: false,
      apiKey: 'sk-test-secret'
    })

    const raw = await readFile(filePath, 'utf8')

    expect(raw).toContain('openai')
    expect(raw).not.toContain('sk-test-secret')
  })

  it('exposes public settings without the key', async () => {
    const store = new SettingsStore({ filePath, codec: testCodec() })
    await store.init()
    const publicSettings = await store.save({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      fakeMode: true,
      apiKey: 'sk-test-secret'
    })

    expect(publicSettings).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      fakeMode: true,
      hasApiKey: true,
      secretStorage: 'os'
    })
    expect(publicSettings).not.toHaveProperty('apiKey')
  })

  it('keeps the stored key when saving without a new one and clears it when null', async () => {
    const store = new SettingsStore({ filePath, codec: testCodec() })
    await store.init()
    await store.save({ provider: 'deepseek', model: 'deepseek-flash', fakeMode: false, apiKey: 'sk-1' })

    await store.save({ provider: 'deepseek', model: 'deepseek-v4-pro', fakeMode: false })
    expect(store.getActive().apiKey).toBe('sk-1')

    const cleared = await store.save({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      fakeMode: false,
      apiKey: null
    })
    expect(store.getActive().apiKey).toBeNull()
    expect(cleared.hasApiKey).toBe(false)
  })

  it('refuses to persist a key when os encryption is unavailable', async () => {
    const store = new SettingsStore({ filePath, codec: testCodec(false) })
    await store.init()

    await expect(
      store.save({ provider: 'deepseek', model: 'deepseek-flash', fakeMode: false, apiKey: 'sk-1' })
    ).rejects.toBeInstanceOf(SecretStorageUnavailableError)

    const saved = await store.save({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: true
    })
    expect(saved.secretStorage).toBe('unavailable')
    expect(saved.hasApiKey).toBe(false)
  })

  it('falls back to defaults when the settings file is corrupt', async () => {
    await writeFile(filePath, '{ not json', 'utf8')
    const store = new SettingsStore({ filePath, codec: testCodec() })
    await store.init()

    expect(store.getActive()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: false,
      apiKey: null
    })
  })
})
