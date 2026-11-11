import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const userData = resolve('out/history-smoke/user-data')

await rm(userData, { recursive: true, force: true })
await mkdir(userData, { recursive: true })

function run(phase) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/smoke.mjs',
        '--history',
        phase,
        '--user-data',
        userData,
        '--dxf',
        resolve('samples/fixtures/simple.dxf'),
        '--shot',
        resolve(`out/smoke-history-${phase}.png`)
      ],
      { stdio: 'inherit', windowsHide: true }
    )
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(`history smoke ${phase} exited with code ${code}`))
      }
    })
  })
}

await run('seed')
await run('restore')
console.log('SMOKE PASS: history restart scenario')
