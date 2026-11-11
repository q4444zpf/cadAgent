import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import electron from 'electron'

const MB = 1024 * 1024
const args = process.argv.slice(2)

function takeOption(name) {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}

const dxf = takeOption('--dxf')
const TIMEOUT_MS =
  dxf && existsSync(dxf) && statSync(dxf).size > 50 * MB ? 240_000 : 60_000
const expect = takeOption('--expect')
const shot = takeOption('--shot')
const settingsMode = args.includes('--settings')
const layersMode = args.includes('--layers')
const qaMode = args.includes('--qa')
const highlightMode = args.includes('--highlight')
const kbMode = args.includes('--kb')
const kbQaMode = args.includes('--kb-qa')
const designMode = args.includes('--design')
const recoveryMode = args.includes('--recovery')
const odaMode = args.includes('--oda')
const historyMode = takeOption('--history')
const userData = takeOption('--user-data')
const kbDir = takeOption('--kb-dir')

const env = {
  ...process.env,
  SMOKE_TEST: '1',
  ...(dxf ? { SMOKE_DXF: resolve(dxf) } : {}),
  ...(expect ? { SMOKE_EXPECT: expect } : {}),
  ...(shot ? { SMOKE_SHOT: resolve(shot) } : {}),
  ...(settingsMode ? { SMOKE_SETTINGS: '1' } : {}),
  ...(layersMode ? { SMOKE_LAYERS: '1' } : {}),
  ...(qaMode ? { SMOKE_QA: '1' } : {}),
  ...(highlightMode ? { SMOKE_HIGHLIGHT: '1' } : {}),
  ...(kbMode ? { SMOKE_KB: '1' } : {}),
  ...(kbQaMode ? { SMOKE_KB_QA: '1' } : {}),
  ...(designMode ? { SMOKE_DESIGN: '1' } : {}),
  ...(recoveryMode ? { SMOKE_RECOVERY: '1' } : {}),
  ...(odaMode ? { SMOKE_ODA: '1', SMOKE_ODA_MISSING: '1' } : {}),
  ...(historyMode ? { SMOKE_HISTORY: historyMode } : {}),
  ...(userData ? { SMOKE_USER_DATA: resolve(userData) } : {}),
  ...(kbDir ? { SMOKE_KB_DIR: resolve(kbDir) } : {})
}

const child = spawn(electron, ['.'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  windowsHide: true
})

let output = ''
const timer = setTimeout(() => {
  console.error(`SMOKE FAIL: timeout after ${TIMEOUT_MS}ms\n${output}`)
  child.kill()
  process.exit(1)
}, TIMEOUT_MS)

function onData(chunk) {
  output += chunk.toString()
  if (output.includes('SMOKE_OK')) {
    clearTimeout(timer)
    console.log(`SMOKE PASS${dxf ? ` (${dxf})` : ''}${settingsMode ? ' (settings)' : ''}${qaMode ? ' (qa)' : ''}${highlightMode ? ' (highlight)' : ''}${kbMode ? ' (kb)' : ''}${kbQaMode ? ' (kb-qa)' : ''}${designMode ? ' (design)' : ''}${historyMode ? ` (history ${historyMode})` : ''}${recoveryMode ? ' (recovery)' : ''}${odaMode ? ' (oda-guide)' : ''}`)
    child.kill()
    process.exit(0)
  }
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)

child.on('exit', (code) => {
  clearTimeout(timer)
  if (!output.includes('SMOKE_OK')) {
    console.error(`SMOKE FAIL: exited with code ${code}\n${output}`)
    process.exit(1)
  }
})
