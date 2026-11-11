import { drawingEntityCount, type Drawing } from '../../../shared/protocol'

export function SummaryPreview({ drawing }: { drawing: Drawing }) {
  const counts = Object.entries(drawing.entityCounts ?? {}).sort((a, b) => b[1] - a[1])
  const textSamples = drawing.textSamples ?? []

  return (
    <div className="preview-summary">
      <strong>大图纸摘要模式</strong>
      <p>
        该图纸超过 50 MB，已按摘要方式加载：只统计图层与实体类型，不展开几何图形，因此不显示图形预览。
      </p>
      <p className="muted">
        读图问答仍可用于数量、图层、结构与文字标注类问题；按实体检索与高亮暂不可用。
      </p>
      <dl className="summary-facts">
        <div>
          <dt>实体总数</dt>
          <dd>{drawingEntityCount(drawing).toLocaleString()}</dd>
        </div>
        <div>
          <dt>图层</dt>
          <dd>{drawing.layers.length}</dd>
        </div>
        <div>
          <dt>文字样例</dt>
          <dd>{textSamples.length}</dd>
        </div>
      </dl>
      <div className="summary-block">
        <h3>实体类型</h3>
        <ul className="summary-counts">
          {counts.map(([type, count]) => (
            <li key={type}>
              <span>{type}</span>
              <span>{count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
      {textSamples.length > 0 ? (
        <div className="summary-block">
          <h3>文字样例（前 24 条）</h3>
          <div className="summary-texts">
            {textSamples.slice(0, 24).map((text, index) => (
              <span key={`${text}-${index}`}>{text}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
