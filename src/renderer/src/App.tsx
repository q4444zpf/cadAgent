import { useEffect, useState } from 'react'
import {
  drawingEntityCount,
  type ConverterStatus,
  type Drawing,
  type DrawingOpenResult,
  type HistorySessionView,
  type SidecarStatus
} from '../../shared/protocol'
import { DrawingCanvas } from './drawing/DrawingCanvas'
import { ProgressivePreview } from './drawing/ProgressivePreview'
import { resolveEntityColor } from './drawing/aci'
import { ChatPanel } from './chat/ChatPanel'
import { DesignView } from './design/DesignView'
import { HistoryView } from './history/HistoryView'
import { KnowledgeView } from './knowledge/KnowledgeView'
import { SettingsView } from './settings/SettingsView'

const stateLabels: Record<SidecarStatus['state'], string> = {
  starting: '侧车服务启动中',
  ready: '侧车服务就绪',
  error: '侧车服务异常',
  stopped: '侧车服务已停止'
}

type DrawingError = { code: string; message: string }

export default function App() {
  const [status, setStatus] = useState<SidecarStatus>({ state: 'starting' })
  const [restarting, setRestarting] = useState(false)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [visibleLayers, setVisibleLayers] = useState<ReadonlySet<string>>(new Set())
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<DrawingError | null>(null)
  const [opening, setOpening] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [view, setView] = useState<'drawing' | 'design' | 'history' | 'knowledge' | 'settings'>(
    'drawing'
  )
  const [historySignal, setHistorySignal] = useState(0)
  const [converter, setConverter] = useState<ConverterStatus | null>(null)
  const [converterDismissed, setConverterDismissed] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.cad.converter
      .status()
      .then((status) => {
        if (mounted) {
          setConverter(status)
        }
      })
      .catch(() => {
        if (mounted) {
          setConverter(null)
        }
      })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.cad.sidecar.getStatus().then((current) => {
      if (mounted) {
        setStatus(current)
      }
    })
    const unsubscribe = window.cad.sidecar.onStatus((next) => setStatus(next))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  function applyResult(result: DrawingOpenResult): void {
    if (result.ok) {
      setDrawing(result.drawing)
      setVisibleLayers(new Set(result.drawing.layers.map((layer) => layer.name)))
      setHighlight(new Set())
      setError(null)
      setFitSignal((current) => current + 1)
    } else {
      setError(result.error)
    }
  }

  async function loadPath(path: string): Promise<void> {
    setOpening(true)
    try {
      applyResult(await window.cad.drawing.load(path))
    } catch (failure) {
      setError({
        code: 'ipc_error',
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    let mounted = true
    void (async () => {
      const auto = await window.cad.drawing.autoOpen().catch(() => null)
      if (!auto || !mounted) {
        return
      }
      setOpening(true)
      try {
        const result = await window.cad.drawing.load(auto.path)
        if (mounted) {
          applyResult(result)
        }
      } catch (failure) {
        if (mounted) {
          setError({
            code: 'ipc_error',
            message: failure instanceof Error ? failure.message : String(failure)
          })
        }
      } finally {
        if (mounted) {
          setOpening(false)
        }
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  async function restart(): Promise<void> {
    setRestarting(true)
    try {
      setStatus(await window.cad.sidecar.restart())
    } catch (failure) {
      setStatus({
        state: 'error',
        detail: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setRestarting(false)
    }
  }

  async function openFile(): Promise<void> {
    setOpening(true)
    try {
      const result = await window.cad.drawing.open()
      if (result) {
        applyResult(result)
      }
    } catch (failure) {
      setError({
        code: 'ipc_error',
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setOpening(false)
    }
  }

  function toggleLayer(name: string): void {
    setVisibleLayers((current) => {
      const next = new Set(current)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  function toggleHighlight(handle: string): void {
    setHighlight((current) => {
      const next = new Set(current)
      if (next.has(handle)) {
        next.delete(handle)
      } else {
        next.add(handle)
      }
      return next
    })
  }

  async function openHistorySession(session: HistorySessionView): Promise<void> {
    setView('drawing')
    setHistorySignal((current) => current + 1)
    if (session.drawingPath && session.drawingPath !== drawing?.path) {
      await loadPath(session.drawingPath)
    }
  }

  const unsupported = drawing
    ? Object.entries(drawing.unsupported)
        .map(([kind, count]) => `${kind} × ${count}`)
        .join('，')
    : ''

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>CAD Agent</h1>
          <p className="app__subtitle">自然语言读图与生成 · 水利 / 市政工程</p>
        </div>
        <div className="app__actions">
          <nav className="app__nav">
            <button
              type="button"
              className={view === 'drawing' ? 'nav-button nav-button--active' : 'nav-button'}
              onClick={() => setView('drawing')}
            >
              图纸
            </button>
            <button
              type="button"
              className={view === 'knowledge' ? 'nav-button nav-button--active' : 'nav-button'}
              onClick={() => setView('knowledge')}
            >
              知识库
            </button>
            <button
              type="button"
              className={view === 'design' ? 'nav-button nav-button--active' : 'nav-button'}
              onClick={() => setView('design')}
            >
              生成
            </button>
            <button
              type="button"
              className={view === 'history' ? 'nav-button nav-button--active' : 'nav-button'}
              onClick={() => setView('history')}
            >
              历史
            </button>
            <button
              type="button"
              className={view === 'settings' ? 'nav-button nav-button--active' : 'nav-button'}
              onClick={() => setView('settings')}
            >
              设置
            </button>
          </nav>
          <span className={`badge badge--${status.state}`}>{stateLabels[status.state]}</span>
          {view === 'drawing' ? (
            <button
              type="button"
              className="button--primary"
              onClick={openFile}
              disabled={opening}
            >
              {opening ? '正在导入…' : '打开图纸…'}
            </button>
          ) : null}
        </div>
      </header>

      {converter && !converter.found && !converterDismissed ? (
        <div className="converter-banner" role="status">
          <div>
            <strong>未检测到 ODA File Converter</strong>
            <p>
              DWG 图纸需先转换为 DXF 才能导入。请安装免费的 ODA File Converter，或在自有 CAD 中另存为
              DXF。未安装不影响 DXF 图纸的读图与生成。
            </p>
          </div>
          <div className="converter-banner__actions">
            <button type="button" className="button--primary" onClick={() => setView('settings')}>
              查看安装指引
            </button>
            <button type="button" onClick={() => setConverterDismissed(true)}>
              暂时忽略
            </button>
          </div>
        </div>
      ) : null}

      {view === 'settings' ? (
        <main className="app__main app__main--settings">
          <SettingsView converter={converter} onConverterChange={setConverter} />
        </main>
      ) : view === 'knowledge' ? (
        <main className="app__main app__main--settings">
          <KnowledgeView />
        </main>
      ) : view === 'design' ? (
        <main className="app__main app__main--settings">
          <DesignView />
        </main>
      ) : view === 'history' ? (
        <main className="app__main app__main--settings">
          <HistoryView onOpen={(session) => void openHistorySession(session)} />
        </main>
      ) : (
        <main className="app__main">
        <aside className="sidebar">
          <section className="panel">
            <h2>图纸文件</h2>
            {drawing ? (
              <dl className="facts">
                <div>
                  <dt>文件名</dt>
                  <dd title={drawing.path}>{drawing.name}</dd>
                </div>
                <div>
                  <dt>实体</dt>
                  <dd>
                    {drawingEntityCount(drawing).toLocaleString()}
                    {drawing.summaryOnly ? '（摘要）' : ''}
                  </dd>
                </div>
                <div>
                  <dt>图层</dt>
                  <dd>{drawing.layers.length}</dd>
                </div>
                {drawing.bounds ? (
                  <div>
                    <dt>包围盒</dt>
                    <dd>
                      {formatNumber(drawing.bounds.minX)}, {formatNumber(drawing.bounds.minY)} →{' '}
                      {formatNumber(drawing.bounds.maxX)}, {formatNumber(drawing.bounds.maxY)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="muted">尚未打开图纸。选择 DXF 文件后可在此查看解析结果。</p>
            )}
            {unsupported ? (
              <p className="muted">未展开实体：{unsupported}</p>
            ) : null}
          </section>

          {drawing ? (
            <section className="panel">
              <div className="panel__heading">
                <h2>图层</h2>
                <div className="panel__tools">
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleLayers(new Set(drawing.layers.map((layer) => layer.name)))
                    }
                  >
                    全显
                  </button>
                  <button type="button" onClick={() => setVisibleLayers(new Set())}>
                    全隐
                  </button>
                </div>
              </div>
              <ul className="layers">
                {drawing.layers.map((layer) => (
                  <li key={layer.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={visibleLayers.has(layer.name)}
                        onChange={() => toggleLayer(layer.name)}
                      />
                      <span
                        className="swatch"
                        style={{ background: resolveEntityColor(layer.color, 7) }}
                      />
                      <span className="layers__name" title={layer.name}>
                        {layer.name}
                      </span>
                      <span className="layers__count">{layer.entityCount}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel">
            <h2>侧车服务</h2>
            <dl className="facts">
              <div>
                <dt>状态</dt>
                <dd>{stateLabels[status.state]}</dd>
              </div>
              <div>
                <dt>ezdxf</dt>
                <dd>{status.health?.ezdxf ?? '—'}</dd>
              </div>
              <div>
                <dt>Python</dt>
                <dd>{status.health?.python ?? '—'}</dd>
              </div>
              <div>
                <dt>服务版本</dt>
                <dd>{status.health?.version ?? '—'}</dd>
              </div>
            </dl>
            {status.detail ? <p className="error">{status.detail}</p> : null}
            <button type="button" onClick={restart} disabled={restarting}>
              {restarting ? '正在重启…' : '重启侧车服务'}
            </button>
          </section>
        </aside>

        <section className="panel panel--preview">
          <div className="panel__heading">
            <h2>预览</h2>
            <div className="panel__tools">
              {highlight.size > 0 ? (
                <>
                  <span className="muted">已高亮 {highlight.size} 个实体</span>
                  <button type="button" onClick={() => setHighlight(new Set())}>
                    取消高亮
                  </button>
                </>
              ) : null}
              {drawing && (drawing.bounds || !drawing.summaryOnly) ? (
                <>
                  <span className="muted">滚轮缩放 · 拖动平移 · 双击适应窗口</span>
                  <button type="button" onClick={() => setFitSignal((current) => current + 1)}>
                    适应窗口
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="error error--block">
              <strong>
                {error.code === 'dwg_requires_conversion' ? 'DWG 需先转换' : '无法打开图纸'}
              </strong>
              <p>{error.message}</p>
              {error.code === 'dwg_requires_conversion' ? (
                converter && !converter.found ? (
                  <>
                    <p className="muted">
                      安装 ODA File Converter 后，用它将 DWG 另存为 DXF，再通过“打开图纸…”导入。转换问题不影响
                      DXF 的读图与生成。
                    </p>
                    <button type="button" onClick={() => setView('settings')}>
                      查看安装指引
                    </button>
                  </>
                ) : (
                  <p className="muted">
                    {converter?.found
                      ? `已检测到 ODA File Converter${converter.version ? ` ${converter.version}` : ''}，用它将 DWG 另存为 DXF 后再导入。`
                      : '用 ODA File Converter 将 DWG 另存为 DXF 后再导入。'}
                  </p>
                )
              ) : null}
            </div>
          ) : null}

          {drawing ? (
            drawing.summaryOnly ? (
              <ProgressivePreview
                key={drawing.path}
                drawing={drawing}
                visibleLayers={visibleLayers}
                highlight={highlight}
                fitSignal={fitSignal}
              />
            ) : (
              <DrawingCanvas
                key={drawing.path}
                drawing={drawing}
                visibleLayers={visibleLayers}
                highlight={highlight}
                fitSignal={fitSignal}
              />
            )
          ) : (
            <div className="preview-empty">
              <p>导入 DXF 后在此显示预览与图层。</p>
              <p className="muted">DWG 文件需先经 ODA File Converter 转换为 DXF。</p>
            </div>
          )}
        </section>

        <ChatPanel
          drawingName={drawing?.name ?? null}
          drawingPath={drawing?.path ?? null}
          highlighted={highlight}
          onLocate={toggleHighlight}
          sessionSignal={historySignal}
          onSessionChanged={() => setHistorySignal((current) => current + 1)}
        />
      </main>
      )}
    </div>
  )
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
