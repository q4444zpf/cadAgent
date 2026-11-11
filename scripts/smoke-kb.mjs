import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kbRoot = join(root, 'out', 'kb-smoke')

rmSync(kbRoot, { recursive: true, force: true })

const result = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'smoke.mjs'),
    '--kb',
    '--kb-dir',
    'samples/kb',
    '--shot',
    'out/smoke-kb.png'
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, SMOKE_KB_ROOT: kbRoot } }
)

if (result.status !== 0) {
  console.error('kb smoke failed')
  process.exit(result.status ?? 1)
}

console.log('SMOKE PASS: knowledge base scenario')
