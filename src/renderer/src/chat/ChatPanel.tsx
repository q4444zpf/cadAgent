import { useEffect, useRef, useState } from 'react'
import { formatKbLocation } from '../../../shared/location'
import { isLowConfidence } from '../../../shared/protocol'
import type {
  AgentStreamEvent,
  EntityReference,
  HistoryMessage,
  KbHit
} from '../../../shared/protocol'

interface ToolActivity {
  callId: string
  name: string
  args: unknown
  ok?: boolean
  output?: string
  durationMs?: number
}

interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending: boolean
  aborted: boolean
  error?: string
  tools: ToolActivity[]
  references: EntityReference[]
  sources: KbHit[]
}

interface ChatPanelProps {
  drawingName: string | null
  drawingPath: string | null
  highlighted: ReadonlySet<string>
  onLocate: (handle: string) => void
  sessionSignal: number
  onSessionChanged: () => void
}

const KIND_LABELS: Record<string, string> = {
  line: '直线',
  polyline: '多段线',
  circle: '圆',
  arc: '圆弧',
  text: '文字'
}

export function ChatPanel({
  drawingName,
  drawingPath,
  highlighted,
  onLocate,
  sessionSignal,
  onSessionChanged
}: ChatPanelProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return window.cad.agent.onEvent((event) => {
      setEntries((current) => applyEvent(current, event))
      if (event.type === 'run_end') {
        setActiveId(null)
      }
    })
  }, [])

  useEffect(() => {
    let mounted = true
    setEntries([])
    setActiveId(null)
    setInput('')
    setNotice(null)
    setSessionTitle(null)
    void window.cad.agent.abort()
    void window.cad.history.current().then((outcome) => {
      if (!mounted || !outcome.ok || !outcome.session) {
        return
      }
      setSessionTitle(outcome.session.title)
      setEntries(outcome.session.messages.map(messageToEntry))
    })
    return () => {
      mounted = false
    }
  }, [drawingPath, sessionSignal])

  useEffect(() => {
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [entries])

  async function send(): Promise<void> {
    const prompt = input.trim()
    if (!prompt || activeId) {
      return
    }

    const requestId = crypto.randomUUID()
    setInput('')
    setNotice(null)
    setEntries((current) => [
      ...current,
      {
        id: `${requestId}-q`,
        role: 'user',
        text: prompt,
        pending: false,
        aborted: false,
        tools: [],
        references: [],
        sources: []
      },
      {
        id: requestId,
        role: 'assistant',
        text: '',
        pending: true,
        aborted: false,
        tools: [],
        references: [],
        sources: []
      }
    ])
    setActiveId(requestId)

    try {
      const result = await window.cad.agent.ask({ requestId, prompt })
      if (!result.ok) {
        failEntry(requestId, result.error ?? '问答失败')
      }
    } catch (error) {
      failEntry(requestId, error instanceof Error ? error.message : String(error))
    }
  }

  async function startNewSession(): Promise<void> {
    if (activeId) {
      return
    }
    await window.cad.agent.abort()
    const outcome = await window.cad.history.create({
      title: '新对话',
      drawingPath,
      drawingName
    })
    if (!outcome.ok) {
      setNotice(outcome.error ?? '无法新建会话')
      return
    }
    setEntries([])
    setInput('')
    setNotice(null)
    setSessionTitle(outcome.session?.title ?? '新对话')
    onSessionChanged()
  }

  function failEntry(requestId: string, message: string): void {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === requestId ? { ...entry, pending: false, error: message } : entry
      )
    )
    setActiveId(null)
  }

  return (
    <section className="panel chat">
      <div className="panel__heading">
        <h2>读图问答</h2>
        <span className="muted">{sessionTitle ?? drawingName ?? '未打开图纸'}</span>
        <button type="button" onClick={() => void startNewSession()} disabled={Boolean(activeId)}>
          新对话
        </button>
      </div>

      <div className="chat__messages" ref={listRef}>
        {entries.length === 0 ? (
          <div className="chat__empty">
            <p>就当前图纸提问，回答只依据图纸数据。</p>
            <p className="chat__hint">试试：这张图有多少个图层？图里有哪些文字？</p>
          </div>
        ) : null}

        {entries.map((entry) =>
          entry.role === 'user' ? (
            <div key={entry.id} className="chat__bubble chat__bubble--user">
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} className="chat__answer">
              {entry.tools.length > 0 ? (
                <details className="chat__tools" open={entry.pending}>
                  <summary>工具调用（{entry.tools.length}）</summary>
                  <ul>
                    {entry.tools.map((tool) => (
                      <li key={tool.callId}>
                        <div className="chat__tool-name">
                          {tool.name}
                          {tool.ok === undefined
                            ? ' · 执行中…'
                            : tool.ok
                              ? ' · 完成'
                              : ' · 失败'}
                          {tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ''}
                        </div>
                        <pre className="chat__tool-io">
                          {`参数: ${stringify(tool.args)}`}
                          {tool.output ? `\n输出: ${tool.output}` : ''}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {entry.text || entry.pending ? (
                <div className="chat__bubble chat__bubble--assistant">
                  {entry.text || '正在读取图纸…'}
                  {entry.aborted ? <span className="chat__tag">已停止</span> : null}
                </div>
              ) : null}

              {entry.error ? <p className="error">{entry.error}</p> : null}

              {entry.references.length > 0 ? (
                <div className="chat__refs">
                  {entry.references.map((reference) => (
                    <button
                      key={reference.handle}
                      type="button"
                      aria-pressed={reference.exists ? highlighted.has(reference.handle) : undefined}
                      className={[
                        'chat__ref',
                        reference.exists ? '' : 'chat__ref--missing',
                        highlighted.has(reference.handle) ? 'chat__ref--active' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      title={
                        reference.exists
                          ? `#${reference.handle} · ${KIND_LABELS[reference.kind ?? ''] ?? reference.kind} · 图层 ${reference.layer}`
                          : `图纸中未找到 #${reference.handle}`
                      }
                      onClick={() => {
                        if (!reference.exists) {
                          setNotice(`图纸中未找到 #${reference.handle}，无法高亮。`)
                          return
                        }
                        onLocate(reference.handle)
                        setNotice(
                          `#${reference.handle} · ${KIND_LABELS[reference.kind ?? ''] ?? reference.kind} · 图层 ${reference.layer}`
                        )
                      }}
                    >
                      #{reference.handle}
                    </button>
                  ))}
                </div>
              ) : null}

              {entry.sources.length > 0 ? (
                <div className="chat__sources">
                  <div className="chat__sources-title">出处（{entry.sources.length}）</div>
                  {entry.sources.map((source) => (
                    <details
                      key={`${source.docId}-${formatKbLocation(source.location)}-${source.text.slice(0, 12)}`}
                      className="chat__source"
                    >
                      <summary>
                        {source.docName} · {formatKbLocation(source.location)}
                        {source.sourceType === 'vision' ? (
                          <span className="chat__source-tag">视觉识别</span>
                        ) : null}
                        {isLowConfidence(source) ? (
                          <span className="chat__source-tag chat__source-tag--low">低置信</span>
                        ) : null}
                      </summary>
                      <p className="chat__source-text">{source.text}</p>
                      {isLowConfidence(source) ? (
                        <p className="chat__source-warning">
                          低置信识别结果，需人工核对，不能作为唯一依据。
                        </p>
                      ) : null}
                    </details>
                  ))}
                </div>
              ) : null}
            </div>
          )
        )}

        {notice ? <p className="chat__notice">{notice}</p> : null}
      </div>

      <form
        className="chat__composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder="就当前图纸提问…（Enter 发送，Shift+Enter 换行）"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {activeId ? (
          <button type="button" onClick={() => void window.cad.agent.abort()}>
            停止
          </button>
        ) : (
          <button type="submit" className="button--primary" disabled={!input.trim()}>
            发送
          </button>
        )}
      </form>
    </section>
  )
}

function applyEvent(entries: ChatEntry[], event: AgentStreamEvent): ChatEntry[] {
  const index = entries.findIndex((entry) => entry.id === event.requestId)
  if (index === -1) {
    return entries
  }

  const next = entries.slice()
  const entry: ChatEntry = { ...next[index], tools: next[index].tools.map((tool) => ({ ...tool })) }

  if (event.type === 'text_delta') {
    entry.text += event.delta
  } else if (event.type === 'tool_start') {
    entry.tools.push({ callId: event.callId, name: event.name, args: event.args })
  } else if (event.type === 'tool_end') {
    const toolIndex = entry.tools.findIndex((tool) => tool.callId === event.callId)
    const activity: ToolActivity = {
      callId: event.callId,
      name: event.name,
      args: toolIndex === -1 ? undefined : entry.tools[toolIndex].args,
      ok: event.ok,
      output: event.output,
      durationMs: event.durationMs
    }
    if (toolIndex === -1) {
      entry.tools.push(activity)
    } else {
      entry.tools[toolIndex] = activity
    }
  } else if (event.type === 'run_end') {
    entry.pending = false
    entry.aborted = event.aborted
    entry.references = event.references ?? []
    entry.sources = event.sources ?? []
    if (event.text) {
      entry.text = event.text
    }
    if (event.error) {
      entry.error = event.error
    }
  }

  next[index] = entry
  return next
}

function messageToEntry(message: HistoryMessage): ChatEntry {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    pending: false,
    aborted: false,
    error: message.error,
    tools: [],
    references: message.references ?? [],
    sources: message.sources ?? []
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}
