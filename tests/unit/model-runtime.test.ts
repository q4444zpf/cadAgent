import { describe, expect, it } from 'vitest'
import { ModelRuntime, FAKE_REPLY } from '../../src/node/model/runtime'
import type { StoredModelSettings } from '../../src/node/model/settings'

function runtimeWith(settings: StoredModelSettings): ModelRuntime {
  return new ModelRuntime(() => settings)
}

describe('model runtime', () => {
  it('returns the fixed reply in fake mode, every time', async () => {
    const runtime = runtimeWith({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: true,
      apiKey: null
    })

    expect(await runtime.complete('第一问')).toBe(FAKE_REPLY)
    expect(await runtime.complete('第二问')).toBe(FAKE_REPLY)
  })

  it('reports a successful connection in fake mode', async () => {
    const runtime = runtimeWith({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: true,
      apiKey: null
    })

    const result = await runtime.testConnection()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toContain('连接成功')
    }
  })

  it('reports a missing api key as an authentication problem', async () => {
    const runtime = runtimeWith({
      provider: 'deepseek',
      model: 'deepseek-flash',
      fakeMode: false,
      apiKey: null
    })

    const result = await runtime.testConnection()

    expect(result).toEqual({
      ok: false,
      kind: 'auth',
      message: '鉴权失败：尚未配置 API Key'
    })
  })
})
