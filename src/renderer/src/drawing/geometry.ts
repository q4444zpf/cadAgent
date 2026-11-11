import type { DrawingBounds } from '../../../shared/protocol'

export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
  height: number
}

export function createFitTransform(
  bounds: DrawingBounds,
  width: number,
  height: number,
  padding: number
): ViewTransform {
  const boxWidth = Math.max(bounds.maxX - bounds.minX, Number.EPSILON)
  const boxHeight = Math.max(bounds.maxY - bounds.minY, Number.EPSILON)
  const scale = Math.min(
    Math.max(width - padding * 2, 0) / boxWidth,
    Math.max(height - padding * 2, 0) / boxHeight
  )
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1

  return {
    scale: safeScale,
    offsetX: (width - boxWidth * safeScale) / 2 - bounds.minX * safeScale,
    offsetY: (height - boxHeight * safeScale) / 2 - bounds.minY * safeScale,
    height
  }
}

export function worldToScreen(view: ViewTransform, x: number, y: number): [number, number] {
  return [view.offsetX + x * view.scale, view.height - (view.offsetY + y * view.scale)]
}

export function screenToWorld(view: ViewTransform, sx: number, sy: number): [number, number] {
  return [(sx - view.offsetX) / view.scale, (view.height - sy - view.offsetY) / view.scale]
}

export function zoomAt(view: ViewTransform, sx: number, sy: number, factor: number): ViewTransform {
  const [worldX, worldY] = screenToWorld(view, sx, sy)
  const scale = view.scale * factor

  return {
    ...view,
    scale,
    offsetX: sx - worldX * scale,
    offsetY: view.height - sy - worldY * scale
  }
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY - dy }
}
