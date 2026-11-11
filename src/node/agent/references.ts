import type { Drawing, EntityReference } from '../../shared/protocol'

const HANDLE_PATTERN = /#([0-9A-Za-z_-]{1,32})/g

export function extractReferences(text: string, drawing: Drawing | null): EntityReference[] {
  const seen = new Set<string>()
  const references: EntityReference[] = []

  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const raw = match[1]
    const key = raw.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const entity = drawing?.entities.find((candidate) => candidate.handle.toLowerCase() === key)
    references.push(
      entity
        ? { handle: entity.handle, exists: true, kind: entity.kind, layer: entity.layer }
        : { handle: raw, exists: false }
    )
  }

  return references
}
