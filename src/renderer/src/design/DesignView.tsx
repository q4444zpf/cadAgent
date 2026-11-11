import { useState } from 'react'
import type { DesignSessionView, DesignStatus } from '../../../shared/protocol'

const STATUS_LABELS: Record<DesignStatus, string> = {
  draft: '待确认',
  confirmed: '已确认',
  cancelled: '已取消'
}

export function DesignView() {
  const [prompt, setPrompt] = useState('生成一条 600×600 排水沟断面图，壁厚 100mm')
  const [session, setSession] = useState<DesignSessionView | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  async function propose(): Promise<void> {
    if (!prompt.trim() || busy) {
      return
    }
    setBusy(true)
    setError(null)
    setWarning(null)
    setSession(null)
    setValues({})
    try {
      const result = await window.cad.design.propose({ prompt })
      if (!result.ok || !result.session) {
        setError(result.error ?? '未能整理参数清单')
        return
      }
      setSession(result.session)
      setValues(
        Object.fromEntries(
          result.session.list.parameters.map((parameter) => [parameter.id, parameter.value])
        )
      )
      setWarning(result.warning ?? null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(): Promise<void> {
    if (!session || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.cad.design.confirm({
        listId: session.list.id,
        values
      })
      if (!result.ok || !result.session) {
        setError(result.error ?? '参数确认失败')
        return
      }
      setSession(result.session)
      setValues(
        Object.fromEntries(
          result.session.list.parameters.map((parameter) => [parameter.id, parameter.value])
        )
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!session || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.cad.design.cancel({ listId: session.list.id })
      if (!result.ok) {
        setError(result.error ?? '取消失败')
        return
      }
      setSession({ ...session, status: 'cancelled' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const editable = session?.status === 'draft'

  return (
    <section className="panel design">
      <h2>生成新图</h2>
      <p className="muted">
        用自然语言描述生成需求。Agent 会先查证知识库，再整理参数清单；参数确认前不会生成任何图纸文件。
      </p>

      <label className="field design__field">
        <span>生成需求</span>
        <textarea
          className="design__prompt"
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>

      <div className="design__toolbar">
        <button
          type="button"
          className="button--primary design__propose"
          onClick={propose}
          disabled={busy || !prompt.trim()}
        >
          {busy && !session ? '正在整理参数…' : '整理参数'}
        </button>
        {warning ? <span className="design__warning">{warning}</span> : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {session ? (
        <div className="design__session">
          <div className="design__heading">
            <h3>{session.list.title}</h3>
            <span className="design__type">{session.list.drawingType}</span>
            <span className={`design__status design__status--${session.status}`}>
              {STATUS_LABELS[session.status]}
            </span>
          </div>
          {session.list.summary ? <p className="muted">{session.list.summary}</p> : null}

          <table className="design__table">
            <thead>
              <tr>
                <th>参数</th>
                <th>取值</th>
                <th>单位</th>
                <th>依据 / 假设</th>
              </tr>
            </thead>
            <tbody>
              {session.list.parameters.map((parameter) => (
                <tr key={parameter.id} className="design__param" data-param={parameter.id}>
                  <td className="design__param-name">{parameter.name}</td>
                  <td>
                    <input
                      className="design__param-value"
                      value={values[parameter.id] ?? ''}
                      disabled={!editable}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [parameter.id]: event.target.value
                        }))
                      }
                    />
                  </td>
                  <td className="design__param-unit">{parameter.unit || '—'}</td>
                  <td className="design__param-basis">
                    <span>{parameter.basis || '无直接依据'}</span>
                    {parameter.assumed ? <span className="design__assumed">假设</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {editable ? (
            <div className="design__actions">
              <button
                type="button"
                className="button--primary design__confirm"
                onClick={confirm}
                disabled={busy}
              >
                {busy ? '正在确认…' : '确认参数'}
              </button>
              <button type="button" className="design__cancel" onClick={cancel} disabled={busy}>
                取消
              </button>
            </div>
          ) : null}

          {session.status === 'confirmed' ? (
            <p className="design__hint">
              参数已确认，后续生成将使用上表数值；本次尚未写入任何 DXF 文件。
            </p>
          ) : null}
          {session.status === 'cancelled' ? (
            <p className="muted design__hint">已取消，未生成任何文件。</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
