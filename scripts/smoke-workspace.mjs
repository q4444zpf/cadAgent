import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const project = resolve('out/workspace-smoke/project')
const userData = resolve('out/workspace-smoke/user-data')

await rm(project, { recursive: true, force: true })
await rm(userData, { recursive: true, force: true })
await mkdir(resolve(project, 'docs'), { recursive: true })
await writeFile(resolve(project, 'note.txt'), '排水沟净宽 600，壁厚 100mm\n')
await writeFile(resolve(project, 'temp.txt'), '临时附件\n')
await writeFile(resolve(project, 'docs', 'memo.md'), '# 设计说明\n')
await copyFile(resolve('samples/fixtures/archives/sample.zip'), resolve(project, '归档.zip'))

function run(phase, extra = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/smoke.mjs',
        '--workspace',
        phase,
        '--project-root',
        project,
        '--user-data',
        userData,
        '--timeout',
        '300000',
        '--shot',
        resolve(`out/smoke-workspace-${phase}.png`),
        ...extra
      ],
      { stdio: 'inherit', windowsHide: true }
    )
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(`workspace smoke ${phase} exited with code ${code}`))
      }
    })
  })
}

await run('seed', ['--attach', 'note.txt,temp.txt'])
await unlink(resolve(project, 'temp.txt'))
await run('restore')
console.log('SMOKE PASS: workspace scenario')
