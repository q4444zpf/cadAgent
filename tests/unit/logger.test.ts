import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppLogger } from '../../src/node/logging/logger'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cad-logger-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('AppLogger', () => {
  it('把日志写入文件并读取尾部若干行', async () => {
    const logger = new AppLogger({ filePath: join(root, 'logs', 'app.log') })
    logger.write('info', 'sidecar', '服务就绪')
    logger.write('error', 'parse', '解析失败', 'handler_error: bad group')

    const lines = logger.readTail(10)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[info] sidecar 服务就绪')
    expect(lines[1]).toContain('[error] parse 解析失败')
    expect(lines[1]).toContain('bad group')
  })

  it('超过大小上限时轮转，当前文件保留最新内容', async () => {
    const filePath = join(root, 'app.log')
    const logger = new AppLogger({ filePath, maxBytes: 1200 })
    for (let index = 0; index < 20; index += 1) {
      logger.write('info', 'test', `第 ${index} 条日志`)
    }

    const rotated = await stat(`${filePath}.1`).then(
      () => true,
      () => false
    )
    expect(rotated).toBe(true)
    const current = await readFile(filePath, 'utf8')
    const rotatedText = await readFile(`${filePath}.1`, 'utf8')
    expect(current).toContain('第 19 条日志')
    expect(rotatedText).toContain('第 0 条日志')
    expect(current.length).toBeLessThanOrEqual(1200)
  })

  it('日志中的疑似密钥会被脱敏', async () => {
    const logger = new AppLogger({ filePath: join(root, 'app.log') })
    logger.write('error', 'model', '请求失败', 'Authorization: Bearer sk-abcdef1234567890')

    const text = await readFile(join(root, 'app.log'), 'utf8')
    expect(text).not.toContain('sk-abcdef1234567890')
    expect(text).toContain('sk-***')
  })

  it('目录被删除后仍能继续写入', async () => {
    const filePath = join(root, 'nested', 'logs', 'app.log')
    const logger = new AppLogger({ filePath })
    logger.write('info', 'app', '第一次')
    await rm(join(root, 'nested'), { recursive: true, force: true })
    logger.write('info', 'app', '第二次')
    await mkdir(join(root, 'nested', 'logs'), { recursive: true }).catch(() => undefined)
    const text = await readFile(filePath, 'utf8').catch(() => '')
    expect(text).toContain('第二次')
  })

  it('读取尾部时跳过损坏的行并限制条数', async () => {
    const filePath = join(root, 'app.log')
    const logger = new AppLogger({ filePath })
    logger.write('info', 'app', '第一条')
    logger.write('info', 'app', '第二条')
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}not-json\n`, 'utf8')

    const lines = logger.readTail(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('第二条')
  })
})
