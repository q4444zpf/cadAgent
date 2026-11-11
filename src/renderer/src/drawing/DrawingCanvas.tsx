import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Drawing } from '../../../shared/protocol'
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
    setView(
      drawing.bounds ? createFitTransform(drawing.bounds, size.width, size.height, PADDING) : null
    )
  }, [drawing, fitSignal, size.width, size.height])

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
    context.lineCap = 'round'
    context.lineJoin = 'round'

    for (const entity of pickVisibleEntities(drawing, visibleLayers)) {
      const highlighted = highlight.has(entity.handle)
      const color = highlighted
        ? HIGHLIGHT_COLOR
        : resolveEntityColor(entity.color, layerColors.get(entity.layer) ?? 7)
      context.strokeStyle = color
      context.fillStyle = color
      context.lineWidth = highlighted ? 4 : 1.3

      if (entity.kind === 'line') {
        const [x1, y1] = worldToScreen(view, entity.start[0], entity.start[1])
        const [x2, y2] = worldToScreen(view, entity.end[0], entity.end[1])
        context.beginPath()
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
        context.stroke()
      } else if (entity.kind === 'polyline') {
        context.beginPath()
        entity.points.forEach(([x, y], index) => {
          const [sx, sy] = worldToScreen(view, x, y)
          if (index === 0) {
            context.moveTo(sx, sy)
          } else {
            context.lineTo(sx, sy)
          }
        })
        if (entity.closed) {
          context.closePath()
        }
        context.stroke()
      } else if (entity.kind === 'circle' || entity.kind === 'arc') {
        const radius = entity.radius * view.scale
        if (radius < 0.5) {
          continue
        }
        const [cx, cy] = worldToScreen(view, entity.center[0], entity.center[1])
        context.beginPath()
        if (entity.kind === 'circle') {
          context.arc(cx, cy, radius, 0, Math.PI * 2)
        } else {
          const start = -entity.startAngle * (Math.PI / 180)
          const end = -entity.endAngle * (Math.PI / 180)
          context.arc(cx, cy, radius, start, end, true)
        }
        context.stroke()
      } else {
        const fontSize = entity.height * view.scale
        if (fontSize < 4) {
          continue
        }
        const [sx, sy] = worldToScreen(view, entity.insert[0], entity.insert[1])
        context.font = `${fontSize}px "Microsoft YaHei UI", "PingFang SC", sans-serif`
        context.textBaseline = 'alphabetic'
        context.save()
        context.translate(sx, sy)
        context.rotate(-entity.rotation * (Math.PI / 180))
        context.fillText(entity.text, 0, 0)
        context.restore()
      }
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
