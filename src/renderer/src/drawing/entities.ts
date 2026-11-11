import type { Drawing, DrawingEntity } from '../../../shared/protocol'

export function pickVisibleEntities(
  drawing: Drawing,
  visibleLayers: ReadonlySet<string>
): DrawingEntity[] {
  return drawing.entities.filter((entity) => visibleLayers.has(entity.layer))
}
