import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildConverterArgs,
  convertDwgToDxf,
  createConverterRunner,
  dwgCacheKey
} from '../../src/node/dwg/convert'

let dir = ''
let dwgPath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cad-dwg-convert-'))
  dwgPath = join(dir, 'source.dwg')
  await writeFile(dwgPath, 'DWG')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DWG 自动转换', () => {
  it('按 ODA 命令行约定构造参数，只转换目标文件', () => {
    expect(
      buildConverterArgs('F:\\图纸\\原始测量(1).dwg', 'C:\\temp\\out')
    ).toEqual([
      'F:\\图纸',
      'C:\\temp\\out',
      'ACAD2018',
      'DXF',
      '0',
      '1',
      '原始测量(1).dwg'
    ])
  })

  it('命中缓存时直接复用已转换的 DXF，不再调用转换器', async () => {
    const cacheDir = join(dir, 'cache')
    const info = await stat(dwgPath)
    const cached = join(cacheDir, `${dwgCacheKey({ path: dwgPath, size: info.size, mtimeMs: info.mtimeMs })}.dxf`)
    await mkdir(cacheDir)
    await writeFile(cached, 'DXF')

    let runs = 0
    const result = await convertDwgToDxf(dwgPath, {
      converterPath: 'ODAFileConverter.exe',
      cacheDir,
      run: async () => {
        runs += 1
        return { code: 0, stderr: '' }
      }
    })

    expect(result).toBe(cached)
    expect(runs).toBe(0)
  })

  it('缓存未命中时调用转换器，把产出的 DXF 存入缓存并返回其路径', async () => {
    const cacheDir = join(dir, 'cache')
    const calls: string[][] = []
    const result = await convertDwgToDxf(dwgPath, {
      converterPath: 'ODAFileConverter.exe',
      cacheDir,
      run: async (args) => {
        calls.push(args)
        await mkdir(args[1], { recursive: true })
        await writeFile(join(args[1], 'source.dxf'), 'converted')
        return { code: 0, stderr: '' }
      }
    })

    const info = await stat(dwgPath)
    expect(result).toBe(
      join(cacheDir, `${dwgCacheKey({ path: dwgPath, size: info.size, mtimeMs: info.mtimeMs })}.dxf`)
    )
    await expect(readFile(result, 'utf8')).resolves.toBe('converted')
    expect(calls).toHaveLength(1)
    const [inFolder, outFolder, ...rest] = calls[0]
    expect(inFolder).toBe(dir)
    expect(outFolder).not.toBe(cacheDir)
    expect(rest).toEqual(['ACAD2018', 'DXF', '0', '1', 'source.dwg'])
  })

  it('转换完成后清理临时输出目录', async () => {
    let outDir = ''
    await convertDwgToDxf(dwgPath, {
      converterPath: 'ODAFileConverter.exe',
      cacheDir: join(dir, 'cache'),
      run: async (args) => {
        outDir = args[1]
        await mkdir(outDir, { recursive: true })
        await writeFile(join(outDir, 'source.dxf'), 'converted')
        return { code: 0, stderr: '' }
      }
    })

    await expect(stat(outDir)).rejects.toThrow()
  })

  it('转换器非零退出时报告退出码与错误输出', async () => {
    await expect(
      convertDwgToDxf(dwgPath, {
        converterPath: 'ODAFileConverter.exe',
        cacheDir: join(dir, 'cache'),
        run: async () => ({ code: 1, stderr: 'converter exploded' })
      })
    ).rejects.toThrow(/退出码 1.*converter exploded/)
  })

  it('转换器没有产出 DXF 时报告失败原因', async () => {
    await expect(
      convertDwgToDxf(dwgPath, {
        converterPath: 'ODAFileConverter.exe',
        cacheDir: join(dir, 'cache'),
        run: async () => ({ code: 0, stderr: 'silent failure' })
      })
    ).rejects.toThrow(/未生成 DXF.*silent failure/)
  })

  it('转换超时时直接失败且不写入缓存', async () => {
    const cacheDir = join(dir, 'cache')
    await expect(
      convertDwgToDxf(dwgPath, {
        converterPath: 'ODAFileConverter.exe',
        cacheDir,
        run: async () => {
          throw new Error('DWG 转换超时（300 秒）')
        }
      })
    ).rejects.toThrow('DWG 转换超时（300 秒）')
    await expect(stat(cacheDir)).rejects.toThrow()
  })

  it('默认运行器执行命令并返回退出码与错误输出', async () => {
    const run = createConverterRunner(process.execPath)
    const result = await run(
      ['-e', 'process.stderr.write("warn")'],
      10_000
    )
    expect(result).toEqual({ code: 0, stderr: 'warn' })
  })

  it('默认运行器超时后终止进程并报告超时', async () => {
    const run = createConverterRunner(process.execPath)
    const started = Date.now()
    await expect(run(['-e', 'setTimeout(() => {}, 60_000)'], 300)).rejects.toThrow(
      /DWG 转换超时/
    )
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
