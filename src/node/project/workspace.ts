import { statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileAttachment, ProjectInfo } from '../../shared/protocol'

export const MAX_ATTACHMENTS = 10

const ARCHIVE_SUFFIXES = ['.zip', '.tar', '.tar.gz', '.tgz']
const DRAWING_SUFFIXES = ['.dxf', '.dwg']
const DOCUMENT_SUFFIXES = ['.pdf', '.docx']
const TEXT_SUFFIXES = ['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.log', '.ini', '.cfg', '.sql']
const IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg']

export function attachmentKind(filePath: string): FileAttachment['kind'] {
  const name = basename(filePath).toLowerCase()
  if (ARCHIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'archive'
  }
  if (DRAWING_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'drawing'
  }
  if (DOCUMENT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'document'
  }
  if (TEXT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'text'
  }
  if (IMAGE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'image'
  }
  return 'other'
}

export function resolveProjectInfo(root: string | null): ProjectInfo | null {
  if (!root) {
    return null
  }
  try {
    const resolved = resolve(root)
    return statSync(resolved).isDirectory() ? { root: resolved, name: basename(resolved) } : null
  } catch {
    return null
  }
}

export function resolveProjectPath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('缺少路径参数')
  }
  if (
    isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith('\\\\') ||
    relativePath.startsWith('//')
  ) {
    throw new Error(`请使用相对项目根的路径：${relativePath}`)
  }
  const rootPath = resolve(root)
  const resolved = resolve(rootPath, relativePath)
  const relativePathFromRoot = relative(rootPath, resolved)
  if (
    relativePathFromRoot === '..' ||
    relativePathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error(`路径超出项目范围：${relativePath}`)
  }
  return resolved
}

export function missingProjectFiles(root: string, relativePaths: string[]): string[] {
  return relativePaths.filter((relativePath) => {
    try {
      const info = statSync(resolveProjectPath(root, relativePath), { throwIfNoEntry: false })
      return !info || !info.isFile()
    } catch {
      return true
    }
  })
}

export function validateProjectFiles(root: string, filePaths: string[]): FileAttachment[] {
  if (filePaths.length === 0) {
    throw new Error('没有选择文件')
  }
  if (filePaths.length > MAX_ATTACHMENTS) {
    throw new Error(`一次最多选择 ${MAX_ATTACHMENTS} 个文件`)
  }

  const rootPath = resolve(root)
  return filePaths.map((filePath) => {
    const resolved = resolve(filePath)
    const relativePath = relative(rootPath, resolved)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`文件不在项目目录内：${filePath}`)
    }
    const info = statSync(resolved, { throwIfNoEntry: false })
    if (!info) {
      throw new Error(`文件不存在：${relativePath}`)
    }
    if (!info.isFile()) {
      throw new Error(`不是文件：${relativePath}`)
    }
    return {
      path: relativePath.replace(/\\/g, '/'),
      name: basename(resolved),
      kind: attachmentKind(resolved),
      size: info.size
    }
  })
}
