import type {
  DrawingBounds,
  DrawingEntity,
  DrawingLayer
} from '../../../shared/protocol'

export function planLayerLoads(layers: DrawingLayer[]): DrawingLayer[] {
  return layers
    .filter((layer) => layer.entityCount > 0)
    .sort(
      (a, b) =>
        a.entityCount - b.entityCount || a.name.localeCompare(b.name, 'zh-Hans-CN')
    )
}

export function boundsOfEntities(entities: DrawingEntity[]): DrawingBounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const include = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  for (const entity of entities) {
    if (entity.kind === 'line') {
      include(entity.start[0], entity.start[1])
      include(entity.end[0], entity.end[1])
    } else if (entity.kind === 'polyline') {
      for (const [x, y] of entity.points) {
        include(x, y)
      }
    } else if (entity.kind === 'circle' || entity.kind === 'arc') {
      const [x, y] = entity.center
      include(x - entity.radius, y - entity.radius)
      include(x + entity.radius, y + entity.radius)
    } else {
      const [x, y] = entity.insert
      include(x, y)
      include(x + entity.text.length * entity.height * 0.6, y + entity.height)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null
  }

  return { minX, minY, maxX, maxY }
}
