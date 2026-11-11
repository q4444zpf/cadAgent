import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Drawing, DrawingEntity } from '../../../shared/protocol'
import { resolveEntityColor } from './aci'
import { pickVisibleEntities } from './entities'
import {
  createFitTransform,
  panBy,
  worldToScreen,
  zoomAt,
  type ViewTransform
} from './geometry'

const PADDING = 28
const HIGHLIGHT_COLOR = '#fbbf24'

interface DrawingCanvasProps {
  drawing: Drawing
  visibleLayers: ReadonlySet<string>
  highlight: ReadonlySet<string>
  fitSignal: number
}

export function DrawingCanvas({
  drawing,
  visibleLayers,
  highlight,
  fitSignal
}: DrawingCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const lastFitRef = useRef<{ signal: number; width: number; height: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<ViewTransform | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) {
      return
    }
    const observer = new ResizeObserver(() => {
      setSize({ width: wrapper.clientWidth, height: wrapper.clientHeight })
    })
    observer.observe(wrapper)
    setSize({ width: wrapper.clientWidth, height: wrapper.clientHeight })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!size.width || !size.height) {
      return
    }
    const bounds = drawing.bounds
    if (!bounds) {
      return
    }
    const previous = lastFitRef.current
    const shouldFit =
      !previous ||
      previous.signal !== fitSignal ||
      previous.width !== size.width ||
      previous.height !== size.height
    if (!shouldFit) {
      return
    }
    lastFitRef.current = { signal: fitSignal, width: size.width, height: size.height }
    setView(createFitTransform(bounds, size.width, size.height, PADDING))
  }, [
    drawing.bounds?.minX,
    drawing.bounds?.minY,
    drawing.bounds?.maxX,
    drawing.bounds?.maxY,
    fitSignal,
    size.width,
    size.height
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = '#0b1220'
    context.fillRect(0, 0, size.width, size.height)

    if (!view) {
      return
    }

    const layerColors = new Map(drawing.layers.map((layer) => [layer.name, layer.color]))
    const strokeGroups = new Map<string, StrokeEntity[]>()
    const highlightedStrokes: StrokeEntity[] = []
    const texts: { entity: Extract<DrawingEntity, { kind: 'text' }>; color: string }[] = []

    for (const entity of pickVisibleEntities(drawing, visibleLayers)) {
      const highlighted = highlight.has(entity.handle)
      const color = highlighted
        ? HIGHLIGHT_COLOR
        : resolveEntityColor(entity.color, layerColors.get(entity.layer) ?? 7)

      if (entity.kind === 'text') {
        texts.push({ entity, color })
        continue
      }
      if (highlighted) {
        highlightedStrokes.push(entity)
        continue
      }
      const group = strokeGroups.get(color)
      if (group) {
        group.push(entity)
      } else {
        strokeGroups.set(color, [entity])
      }
    }

    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 1.3

    for (const [color, entities] of strokeGroups) {
      context.strokeStyle = color
      context.beginPath()
      for (const entity of entities) {
        appendStrokePath(context, view, entity)
      }
      context.stroke()
    }

    if (highlightedStrokes.length > 0) {
      context.strokeStyle = HIGHLIGHT_COLOR
      context.lineWidth = 4
      context.beginPath()
      for (const entity of highlightedStrokes) {
        appendStrokePath(context, view, entity)
      }
      context.stroke()
    }

    for (const { entity, color } of texts) {
      drawText(context, view, entity, color)
    }
  }, [drawing, visibleLayers, highlight, view, size.width, size.height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const sx = event.clientX - rect.left
      const sy = event.clientY - rect.top
      const factor = Math.exp(-event.deltaY * 0.0015)
      setView((current) => (current ? zoomAt(current, sx, sy, factor) : current))
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [])

  function fit(): void {
    if (drawing.bounds && size.width && size.height) {
      setView(createFitTransform(drawing.bounds, size.width, size.height, PADDING))
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    dragRef.current = { x: event.clientX, y: event.clientY }
    setView((current) => (current ? panBy(current, dx, dy) : current))
  }

  function handlePointerUp(): void {
    dragRef.current = null
  }

  return (
    <div className="canvas-wrap" ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className="drawing-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={fit}
      />
      {!drawing.bounds ? (
        <p className="canvas-hint">该图纸中没有可显示的模型空间图形</p>
      ) : null}
    </div>
  )
}

type StrokeEntity = Exclude<DrawingEntity, { kind: 'text' }>
type TextEntity = Extract<DrawingEntity, { kind: 'text' }>

function appendStrokePath(
  context: CanvasRenderingContext2D,
  view: ViewTransform,
  entity: StrokeEntity
): void {
  if (entity.kind === 'line') {
    const [x1, y1] = worldToScreen(view, entity.start[0], entity.start[1])
    const [x2, y2] = worldToScreen(view, entity.end[0], entity.end[1])
    if (Math.abs(x2 - x1) < 0.25 && Math.abs(y2 - y1) < 0.25) {
      return
    }
    context.moveTo(x1, y1)
    context.lineTo(x2, y2)
    return
  }

  if (entity.kind === 'polyline') {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const points = entity.points.map(([x, y]) => {
      const [sx, sy] = worldToScreen(view, x, y)
      minX = Math.min(minX, sx)
      minY = Math.min(minY, sy)
      maxX = Math.max(maxX, sx)
      maxY = Math.max(maxY, sy)
      return [sx, sy] as const
    })
    if (maxX - minX < 0.25 && maxY - minY < 0.25) {
      return
    }
    points.forEach(([sx, sy], index) => {
      if (index === 0) {
        context.moveTo(sx, sy)
      } else {
        context.lineTo(sx, sy)
      }
    })
    if (entity.closed) {
      context.closePath()
    }
    return
  }

  const radius = entity.radius * view.scale
  if (radius < 0.5) {
    return
  }
  const [cx, cy] = worldToScreen(view, entity.center[0], entity.center[1])
  if (entity.kind === 'circle') {
    context.moveTo(cx + radius, cy)
    context.arc(cx, cy, radius, 0, Math.PI * 2)
    return
  }
  const start = -entity.startAngle * (Math.PI / 180)
  const end = -entity.endAngle * (Math.PI / 180)
  context.moveTo(cx + radius * Math.cos(start), cy + radius * Math.sin(start))
  context.arc(cx, cy, radius, start, end, true)
}

function drawText(
  context: CanvasRenderingContext2D,
  view: ViewTransform,
  entity: TextEntity,
  color: string
): void {
  const fontSize = entity.height * view.scale
  if (fontSize < 4) {
    return
  }
  const [sx, sy] = worldToScreen(view, entity.insert[0], entity.insert[1])
  context.fillStyle = color
  context.font = `${fontSize}px "Microsoft YaHei UI", "PingFang SC", sans-serif`
  context.textBaseline = 'alphabetic'
  context.save()
  context.translate(sx, sy)
  context.rotate(-entity.rotation * (Math.PI / 180))
  context.fillText(entity.text, 0, 0)
  context.restore()
}
