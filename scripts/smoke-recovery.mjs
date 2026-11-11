import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const child = spawn(
  process.execPath,
  ['scripts/smoke.mjs', '--recovery', '--shot', resolve('out/smoke-recovery.png')],
  { stdio: 'inherit', windowsHide: true }
)

child.on('exit', (code) => {
  if (code === 0) {
    console.log('SMOKE PASS: sidecar recovery scenario')
  } else {
    process.exit(code ?? 1)
  }
})
