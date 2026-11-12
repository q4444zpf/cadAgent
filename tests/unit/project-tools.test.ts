import { describe, expect, it } from 'vitest'
import { createProjectTools, formatAttachmentContext } from '../../src/node/agent/project-tools'
import type { SidecarClient } from '../../src/node/sidecar/client'
import type { FileAttachment, ProjectScanResult } from '../../src/shared/protocol'

const ATTACHMENT: FileAttachment = {
  path: '图纸/a.dxf',
  name: 'a.dxf',
  kind: 'drawing',
  size: 2048
}

function scanResult(entryCount: number): ProjectScanResult {
  return {
    path: '.',
    entries: Array.from({ length: entryCount }, (_, index) => ({
      name: `f${index}.txt`,
      path: `f${index}.txt`,
      type: 'file',
      size: 1,
      mtimeMs: 0
    })),
    totals: { files: entryCount, dirs: 0, archives: 0 },
    byExtension: { txt: entryCount },
    truncated: false,
    ignored: [],
    warnings: []
  }
}

function setup(options: { root?: string | null } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const sidecar = {
    scanProject: async (...args: unknown[]) => {
      calls.push({ method: 'scanProject', args })
      return scanResult(60)
    },
    listArchive: async (...args: unknown[]) => {
      calls.push({ method: 'listArchive', args })
      return {
        path: 'a.zip',
        format: 'zip',
        entryCount: 1,
        totalUncompressedBytes: 1,
        entries: [{ name: 'a.txt', size: 1, compressedSize: 1, isDir: false, isLink: false, modifiedAt: null }],
        truncated: false
      }
    },
    extractArchive: async (...args: unknown[]) => {
      calls.push({ method: 'extractArchive', args })
      return {
        path: 'a.zip',
        target: 'a_解压',
        filesExtracted: 1,
        directoriesCreated: 0,
        bytesExtracted: 1
      }
    },
    readFile: async (...args: unknown[]) => {
      calls.push({ method: 'readFile', args })
      return {
        path: 'note.txt',
        kind: 'text',
        size: 20000,
        truncated: false,
        encoding: 'utf-8',
        content: 'x'.repeat(20000)
      }
    }
  } as unknown as SidecarClient
  const opened: string[] = []
  const tools = createProjectTools({
    getRoot: () => (options.root === undefined ? 'F:/proj' : options.root),
    sidecar,
    openDrawing: async (filePath) => {
      opened.push(filePath)
      return {
        ok: true,
        drawing: {
          path: filePath,
          name: 'a.dxf',
          layers: [{ name: 'WALLS', color: 1, entityCount: 1 }],
          entities: [],
          bounds: null,
          unsupported: {},
          summaryOnly: true
        }
      }
    }
  })
  return {
    calls,
    opened,
    run: (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find((item) => item.name === name)
      if (!tool) {
        throw new Error(`missing tool ${name}`)
      }
      return tool.execute('call-1', args)
    }
  }
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details
}

describe('project tools', () => {
  it('fails with a clear message when no project is open', async () => {
    const { run, calls } = setup({ root: null })

    const result = await run('scan_project')

    expect(result).toMatchObject({ isError: true })
    expect(details(result).error).toContain('请先打开项目文件夹')
    expect(calls).toHaveLength(0)
  })

  it('scans with default path and truncates the entry list', async () => {
    const { run, calls } = setup()

    const result = await run('scan_project', { extension: 'txt' })

    expect(calls[0]).toEqual({ method: 'scanProject', args: ['F:/proj', '.', { extension: 'txt' }] })
    const data = details(result)
    expect((data.entries as unknown[]).length).toBe(50)
    expect(data.omittedEntries).toBe(10)
    expect(data.totals).toEqual({ files: 60, dirs: 0, archives: 0 })
  })

  it('rejects absolute paths and traversal before calling the sidecar', async () => {
    const { run, calls } = setup()

    const absolute = await run('read_file', { path: 'F:/secret.txt' })
    const traversal = await run('list_archive', { path: '../a.zip' })

    expect(absolute).toMatchObject({ isError: true })
    expect(details(absolute).error).toContain('相对项目根')
    expect(traversal).toMatchObject({ isError: true })
    expect(details(traversal).error).toContain('超出项目范围')
    expect(calls).toHaveLength(0)
  })

  it('forwards archive operations and returns their results', async () => {
    const { run, calls } = setup()

    await run('list_archive', { path: '资料/a.zip' })
    const extracted = await run('extract_archive', { path: '资料/a.zip', target: '资料/解压' })

    expect(calls[0]).toEqual({
      method: 'listArchive',
      args: ['F:/proj', '资料/a.zip']
    })
    expect(calls[1]).toEqual({
      method: 'extractArchive',
      args: ['F:/proj', '资料/a.zip', '资料/解压']
    })
    expect(details(extracted)).toMatchObject({ target: 'a_解压', filesExtracted: 1 })
  })

  it('truncates long file content before returning it to the model', async () => {
    const { run } = setup()

    const result = await run('read_file', { path: 'note.txt' })

    const data = details(result)
    expect((data.content as string).length).toBe(8000)
    expect(data.contentTruncated).toBe(true)
  })

  it('opens a project drawing through the injected loader', async () => {
    const { run, opened } = setup()

    const result = await run('open_project_drawing', { path: '图纸/a.dxf' })

    expect(opened[0]?.replace(/\\/g, '/')).toBe('F:/proj/图纸/a.dxf')
    expect(details(result)).toMatchObject({ name: 'a.dxf', layerCount: 1, summaryOnly: true })
  })

  it('formats attachments into the prompt with paths and sizes', () => {
    const prompt = formatAttachmentContext('对比说明和图纸', [ATTACHMENT])

    expect(prompt).toContain('用户附加的文件（相对项目根）：')
    expect(prompt).toContain('- 图纸/a.dxf（图纸，2.0 KB）')
    expect(prompt).toContain('不要臆测文件内容')
    expect(prompt.endsWith('对比说明和图纸')).toBe(true)
    expect(formatAttachmentContext('你好')).toBe('你好')
  })
})
