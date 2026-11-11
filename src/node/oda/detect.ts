import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConverterStatus } from '../../shared/protocol'

const EXE_NAME = 'ODAFileConverter.exe'
const VERSIONED_DIR = /^ODAFileConverter\s+(.+)$/i

export interface ConverterLookup {
  roots: string[]
  entries?: (root: string) => string[]
  exists: (path: string) => boolean
  customPath?: string | null
}

export interface ConverterMatch {
  path: string
  version: string
}

export function pickConverter(lookup: ConverterLookup): ConverterMatch | null {
  const custom = lookup.customPath?.trim()
  if (custom && basename(custom).toLowerCase() === EXE_NAME.toLowerCase() && lookup.exists(custom)) {
    const version = VERSIONED_DIR.exec(basename(dirname(custom)))?.[1] ?? ''
    return { path: custom, version }
  }

  const candidates: ConverterMatch[] = []
  for (const root of lookup.roots) {
    let names: string[] = []
    try {
      names = lookup.entries ? lookup.entries(root) : []
    } catch {
      continue
    }
    for (const name of names) {
      const version = VERSIONED_DIR.exec(name)?.[1]
      if (!version) {
        continue
      }
      const exe = join(root, name, EXE_NAME)
      if (lookup.exists(exe)) {
        candidates.push({ path: exe, version })
      }
    }
  }

  candidates.sort((left, right) => compareVersions(right.version, left.version))
  return candidates[0] ?? null
}

export function detectOdaConverter(customPath?: string | null): ConverterStatus {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, 'ODA'))

  const match = pickConverter({
    roots,
    entries: (root) => readdirSync(root),
    exists: existsSync,
    customPath: customPath ?? process.env.ODA_FILE_CONVERTER ?? null
  })

  if (!match) {
    return { found: false, path: null }
  }
  return {
    found: true,
    path: match.path,
    ...(match.version ? { version: match.version } : {})
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}
