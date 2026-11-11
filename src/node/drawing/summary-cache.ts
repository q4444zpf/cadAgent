import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DrawingSchema, type Drawing } from '../../shared/protocol'

export interface DrawingFileIdentity {
  path: string
  size: number
  mtimeMs: number
}

export function summaryCacheKey(identity: DrawingFileIdentity): string {
  return createHash('sha1')
    .update(`${identity.path}|${identity.size}|${identity.mtimeMs}`)
    .digest('hex')
}

export async function readSummaryCache(dir: string, key: string): Promise<Drawing | null> {
  try {
    const raw = await readFile(join(dir, `${key}.json`), 'utf8')
    const parsed = DrawingSchema.safeParse(JSON.parse(raw))
    return parsed.success && parsed.data.summaryOnly ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeSummaryCache(
  dir: string,
  key: string,
  drawing: Drawing
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${key}.json`), JSON.stringify(drawing), 'utf8')
  } catch {
    // 缓存失败不影响打开图纸
  }
}
