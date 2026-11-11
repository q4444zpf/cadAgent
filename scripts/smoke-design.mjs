import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kbRoot = join(root, 'out', 'kb-design-smoke')
const genRoot = join(root, 'out', 'design-smoke')

rmSync(kbRoot, { recursive: true, force: true })
rmSync(genRoot, { recursive: true, force: true })
mkdirSync(genRoot, { recursive: true })

const result = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'smoke.mjs'),
    '--design',
    '--kb-dir',
    'samples/kb',
    '--shot',
    'out/smoke-design.png'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      SMOKE_KB_ROOT: kbRoot,
      SMOKE_GEN_ROOT: genRoot
    }
  }
)

if (result.status !== 0) {
  console.error('design smoke failed')
  process.exit(result.status ?? 1)
}

console.log('SMOKE PASS: design parameter scenario')
