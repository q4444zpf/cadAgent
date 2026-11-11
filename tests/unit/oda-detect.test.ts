import { describe, expect, it } from 'vitest'
import { pickConverter } from '../../src/node/oda/detect'

const root = 'C:\\Program Files\\ODA'

function lookup(
  entries: string[],
  existing: string[],
  customPath?: string | null
): Parameters<typeof pickConverter>[0] {
  return {
    roots: [root],
    entries: () => entries,
    exists: (path) => existing.includes(path),
    customPath
  }
}

describe('ODA File Converter 检测', () => {
  it('多个版本并存时选择版本号最高的一份', () => {
    const result = pickConverter(
      lookup(
        ['ODAFileConverter 9.9.0', 'ODAFileConverter 27.10.0', 'ODAFileConverter 25.4.0'],
        [
          'C:\\Program Files\\ODA\\ODAFileConverter 9.9.0\\ODAFileConverter.exe',
          'C:\\Program Files\\ODA\\ODAFileConverter 27.10.0\\ODAFileConverter.exe',
          'C:\\Program Files\\ODA\\ODAFileConverter 25.4.0\\ODAFileConverter.exe'
        ]
      )
    )
    expect(result).toEqual({
      path: 'C:\\Program Files\\ODA\\ODAFileConverter 27.10.0\\ODAFileConverter.exe',
      version: '27.10.0'
    })
  })

  it('目录里没有可执行文件的版本被忽略', () => {
    const result = pickConverter(
      lookup(
        ['ODAFileConverter 27.10.0', 'ODAFileConverter 25.4.0'],
        ['C:\\Program Files\\ODA\\ODAFileConverter 25.4.0\\ODAFileConverter.exe']
      )
    )
    expect(result?.version).toBe('25.4.0')
  })

  it('自定义路径优先于自动扫描', () => {
    const custom = 'D:\\tools\\ODA\\ODAFileConverter.exe'
    const result = pickConverter(
      lookup(
        ['ODAFileConverter 27.10.0'],
        [custom, 'C:\\Program Files\\ODA\\ODAFileConverter 27.10.0\\ODAFileConverter.exe'],
        custom
      )
    )
    expect(result?.path).toBe(custom)
  })

  it('自定义路径指向不存在的文件时回退到自动扫描', () => {
    const result = pickConverter(
      lookup(
        ['ODAFileConverter 27.10.0'],
        ['C:\\Program Files\\ODA\\ODAFileConverter 27.10.0\\ODAFileConverter.exe'],
        'D:\\missing\\ODAFileConverter.exe'
      )
    )
    expect(result?.version).toBe('27.10.0')
  })

  it('未安装时返回 null', () => {
    expect(pickConverter(lookup([], []))).toBeNull()
  })
})
