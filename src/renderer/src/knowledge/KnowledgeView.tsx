import { useEffect, useState } from 'react'
import { formatKbLocation } from '../../../shared/location'
import { isLowConfidence } from '../../../shared/protocol'
import type { KbDocument, KbHit } from '../../../shared/protocol'

const TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word',
  dxf: 'DXF',
  csv: '参数表',
  image: '扫描图'
}

export function KnowledgeView() {
  const [documents, setDocuments] = useState<KbDocument[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KbHit[] | null>(null)

  async function refresh(): Promise<void> {
    try {
      const result = await window.cad.kb.list()
      setDocuments(result.documents)
      if (!result.ok) {
        setError(result.error ?? '读取知识库失败')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function importFiles(): Promise<void> {
    const paths = await window.cad.kb.pick()
    if (paths.length === 0) {
      return
    }
    setBusy('导入中…')
    setError(null)
    setNotice(null)
    try {
      const result = await window.cad.kb.importPaths(paths)
      if (!result.ok) {
        setError(result.error ?? '导入失败')
      } else {
        const imported = result.documents ?? []
        const failed = imported.filter((doc) => doc.status !== 'ready').length
        setNotice(`已处理 ${imported.length} 个文件${failed ? `，其中 ${failed} 个失败` : ''}`)
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function retry(doc: KbDocument): Promise<void> {
    setBusy('重试中…')
    setError(null)
    setNotice(null)
    try {
      const result = await window.cad.kb.importPaths([doc.path])
      if (!result.ok) {
        setError(result.error ?? '重试失败')
      } else if (result.documents?.[0]?.status === 'ready') {
        setNotice(`已重新入库：${doc.name}`)
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function remove(doc: KbDocument): Promise<void> {
    setBusy('删除中…')
    setError(null)
    setNotice(null)
    try {
      const result = await window.cad.kb.remove(doc.id)
      if (!result.ok) {
        setError(result.error ?? '删除失败')
      } else {
        setNotice(`已删除：${doc.name}`)
        setHits(null)
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function rebuild(): Promise<void> {
    setBusy('重建中…')
    setError(null)
    setNotice(null)
    try {
      const result = await window.cad.kb.rebuild()
      if (!result.ok) {
        setError(result.error ?? '重建失败')
      } else {
        setNotice(
          `重建完成：${result.documents} 个文档，${result.chunks} 个索引片段${
            result.failed ? `，${result.failed} 个失败` : ''
          }`
        )
        setHits(null)
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function search(): Promise<void> {
    if (!query.trim()) {
      return
    }
    setBusy('检索中…')
    setError(null)
    try {
      const result = await window.cad.kb.search(query)
      if (!result.ok) {
        setError(result.error ?? '检索失败')
        setHits([])
      } else {
        setHits(result.hits)
      }
    } finally {
      setBusy(null)
    }
  }

  const ready = documents.filter((doc) => doc.status === 'ready').length
  const failed = documents.length - ready
  const chunks = documents.reduce((total, doc) => total + doc.chunkCount, 0)

  return (
    <section className="panel kb">
      <div className="panel__heading">
        <h2>知识库</h2>
        <div className="panel__tools">
          <span className="muted">
            {ready} 个就绪 · {failed} 个失败 · {chunks} 个索引片段
          </span>
          <button type="button" onClick={importFiles} disabled={busy !== null}>
            导入文件…
          </button>
          <button type="button" onClick={rebuild} disabled={busy !== null}>
            重建索引
          </button>
          <button type="button" onClick={refresh} disabled={busy !== null}>
            刷新
          </button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {busy ? <p className="notice notice--info">{busy}</p> : null}
      {notice ? <p className="notice notice--success">{notice}</p> : null}

      {documents.length === 0 ? (
        <p className="muted">
          {loaded
            ? '尚未导入文档。支持 PDF、Word、DXF、CSV 参数表与扫描图（PNG/JPG）。'
            : '正在读取知识库…'}
        </p>
      ) : (
        <ul className="kb__documents">
          {documents.map((doc) => (
            <li key={doc.id}>
              <div className="kb__doc-main">
                <span className="kb__type">{TYPE_LABELS[doc.type] ?? doc.type}</span>
                <span className="kb__name" title={doc.path}>
                  {doc.name}
                </span>
                <span className={`kb__status kb__status--${doc.status}`}>
                  {doc.status === 'ready' ? '已就绪' : '失败'}
                </span>
                {doc.sourceType === 'vision' ? (
                  <span className="kb__vision">视觉识别</span>
                ) : null}
                {typeof doc.confidence === 'number' ? (
                  <span
                    className={
                      isLowConfidence(doc)
                        ? 'kb__confidence kb__confidence--low'
                        : 'kb__confidence'
                    }
                  >
                    置信 {doc.confidence.toFixed(2)}
                  </span>
                ) : null}
                <span className="kb__chunks">{doc.chunkCount} 片段</span>
                <div className="kb__doc-actions">
                  {doc.status === 'failed' ? (
                    <button
                      type="button"
                      title={`重试 ${doc.name}`}
                      onClick={() => retry(doc)}
                      disabled={busy !== null}
                    >
                      重试
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title={`删除 ${doc.name}`}
                    onClick={() => remove(doc)}
                    disabled={busy !== null}
                  >
                    删除
                  </button>
                </div>
              </div>
              {doc.status === 'failed' && doc.error ? (
                <p className="kb__error">{doc.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="kb__search">
        <div className="panel__heading">
          <h3>检索测试</h3>
          <span className="muted">命中结果带来源文件与位置</span>
        </div>
        <form
          className="kb__search-form"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <input
            type="text"
            value={query}
            placeholder="例如：沟底纵坡 0.3"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={busy !== null || !query.trim()}>
            检索
          </button>
        </form>

        {hits ? (
          hits.length === 0 ? (
            <p className="muted">没有命中片段。请调整关键词或先导入相关文档。</p>
          ) : (
            <ul className="kb__hits">
              {hits.map((hit) => (
                <li key={`${hit.docId}-${formatKbLocation(hit.location)}-${hit.text.slice(0, 12)}`}>
                  <div className="kb__hit-source">
                    <span className="kb__hit-name">{hit.docName}</span>
                    <span className="muted">{formatKbLocation(hit.location)}</span>
                    {hit.sourceType === 'vision' ? (
                      <span className="kb__vision">视觉识别</span>
                    ) : null}
                    {isLowConfidence(hit) ? (
                      <span className="kb__confidence kb__confidence--low">低置信</span>
                    ) : null}
                    <span className="kb__hit-score">{hit.score.toFixed(2)}</span>
                  </div>
                  <p className="kb__hit-text">{hit.text}</p>
                  {isLowConfidence(hit) ? (
                    <p className="kb__hit-warning">低置信识别结果，需人工核对，不能作为唯一依据。</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </section>
  )
}
