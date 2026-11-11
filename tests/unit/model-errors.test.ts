import { describe, expect, it } from 'vitest'
import { classifyModelError } from '../../src/node/model/errors'

describe('model error classification', () => {
  it('classifies authentication failures', () => {
    const result = classifyModelError(new Error('401 Unauthorized'))

    expect(result.kind).toBe('auth')
    expect(result.message).toContain('鉴权失败')
    expect(result.message).toContain('401 Unauthorized')
  })

  it('classifies network failures from nested causes', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
        code: 'ENOTFOUND'
      })
    })

    const result = classifyModelError(error)

    expect(result.kind).toBe('network')
    expect(result.message).toContain('网络错误')
    expect(result.message).toContain('ENOTFOUND')
  })

  it('redacts the api key from reported messages', () => {
    const result = classifyModelError(
      new Error('invalid api key: sk-live-12345 (401)'),
      'sk-live-12345'
    )

    expect(result.message).not.toContain('sk-live-12345')
    expect(result.message).toContain('***')
  })

  it('keeps unknown failures readable', () => {
    const result = classifyModelError(new Error('something odd happened'))

    expect(result.kind).toBe('unknown')
    expect(result.message).toContain('something odd happened')
  })
})
