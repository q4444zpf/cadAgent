import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { TranscriptContext } from '@earendil-works/pi-ai'

export interface AssistantTurn {
  text: string
  aborted: boolean
  error?: string
}

export function lastAssistantTurn(messages: AgentMessage[]): AssistantTurn {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    return {
      text,
      aborted: message.stopReason === 'aborted',
      error:
        message.stopReason === 'error' ? message.errorMessage ?? '模型调用失败' : undefined
    }
  }
  return { text: '', aborted: false }
}

export function lastToolResult(context: TranscriptContext): unknown {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]
    if (message.role !== 'toolResult') {
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return null
}
