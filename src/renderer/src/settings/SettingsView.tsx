import { useEffect, useRef, useState } from 'react'
import type {
  ConverterStatus,
  ModelProvider,
  ModelSettingsSave,
  PublicModelSettings
} from '../../../shared/protocol'

type Notice = { tone: 'success' | 'error' | 'info'; text: string }

interface SettingsViewProps {
  converter: ConverterStatus | null
  onConverterChange: (status: ConverterStatus) => void
}

export function SettingsView({ converter, onConverterChange }: SettingsViewProps) {
  const [settings, setSettings] = useState<PublicModelSettings | null>(null)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [models, setModels] = useState<string[]>([])
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [fakeMode, setFakeMode] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [logPath, setLogPath] = useState('')
  const [logNotice, setLogNotice] = useState<string | null>(null)
  const [converterBusy, setConverterBusy] = useState(false)
  const [converterNotice, setConverterNotice] = useState<string | null>(null)
  const saved = useRef({ provider: '', model: '' })

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const [current, providerList] = await Promise.all([
          window.cad.settings.get(),
          window.cad.model.providers()
        ])
        if (!mounted) {
          return
        }
        setSettings(current)
        setProviders(providerList)
        saved.current = { provider: current.provider, model: current.model }
        setProvider(current.provider)
        setModel(current.model)
        setFakeMode(current.fakeMode)
      } catch (error) {
        if (mounted) {
          setNotice({ tone: 'error', text: describe(error) })
        }
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!provider) {
      return
    }
    let active = true
    void window.cad.model
      .models(provider)
      .then((list) => {
        if (!active) {
          return
        }
        setModels(list)
        setModel((current) =>
          provider === saved.current.provider && current === saved.current.model
            ? current
            : list.includes(current)
              ? current
              : list[0] || ''
        )
      })
      .catch(() => {
        if (active) {
          setModels([])
        }
      })
    return () => {
      active = false
    }
  }, [provider])

  useEffect(() => {
    void loadLogs()
  }, [])

  async function loadLogs(): Promise<void> {
    try {
      const result = await window.cad.diagnostics.tail()
      if (!result.ok) {
        setLogNotice(result.error ?? '无法读取日志')
        return
      }
      setLogLines(result.lines)
      setLogPath(result.path)
      setLogNotice(null)
    } catch (error) {
      setLogNotice(describe(error))
    }
  }

  async function openLogs(): Promise<void> {
    try {
      const result = await window.cad.diagnostics.openLogs()
      if (!result.ok) {
        setLogNotice(result.error ?? '无法打开日志目录')
      }
    } catch (error) {
      setLogNotice(describe(error))
    }
  }

  async function refreshConverter(): Promise<void> {
    setConverterBusy(true)
    try {
      onConverterChange(await window.cad.converter.status())
      setConverterNotice(null)
    } catch (error) {
      setConverterNotice(describe(error))
    } finally {
      setConverterBusy(false)
    }
  }

  async function openConverterDownload(): Promise<void> {
    try {
      const result = await window.cad.converter.openDownload()
      if (!result.ok) {
        setConverterNotice(result.error ?? '无法打开下载页')
      }
    } catch (error) {
      setConverterNotice(describe(error))
    }
  }

  const modelOptions = model && !models.includes(model) ? [model, ...models] : models
  const disabled = busy !== null

  async function persist(): Promise<boolean> {
    if (!fakeMode && (!provider || !model)) {
      setNotice({ tone: 'error', text: '请先选择 Provider 与模型' })
      return false
    }

    const input: ModelSettingsSave = {
      provider,
      model,
      fakeMode,
      ...(apiKey ? { apiKey } : {})
    }
    const result = await window.cad.settings.save(input)
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.error })
      return false
    }
    setSettings(result.settings)
    setApiKey('')
    return true
  }

  async function save(): Promise<void> {
    setBusy('save')
    try {
      if (await persist()) {
        setNotice({ tone: 'success', text: '设置已保存' })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) })
    } finally {
      setBusy(null)
    }
  }

  async function test(): Promise<void> {
    setBusy('test')
    try {
      if (!(await persist())) {
        return
      }
      const result = await window.cad.model.test()
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) })
    } finally {
      setBusy(null)
    }
  }

  async function clearKey(): Promise<void> {
    setBusy('save')
    try {
      const result = await window.cad.settings.save({ provider, model, fakeMode, apiKey: null })
      if (result.ok) {
        setSettings(result.settings)
        setNotice({ tone: 'success', text: '已清除 API Key' })
      } else {
        setNotice({ tone: 'error', text: result.error })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section className="panel settings">
        <div className="panel__heading">
          <h2>模型设置</h2>
          <span className="muted">修改后立即生效，无需重启</span>
        </div>

      {settings ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="settings__grid">
            <label className="field">
              <span>Provider</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                disabled={disabled || fakeMode}
              >
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.id}）
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>模型</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={disabled || fakeMode}
              >
                {modelOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <label className="field field--wide">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder={settings.hasApiKey ? '已加密保存，留空保持不变' : '输入 API Key'}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={disabled || fakeMode}
              />
            </label>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={fakeMode}
              onChange={(event) => setFakeMode(event.target.checked)}
              disabled={disabled}
            />
            <span>假模型模式（离线开发与测试，回复固定内容）</span>
          </label>

          {settings.secretStorage === 'unavailable' ? (
            <p className="error">
              系统凭据库不可用，API Key 无法安全保存。可先使用假模型模式。
            </p>
          ) : null}

          {notice ? <p className={`notice notice--${notice.tone}`}>{notice.text}</p> : null}

          <div className="settings__actions">
            <button type="submit" className="button--primary" disabled={disabled}>
              {busy === 'save' ? '保存中…' : '保存设置'}
            </button>
            <button type="button" onClick={() => void test()} disabled={disabled}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            {settings.hasApiKey ? (
              <button type="button" onClick={() => void clearKey()} disabled={disabled}>
                清除 API Key
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="muted">正在读取配置…</p>
      )}

        <p className="muted">
          连接测试会使用已保存的配置向模型发送一条测试消息。API Key 仅加密存储在系统凭据库中，不写入项目目录与日志。
        </p>
      </section>

      <section className="panel settings">
        <div className="panel__heading">
          <h2>DWG 转换器</h2>
          <span className={converter?.found ? 'badge badge--ready' : 'badge badge--error'}>
            {converter === null ? '检测中' : converter.found ? '已安装' : '未安装'}
          </span>
        </div>

        {converter?.found ? (
          <>
            <p className="muted">
              DWG 图纸会调用本机 ODA File Converter 转换为 DXF 后导入。当前版本：
              {converter.version ?? '未知'}。
            </p>
            <p className="muted settings__log-path">{converter.path}</p>
          </>
        ) : (
          <>
            <p>
              本应用不内置 DWG 转换器（受 ODA 许可限制）。打开 DWG 图纸前，请在本机安装免费的
              ODA File Converter。
            </p>
            <ol className="converter__steps">
              <li>点击「打开下载页」，在官网下载 Windows 版安装包。</li>
              <li>双击安装包，按向导完成安装（需管理员权限，保持默认路径即可）。</li>
              <li>回到本页点击「重新检测」，状态显示「已安装」后即可导入 DWG。</li>
            </ol>
            <p className="muted">
              也可在 AutoCAD、中望 CAD 等软件中把图纸另存为 DXF 后直接导入。未安装转换器不影响
              DXF 图纸的读图与生成。
            </p>
          </>
        )}

        {converterNotice ? <p className="error">{converterNotice}</p> : null}

        <div className="settings__actions">
          <button type="button" className="button--primary" onClick={() => void openConverterDownload()}>
            打开下载页
          </button>
          <button type="button" onClick={() => void refreshConverter()} disabled={converterBusy}>
            {converterBusy ? '检测中…' : '重新检测'}
          </button>
        </div>
      </section>

      <section className="panel settings">
        <div className="panel__heading">
          <h2>诊断日志</h2>
          <div className="panel__tools">
            <button type="button" onClick={() => void loadLogs()}>
              刷新
            </button>
            <button type="button" onClick={() => void openLogs()}>
              打开日志文件夹
            </button>
          </div>
        </div>
        <p className="muted settings__log-path">{logPath || '日志保存在本机用户数据目录'}</p>
        {logNotice ? <p className="error">{logNotice}</p> : null}
        {logLines.length > 0 ? (
          <pre className="diagnostics__log">{logLines.join('\n')}</pre>
        ) : (
          <p className="muted">暂无日志。</p>
        )}
      </section>
    </>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
