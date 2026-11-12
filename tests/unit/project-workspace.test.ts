import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentKind,
  missingProjectFiles,
  resolveProjectInfo,
  resolveProjectPath,
  validateProjectFiles
} from '../../src/node/project/workspace'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cad-workspace-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('attachmentKind', () => {
  it('classifies supported project files', () => {
    expect(attachmentKind('图纸/a.DXF')).toBe('drawing')
    expect(attachmentKind('图纸/a.dwg')).toBe('drawing')
    expect(attachmentKind('资料/归档.zip')).toBe('archive')
    expect(attachmentKind('资料/归档.tar.gz')).toBe('archive')
    expect(attachmentKind('说明.pdf')).toBe('document')
    expect(attachmentKind('说明.docx')).toBe('document')
    expect(attachmentKind('参数.csv')).toBe('text')
    expect(attachmentKind('照片.JPG')).toBe('image')
    expect(attachmentKind('程序.exe')).toBe('other')
  })
})

describe('resolveProjectInfo', () => {
  it('returns the folder name for an existing directory', () => {
    const root = makeDir()

    expect(resolveProjectInfo(root)).toEqual({ root, name: root.split(/[\\/]/).at(-1) })
  })

  it('returns null for a missing path or a regular file', () => {
    const root = makeDir()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')

    expect(resolveProjectInfo(join(root, 'missing'))).toBeNull()
    expect(resolveProjectInfo(file)).toBeNull()
    expect(resolveProjectInfo(null)).toBeNull()
  })
})

describe('resolveProjectPath', () => {
  it('resolves a relative path inside the project', () => {
    const root = makeDir()

    expect(resolveProjectPath(root, '资料/归档.zip')).toBe(join(root, '资料', '归档.zip'))
  })

  it('rejects absolute paths, drive letters and parent traversal', () => {
    const root = makeDir()

    expect(() => resolveProjectPath(root, 'F:/outside/a.txt')).toThrow(/相对项目根/)
    expect(() => resolveProjectPath(root, 'C:\\outside\\a.txt')).toThrow(/相对项目根/)
    expect(() => resolveProjectPath(root, '../outside.txt')).toThrow(/超出项目范围/)
    expect(() => resolveProjectPath(root, '')).toThrow(/缺少路径/)
  })
})

describe('validateProjectFiles', () => {
  it('returns relative POSIX paths and sizes for project files', () => {
    const root = makeDir()
    mkdirSync(join(root, '资料'))
    writeFileSync(join(root, '资料', '归档.zip'), 'zip')
    writeFileSync(join(root, '说明.pdf'), 'pdf')

    const files = validateProjectFiles(root, [
      join(root, '资料', '归档.zip'),
      join(root, '说明.pdf')
    ])

    expect(files).toEqual([
      { path: '资料/归档.zip', name: '归档.zip', kind: 'archive', size: 3 },
      { path: '说明.pdf', name: '说明.pdf', kind: 'document', size: 3 }
    ])
  })

  it('rejects files outside the project, directories and missing paths', () => {
    const root = makeDir()
    const outside = makeDir()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(root, 'folder'))

    expect(() => validateProjectFiles(root, [join(outside, 'secret.txt')])).toThrow(
      /不在项目目录内/
    )
    expect(() => validateProjectFiles(root, [join(root, 'folder')])).toThrow(/不是文件/)
    expect(() => validateProjectFiles(root, [join(root, 'missing.txt')])).toThrow(/文件不存在/)
  })

  it('reports attachments that disappeared or escaped the project', () => {
    const root = makeDir()
    writeFileSync(join(root, 'a.txt'), 'x')
    mkdirSync(join(root, 'folder'))

    expect(missingProjectFiles(root, ['a.txt', 'gone.txt', 'folder', '../outside.txt'])).toEqual([
      'gone.txt',
      'folder',
      '../outside.txt'
    ])
  })

  it('rejects the whole batch when more than ten files are selected', () => {
    const root = makeDir()
    const paths = Array.from({ length: 11 }, (_, index) => {
      const file = join(root, `f${index}.txt`)
      writeFileSync(file, 'x')
      return file
    })

    expect(() => validateProjectFiles(root, paths)).toThrow(/最多选择 10 个文件/)
  })
})
