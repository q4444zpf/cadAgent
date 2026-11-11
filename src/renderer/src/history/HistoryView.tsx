import { useEffect, useState } from 'react'
import type {
  GenerationRecordView,
  HistorySessionSummary,
  HistorySessionView
} from '../../../shared/protocol'

interface HistoryViewProps {
  onOpen: (session: HistorySessionView) => void
}

export function HistoryView({ onOpen }: HistoryViewProps) {
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<HistorySessionView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.cad.history.list().then((outcome) => {
      if (!mounted) {
        return
      }
      if (!outcome.ok) {
        setNotice(outcome.error ?? '无法读取历史会话')
        return
      }
      setSessions(outcome.sessions)
    })
    return () => {
      mounted = false
    }
  }, [])

  async function reload(preferredId?: string | null): Promise<void> {
    const outcome = await window.cad.history.list()
    if (!outcome.ok) {
      setNotice(outcome.error ?? '无法读取历史会话')
      return
    }
    setSessions(outcome.sessions)
    const nextId =
      preferredId !== undefined
        ? preferredId
        : selectedId && outcome.sessions.some((session) => session.id === selectedId)
          ? selectedId
          : null
    if (!nextId) {
      setSelectedId(null)
      setDetail(null)
      return
    }
    const session = await window.cad.history.get(nextId)
    if (session.ok && session.session) {
      setSelectedId(nextId)
      setDetail(session.session)
    } else {
      setSelectedId(null)
      setDetail(null)
    }
  }

  async function select(sessionId: string): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await window.cad.history.get(sessionId)
      if (!outcome.ok || !outcome.session) {
        setNotice(outcome.error ?? '会话不存在')
        return
      }
      setSelectedId(sessionId)
      setDetail(outcome.session)
    } finally {
      setBusy(false)
    }
  }

  async function open(sessionId: string): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await window.cad.history.open(sessionId)
      if (!outcome.ok || !outcome.session) {
        setNotice(outcome.error ?? '会话不存在')
        return
      }
      onOpen(outcome.session)
    } finally {
      setBusy(false)
    }
  }

  async function remove(sessionId: string): Promise<void> {
    if (busy) {
      return
    }
    if (!window.confirm('删除该会话？已生成的 DXF 文件不会被删除。')) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await window.cad.history.remove(sessionId)
      if (!outcome.ok) {
        setNotice(outcome.error ?? '删除失败')
        return
      }
      setNotice('会话已删除，已生成的 DXF 文件保留。')
      await reload(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel history">
      <div className="panel__heading">
        <h2>历史</h2>
        <span className="muted">会话与生成记录保存在本机</span>
        <button type="button" onClick={() => void reload()} disabled={busy}>
          刷新
        </button>
      </div>

      {notice ? <p className="history__notice">{notice}</p> : null}

      <div className="history__layout">
        <div className="history__list">
          {sessions.length === 0 ? (
            <p className="muted">暂无历史会话。在图纸页提问后会自动创建会话。</p>
          ) : (
            <ul>
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={
                      session.id === selectedId
                        ? 'history__session history__session--active'
                        : 'history__session'
                    }
                    onClick={() => void select(session.id)}
                    disabled={busy}
                  >
                    <span className="history__session-title">{session.title}</span>
                    <span className="history__session-meta">
                      {formatTime(session.updatedAt)} · {session.messageCount} 条消息 ·{' '}
                      {session.generationCount} 次生成
                    </span>
                    <span className="history__session-drawing">
                      {session.drawingName ?? '未关联图纸'}
                    </span>
                  </button>
                  <div className="history__session-actions">
                    <button type="button" onClick={() => void open(session.id)} disabled={busy}>
                      打开
                    </button>
                    <button type="button" onClick={() => void remove(session.id)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="history__detail">
          {detail ? (
            <>
              <div className="history__detail-heading">
                <h3>{detail.title}</h3>
                <span className="muted">
                  {formatTime(detail.createdAt)} 创建 · {detail.drawingName ?? '未关联图纸'}
                </span>
              </div>

              {detail.messages.length === 0 ? (
                <p className="muted">该会话还没有消息。</p>
              ) : (
                <div className="history__messages">
                  {detail.messages.map((message) => (
                    <div
                      key={message.id}
                      className={
                        message.role === 'user'
                          ? 'history__message history__message--user'
                          : 'history__message'
                      }
                    >
                      <div className="history__message-role">
                        {message.role === 'user' ? '提问' : '回答'} ·{' '}
                        {formatTime(message.createdAt)}
                      </div>
                      <p>{message.text || '（空）'}</p>
                      {message.error ? <p className="error">{message.error}</p> : null}
                      {message.references && message.references.length > 0 ? (
                        <div className="history__refs">
                          {message.references.map((reference) => (
                            <span key={reference.handle} className="chat__ref">
                              #{reference.handle}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {message.sources && message.sources.length > 0 ? (
                        <div className="history__sources">
                          出处 {message.sources.length} 条：
                          {message.sources.map((source) => source.docName).join('、')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <div className="history__generations">
                <h3>生成记录</h3>
                {detail.generations.length === 0 ? (
                  <p className="muted">尚无生成记录。生成功能完成后，记录会显示在这里。</p>
                ) : (
                  <ul>
                    {detail.generations.map((generation) => (
                      <GenerationCard key={generation.id} generation={generation} />
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className="muted">选择左侧会话查看消息与生成记录。</p>
          )}
        </div>
      </div>
    </section>
  )
}

function GenerationCard({ generation }: { generation: GenerationRecordView }) {
  return (
    <li className="history__generation">
      <div className="history__generation-heading">
        <span>{formatTime(generation.createdAt)}</span>
        {generation.validation ? (
          <span
            className={
              generation.validation.ok
                ? 'history__validation history__validation--ok'
                : 'history__validation history__validation--bad'
            }
          >
            {generation.validation.ok ? '校验通过' : `校验未通过（${generation.validation.issues.length}）`}
          </span>
        ) : (
          <span className="history__validation">未校验</span>
        )}
      </div>
      <p className="history__file" title={generation.filePath}>
        {generation.filePath}
      </p>
      {!generation.fileExists ? (
        <p className="history__file-warning">文件已被移动或删除，其余记录不受影响。</p>
      ) : null}
      <dl className="history__params">
        {generation.parameters.map((parameter) => (
          <div key={parameter.id}>
            <dt>{parameter.name}</dt>
            <dd>
              {parameter.value} {parameter.unit}
              {parameter.assumed ? <span className="design__assumed">假设</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {generation.validation && generation.validation.issues.length > 0 ? (
        <ul className="history__issues">
          {generation.validation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
