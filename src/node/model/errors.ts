export type ModelErrorKind = 'auth' | 'network' | 'unknown'

export interface ClassifiedModelError {
  kind: ModelErrorKind
  message: string
}

const AUTH_PATTERN =
  /\b401\b|\b403\b|\bauth\b|\boauth\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|invalid token|api key/i
const NETWORK_PATTERN =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|UND_ERR|fetch failed|network error|socket hang up|certificate|self[- ]signed|getaddrinfo/i

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function redactSecret(text: string, secret?: string | null): string {
  if (!secret) {
    return text
  }
  return text.split(secret).join('***')
}

export function classifyModelError(error: unknown, secret?: string | null): ClassifiedModelError {
  const detail = redactSecret(collectDetail(error), secret)

  if (AUTH_PATTERN.test(detail)) {
    return { kind: 'auth', message: `鉴权失败：API Key 无效或无权限（${detail}）` }
  }
  if (NETWORK_PATTERN.test(detail)) {
    return { kind: 'network', message: `网络错误：无法连接到模型服务（${detail}）` }
  }
  return { kind: 'unknown', message: `连接失败：${detail}` }
}

function collectDetail(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error

  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error) {
      if (current.message) {
        parts.push(current.message)
      }
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string' && code && !parts.includes(code)) {
        parts.push(code)
      }
      current = (current as { cause?: unknown }).cause
    } else {
      parts.push(String(current))
      break
    }
  }

  return parts.join(' / ') || '未知错误'
}
