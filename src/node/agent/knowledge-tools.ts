import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { KbHit } from '../../shared/protocol'
import { describeError } from '../model/errors'
import type { KbAnswer } from './kb-agent'
import { failure, success } from './tool-result'

export function createKnowledgeTool(
  askKnowledge: (question: string) => Promise<KbAnswer>,
  onSources: (sources: KbHit[]) => void
): AgentTool<any> {
  return {
    name: 'ask_knowledge',
    label: '知识库问答',
    description:
      '当问题涉及工程规范、标准图集、设计参数或做法要求时调用。由独立的知识库子 Agent 检索本地资料，返回带出处（文件名与页码/段落/句柄/行号）的结论；无命中时会明确说明依据不足。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要查证的问题，尽量包含关键参数、构件名称或做法'
        }
      },
      required: ['question'],
      additionalProperties: false
    },
    execute: async (_toolCallId, params) => {
      const question = String((params as { question?: string })?.question ?? '').trim()
      if (!question) {
        return failure('缺少要检索的问题。')
      }
      try {
        const result = await askKnowledge(question)
        onSources(result.sources)
        if (result.error) {
          return failure(`知识库子 Agent 失败：${result.error}`)
        }
        return success({ answer: result.answer, sources: result.sources })
      } catch (error) {
        return failure(`知识库子 Agent 调用失败：${describeError(error)}`)
      }
    }
  }
}
