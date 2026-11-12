import { useEffect, useRef, useState } from 'react'
import { formatKbLocation } from '../../../shared/location'
import { isLowConfidence } from '../../../shared/protocol'
import type {
  AgentStreamEvent,
  EntityReference,
  FileAttachment,
  HistoryMessage,
  KbHit,
  ProjectInfo
} from '../../../shared/protocol'

const MAX_ATTACHMENTS = 10

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
  attachments?: FileAttachment[]
}

interface ChatPanelProps {
  project: ProjectInfo | null
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
  project,
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
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [picking, setPicking] = useState(false)
  const [missingPaths, setMissingPaths] = useState<ReadonlySet<string>>(new Set())
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
    setAttachments([])
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

  useEffect(() => {
    if (!project) {
      setAttachments([])
    }
  }, [project])

  const attachmentPaths = entries
    .flatMap((entry) => entry.attachments?.map((file) => file.path) ?? [])
    .join('\n')

  useEffect(() => {
    if (!project || !attachmentPaths) {
      setMissingPaths(new Set())
      return
    }
    let mounted = true
    void window.cad.project
      .verifyFiles(attachmentPaths.split('\n'))
      .then((outcome) => {
        if (mounted) {
          setMissingPaths(new Set(outcome.ok ? (outcome.missing ?? []) : []))
        }
      })
      .catch(() => {
        if (mounted) {
          setMissingPaths(new Set())
        }
      })
    return () => {
      mounted = false
    }
  }, [project, attachmentPaths])

  async function pickFiles(): Promise<void> {
    if (!project || picking) {
      return
    }
    setPicking(true)
    setNotice(null)
    try {
      const outcome = await window.cad.project.pickFiles()
      if (outcome.canceled) {
        return
      }
      if (!outcome.ok || !outcome.files) {
        setNotice(outcome.error ?? '无法选择文件')
        return
      }
      const picked = outcome.files
      setAttachments((current) => {
        const existing = new Set(current.map((file) => file.path))
        const merged = [...current, ...picked.filter((file) => !existing.has(file.path))]
        if (merged.length > MAX_ATTACHMENTS) {
          setNotice(`一次最多附加 ${MAX_ATTACHMENTS} 个文件，已保留前 ${MAX_ATTACHMENTS} 个。`)
          return merged.slice(0, MAX_ATTACHMENTS)
        }
        return merged
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPicking(false)
    }
  }

  function removeAttachment(path: string): void {
    setAttachments((current) => current.filter((file) => file.path !== path))
  }

  async function send(): Promise<void> {
    const prompt = input.trim()
    if (!prompt || activeId) {
      return
    }

    const requestId = crypto.randomUUID()
    const selected = attachments
    setInput('')
    setAttachments([])
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
        sources: [],
        ...(selected.length ? { attachments: selected } : {})
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
      const result = await window.cad.agent.ask({
        requestId,
        prompt,
        ...(selected.length ? { attachments: selected } : {})
      })
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
              {entry.attachments && entry.attachments.length > 0 ? (
                <AttachmentChips files={entry.attachments} missing={missingPaths} />
              ) : null}
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
        <div className="chat__composer-tools">
          <button
            type="button"
            className="chat__attach"
            onClick={() => void pickFiles()}
            disabled={!project || picking}
            title={project ? '选择项目内的文件作为上下文' : '请先打开项目文件夹'}
          >
            {picking ? '选择中…' : '选择文件'}
          </button>
          <span className="muted chat__attach-hint">
            {project ? '附件只传路径，不复制文件' : '打开项目后可附加文件'}
          </span>
        </div>

        {attachments.length > 0 ? (
          <div className="chat__attachments">
            {attachments.map((file) => (
              <span key={file.path} className="chat__attachment" title={file.path}>
                <span className="chat__attachment-name">{file.name}</span>
                <span className="chat__attachment-size">{formatSize(file.size)}</span>
                <button
                  type="button"
                  className="chat__attachment-remove"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => removeAttachment(file.path)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="chat__composer-row">
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
        </div>
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
    sources: message.sources ?? [],
    ...(message.attachments?.length ? { attachments: message.attachments } : {})
  }
}

function AttachmentChips({
  files,
  missing
}: {
  files: FileAttachment[]
  missing: ReadonlySet<string>
}) {
  return (
    <div className="chat__attachments">
      {files.map((file) => {
        const gone = missing.has(file.path)
        return (
          <span
            key={file.path}
            className={gone ? 'chat__attachment chat__attachment--missing' : 'chat__attachment'}
            title={gone ? `${file.path}（文件已不存在）` : file.path}
          >
            <span className="chat__attachment-name">{file.name}</span>
            <span className="chat__attachment-size">{formatSize(file.size)}</span>
            {gone ? <span className="chat__attachment-gone">已不存在</span> : null}
          </span>
        )
      })}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}
