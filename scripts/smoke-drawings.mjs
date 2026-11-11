import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MB = 1024 * 1024

function ensureOversizeFixture() {
  const path = join(root, 'out', 'fixtures', 'oversize.dxf')
  if (existsSync(path) && statSync(path).size > 50 * MB) {
    return path
  }
  mkdirSync(dirname(path), { recursive: true })
  const base = readFileSync(join(root, 'samples', 'fixtures', 'simple.dxf'), 'utf8').replace(
    /\s*0\s*\nEOF\s*$/,
    '\n'
  )
  const chunk = `999\n${'x'.repeat(2048)}\n`
  const parts = [base]
  let size = Buffer.byteLength(base)
  while (size < 52 * MB) {
    parts.push(chunk)
    size += chunk.length
  }
  parts.push('0\nEOF\n')
  writeFileSync(path, parts.join(''))
  return path
}

const oversizeFixture = ensureOversizeFixture()
const fixtures = [
  { dxf: 'samples/fixtures/simple.dxf', expect: 'WALLS', shot: 'out/smoke-simple.png', layers: true },
  { dxf: 'samples/fixtures/block.dxf', expect: 'BLOCK', shot: 'out/smoke-block.png' },
  { dxf: 'samples/fixtures/dim.dxf', expect: 'DIM', shot: 'out/smoke-dim.png' },
  { dxf: 'samples/fixtures/broken.dxf', expect: '无法打开图纸', shot: 'out/smoke-broken.png' },
  {
    dxf: 'samples/fixtures/placeholder.dwg',
    expect: 'DWG 需先转换',
    shot: 'out/smoke-dwg.png',
    odaMissing: true
  },
  {
    dxf: oversizeFixture,
    expect: '大图纸摘要',
    shot: 'out/smoke-summary.png',
    layerLoad: true
  }
]

for (const fixture of fixtures) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'smoke.mjs'),
      '--dxf',
      fixture.dxf,
      '--expect',
      fixture.expect,
      '--shot',
      fixture.shot,
      ...(fixture.layers ? ['--layers'] : []),
      ...(fixture.layerLoad ? ['--layer-load'] : []),
      ...(fixture.odaMissing ? ['--oda-missing'] : [])
    ],
    { cwd: root, stdio: 'inherit' }
  )

  if (result.status !== 0) {
    console.error(`smoke failed for ${fixture.dxf}`)
    process.exit(result.status ?? 1)
  }
}

console.log('SMOKE PASS: all drawing scenarios')
