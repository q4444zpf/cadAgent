import { useEffect, useMemo, useState } from 'react'
import type { Drawing, DrawingEntity } from '../../../shared/protocol'
import { DrawingCanvas } from './DrawingCanvas'
import { SummaryPreview } from './SummaryPreview'
import { boundsOfEntities, planLayerLoads } from './layers'

interface ProgressivePreviewProps {
  drawing: Drawing
  visibleLayers: ReadonlySet<string>
  highlight: ReadonlySet<string>
  fitSignal: number
}

interface LayerLoadState {
  loaded: number
  entities: DrawingEntity[]
  done: boolean
  error: string | null
}

export function ProgressivePreview({
  drawing,
  visibleLayers,
  highlight,
  fitSignal
}: ProgressivePreviewProps) {
  const plan = useMemo(() => planLayerLoads(drawing.layers), [drawing.layers])
  const [state, setState] = useState<LayerLoadState>({
    loaded: 0,
    entities: [],
    done: plan.length === 0,
    error: null
  })

  useEffect(() => {
    let cancelled = false
    const entities: DrawingEntity[] = []
    setState({ loaded: 0, entities: [], done: plan.length === 0, error: null })
    if (plan.length === 0) {
      return
    }

    void (async () => {
      try {
        for (let index = 0; index < plan.length; index += 1) {
          if (cancelled) {
            return
          }
          const result = await window.cad.drawing.layer(drawing.path, plan[index].name)
          if (cancelled) {
            return
          }
          if (!result.ok) {
            setState({
              loaded: index,
              entities: entities.slice(),
              done: true,
              error: result.error ?? '图层加载失败'
            })
            return
          }
          for (const entity of result.entities) {
            entities.push(entity)
          }
          setState({
            loaded: index + 1,
            entities: entities.slice(),
            done: index + 1 === plan.length,
            error: null
          })
        }
      } catch (failure) {
        if (!cancelled) {
          setState({
            loaded: 0,
            entities: entities.slice(),
            done: true,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [drawing.path, plan])

  const renderDrawing = useMemo<Drawing>(
    () => ({
      ...drawing,
      entities: state.entities,
      bounds: drawing.bounds ?? boundsOfEntities(state.entities),
      summaryOnly: false
    }),
    [drawing, state.entities]
  )

  const current = state.loaded < plan.length ? plan[state.loaded] : null
  const headline = state.error
    ? `图层加载中断：${state.error}`
    : state.done
      ? `图层已加载完成（${plan.length}/${plan.length}）`
      : current && state.loaded === 0
        ? '正在准备图层数据（首次需解析整张图纸）…'
        : current
          ? `正在加载图层 ${state.loaded + 1}/${plan.length}：${current.name}（${current.entityCount.toLocaleString()} 实体）`
          : '正在准备图层数据…'
  const percent = plan.length === 0 ? 100 : Math.round((state.loaded / plan.length) * 100)
  const hasGeometry = state.entities.length > 0

  return (
    <div className="progressive">
      <div className="layer-loader" role="status">
        <div className="layer-loader__head">
          <strong>大图纸摘要模式</strong>
          <span>{headline}</span>
        </div>
        <div
          className="layer-loader__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="muted">
          已加载 {state.entities.length.toLocaleString()} 个图元 · 按图层实体数从小到大加载，重图层最后
        </p>
        {state.error ? <p className="error">可重新打开图纸重试。</p> : null}
      </div>

      {hasGeometry ? (
        <DrawingCanvas
          key={drawing.path}
          drawing={renderDrawing}
          visibleLayers={visibleLayers}
          highlight={highlight}
          fitSignal={fitSignal}
        />
      ) : (
        <SummaryPreview drawing={drawing} />
      )}

      {hasGeometry ? (
        <details className="layer-loader__summary">
          <summary>摘要统计</summary>
          <SummaryPreview drawing={drawing} />
        </details>
      ) : null}
    </div>
  )
}
