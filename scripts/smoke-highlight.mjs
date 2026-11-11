import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const result = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'smoke.mjs'),
    '--dxf',
    'samples/fixtures/simple.dxf',
    '--expect',
    'WALLS',
    '--highlight',
    '--shot',
    'out/smoke-highlight.png'
  ],
  { cwd: root, stdio: 'inherit' }
)

if (result.status !== 0) {
  console.error('highlight smoke failed')
  process.exit(result.status ?? 1)
}

console.log('SMOKE PASS: highlight scenario')
