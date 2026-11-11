import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface ConverterRunnerResult {
  code: number
  stderr: string
}

export type ConverterRunner = (args: string[], timeoutMs: number) => Promise<ConverterRunnerResult>

export interface ConvertDwgOptions {
  converterPath: string
  cacheDir: string
  timeoutMs?: number
  run?: ConverterRunner
}

export interface DwgFileIdentity {
  path: string
  size: number
  mtimeMs: number
}

export function dwgCacheKey(identity: DwgFileIdentity): string {
  return createHash('sha1')
    .update(`${identity.path}|${identity.size}|${identity.mtimeMs}`)
    .digest('hex')
}

export function buildConverterArgs(dwgPath: string, outDir: string): string[] {
  return [dirname(dwgPath), outDir, 'ACAD2018', 'DXF', '0', '1', basename(dwgPath)]
}

export async function convertDwgToDxf(
  dwgPath: string,
  options: ConvertDwgOptions
): Promise<string> {
  const info = await stat(dwgPath)
  const cached = join(
    options.cacheDir,
    `${dwgCacheKey({ path: dwgPath, size: info.size, mtimeMs: info.mtimeMs })}.dxf`
  )
  const cachedInfo = await stat(cached).catch(() => null)
  if (cachedInfo && cachedInfo.size > 0) {
    return cached
  }

  const outDir = await mkdtemp(join(tmpdir(), 'cad-agent-dwg-'))
  try {
    const result = await runConverter(options, buildConverterArgs(dwgPath, outDir))
    if (result.code !== 0) {
      throw new Error(`DWG 转换失败：转换器退出码 ${result.code}${stderrTail(result.stderr)}`)
    }
    const output = await findConvertedDxf(outDir, basename(dwgPath))
    if (!output) {
      throw new Error(`DWG 转换失败：未生成 DXF 文件${stderrTail(result.stderr)}`)
    }
    await mkdir(options.cacheDir, { recursive: true })
    await rename(output, cached).catch(async () => {
      await copyFile(output, cached)
    })
    return cached
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

async function runConverter(
  options: ConvertDwgOptions,
  args: string[]
): Promise<ConverterRunnerResult> {
  const run = options.run ?? createConverterRunner(options.converterPath)
  return run(args, options.timeoutMs ?? 300_000)
}

export function createConverterRunner(converterPath: string): ConverterRunner {
  return (args, timeoutMs) =>
    new Promise<ConverterRunnerResult>((resolve, reject) => {
      const child = spawn(converterPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(() =>
          reject(new Error(`DWG 转换超时（${Math.ceil(timeoutMs / 1000)} 秒），转换器已终止`))
        )
      }, timeoutMs)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stderr })))
    })
}

async function findConvertedDxf(outDir: string, sourceName: string): Promise<string | null> {
  const expected = `${sourceName.replace(/\.dwg$/i, '')}.dxf`.toLowerCase()
  const names = await readdir(outDir).catch(() => [])
  const match = names.find((name) => name.toLowerCase() === expected)
  return match ? join(outDir, match) : null
}

function stderrTail(stderr: string): string {
  const text = stderr.trim().replace(/\s+/g, ' ')
  return text ? `（${text.slice(-300)}）` : ''
}

