import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { QaAgent } from '../node/agent/qa-agent'
import { KbAgent } from '../node/agent/kb-agent'
import { DesignAgent } from '../node/design/agent'
import { DesignSessionStore } from '../node/design/session'
import { isDrawingOversize } from '../node/drawing/limits'
import {
  readSummaryCache,
  summaryCacheKey,
  writeSummaryCache
} from '../node/drawing/summary-cache'
import { HistoryStore } from '../node/history/store'
import { AppLogger } from '../node/logging/logger'
import { VisionRecognizer } from '../node/kb/vision'
import { ModelRuntime } from '../node/model/runtime'
import { SettingsStore } from '../node/model/settings'
import { detectOdaConverter } from '../node/oda/detect'
import { SidecarClient } from '../node/sidecar/client'
import {
  AgentAskSchema,
  DesignCancelSchema,
  DesignConfirmSchema,
  DesignPromptSchema,
  HistoryCreateSchema,
  HistoryIdSchema,
  LayerEntitiesRequestSchema,
  ModelSettingsSaveSchema,
  type AgentAskResult,
  type AgentStreamEvent,
  type ConverterActionOutcome,
  type ConverterStatus,
  type DesignActionOutcome,
  type DesignConfirmOutcome,
  type DesignProposal,
  type DiagnosticsActionOutcome,
  type DiagnosticsLogOutcome,
  type Drawing,
  type DrawingOpenResult,
  type HistoryActionOutcome,
  type HistoryListOutcome,
  type HistorySessionOutcome,
  type KbActionOutcome,
  type KbDocument,
  type KbImportOutcome,
  type KbListOutcome,
  type KbRebuildOutcome,
  type KbSearchOutcome,
  type LayerEntitiesResult,
  type SettingsSaveResult,
  type SidecarStatus
} from '../shared/protocol'

const isSmoke = process.env.SMOKE_TEST === '1'
const ODA_DOWNLOAD_URL = 'https://www.opendesign.com/guestfiles/oda_file_converter'

if (isSmoke) {
  const userData = process.env.SMOKE_USER_DATA
  app.setPath(
    'userData',
    userData
      ? resolve(userData)
      : join(app.getPath('temp'), `cad-agent-smoke-${process.pid}`)
  )
}

const sidecar = new SidecarClient()
const logger = new AppLogger({
  filePath: join(app.getPath('userData'), 'logs', 'app.log')
})
const summaryCacheDir = join(app.getPath('userData'), 'drawing-cache')
const settingsStore = new SettingsStore({
  filePath: join(app.getPath('userData'), 'settings.json'),
  codec: {
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: async (cipher) => (await safeStorage.decryptStringAsync(cipher)).result
  }
})
const modelRuntime = new ModelRuntime(() => settingsStore.getActive())
const visionRecognizer = new VisionRecognizer({
  models: modelRuntime,
  getSettings: () => settingsStore.getActive()
})
const kbRoot = process.env.SMOKE_KB_ROOT
  ? resolve(process.env.SMOKE_KB_ROOT)
  : join(app.getPath('userData'), 'kb')
let currentDrawing: Drawing | null = null
const kbAgent = new KbAgent({
  models: modelRuntime,
  getSettings: () => settingsStore.getActive(),
  retrieve: async (query, limit) => {
    await sidecar.start()
    return sidecar.kbSearch(kbRoot, query, limit)
  }
})
const qaAgent = new QaAgent({
  models: modelRuntime,
  getSettings: () => settingsStore.getActive(),
  getDrawing: () => currentDrawing,
  knowledge: (question) => kbAgent.ask(question)
})
const designAgent = new DesignAgent({
  models: modelRuntime,
  getSettings: () => settingsStore.getActive(),
  knowledge: (question) => kbAgent.ask(question)
})
const designSessions = new DesignSessionStore()
const historyStore = new HistoryStore(join(app.getPath('userData'), 'history.db'))
let currentSessionId = historyStore.getLastSession()
let lastStatus: SidecarStatus = sidecar.getStatus()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !isSmoke || Boolean(process.env.SMOKE_SHOT),
    title: 'CAD Agent',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.webContents.on('render-process-gone', (_event, details) => {
    console.log(`RENDER_GONE reason=${details.reason} exit=${details.exitCode}`)
  })

  return window
}

function broadcast(status: SidecarStatus): void {
  lastStatus = status
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sidecar:status', status)
  }
}

const MAX_RECOVERY_ATTEMPTS = 3
let recoveryTimer: NodeJS.Timeout | null = null
let recoveryAttempts = 0
let recovering = false

function handleSidecarStatus(status: SidecarStatus): void {
  broadcast(status)
  logger.write(
    status.state === 'error' ? 'error' : 'info',
    'sidecar',
    `状态：${status.state}`,
    status.detail
  )

  if (status.state === 'ready') {
    recoveryAttempts = 0
  } else if (status.state === 'error' && !recovering) {
    scheduleSidecarRecovery()
  }
}

function scheduleSidecarRecovery(): void {
  if (recoveryTimer || recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    return
  }
  const attempt = recoveryAttempts + 1
  const delay = 800 * 2 ** (attempt - 1)
  logger.write('warn', 'sidecar', `${delay}ms 后尝试自动恢复（第 ${attempt} 次）`)
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null
    if (lastStatus.state !== 'error') {
      return
    }
    recoveryAttempts = attempt
    recovering = true
    void sidecar
      .restart()
      .then(() => {
        logger.write('info', 'sidecar', '自动恢复成功')
        recoveryAttempts = 0
      })
      .catch((error) => {
        logger.write('error', 'sidecar', '自动恢复失败', error)
      })
      .finally(() => {
        recovering = false
        if (lastStatus.state === 'error') {
          scheduleSidecarRecovery()
        }
      })
  }, delay)
}

async function checkSidecarHealth(): Promise<void> {
  if (lastStatus.state !== 'ready' || recovering || sidecar.isBusy()) {
    return
  }
  try {
    await sidecar.health()
  } catch (error) {
    if (lastStatus.state !== 'ready') {
      return
    }
    logger.write('error', 'sidecar', '健康检查失败', error)
    broadcast({ state: 'error', detail: `健康检查失败：${errorText(error)}` })
    scheduleSidecarRecovery()
  }
}

async function loadDrawing(filePath: string): Promise<DrawingOpenResult> {
  const extension = extname(filePath).toLowerCase()

  if (extension === '.dwg') {
    return {
      ok: false,
      error: {
        code: 'dwg_requires_conversion',
        message: 'DWG 文件需先经 ODA File Converter 转换为 DXF 后再导入'
      }
    }
  }

  if (extension !== '.dxf') {
    return {
      ok: false,
      error: { code: 'unsupported_format', message: `不支持的文件格式：${extension || '未知'}` }
    }
  }

  const fileInfo = await stat(filePath).catch(() => null)
  const oversize = fileInfo !== null && isDrawingOversize(fileInfo.size)

  try {
    await sidecar.start()
    if (currentDrawing && resolve(currentDrawing.path) !== resolve(filePath)) {
      await sidecar.closeDrawing()
    }
    let drawing: Drawing
    if (fileInfo && oversize) {
      const cacheKey = summaryCacheKey({
        path: resolve(filePath),
        size: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs
      })
      logger.write('info', 'parse', '图纸超过 50 MB，按摘要模式解析', {
        path: filePath,
        sizeMb: Math.round(fileInfo.size / (1024 * 1024))
      })
      const cached = await readSummaryCache(summaryCacheDir, cacheKey)
      if (cached) {
        logger.write('info', 'parse', '命中大图纸摘要缓存', { path: filePath })
        drawing = cached
      } else {
        drawing = await sidecar.openDrawing(filePath)
        await writeSummaryCache(summaryCacheDir, cacheKey, drawing)
        logger.write('info', 'parse', '大图纸摘要解析完成', { path: filePath })
      }
    } else {
      drawing = await sidecar.parseDrawing(filePath)
    }
    currentDrawing = drawing
    if (currentSessionId) {
      historyStore.updateDrawing(currentSessionId, { path: drawing.path, name: drawing.name })
    }
    return { ok: true, drawing }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.write('error', 'parse', '图纸解析失败', { path: filePath, message })
    return {
      ok: false,
      error: {
        code: 'parse_failed',
        message: message.replace(/^handler_error:\s*/, '')
      }
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('sidecar:get-status', () => lastStatus)
  ipcMain.handle('sidecar:restart', async () => {
    broadcast({ state: 'starting' })
    try {
      await sidecar.restart()
    } catch {
      // 失败详情已通过状态事件广播
    }
    return lastStatus
  })
  ipcMain.handle('sidecar:kill', (): DiagnosticsActionOutcome => {
    if (!isSmoke) {
      return { ok: false, error: '仅测试环境允许终止侧车' }
    }
    const pid = sidecar.getPid()
    if (!pid) {
      return { ok: false, error: '侧车未运行' }
    }
    try {
      process.kill(pid)
      logger.write('warn', 'sidecar', '测试终止侧车进程', { pid })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
  ipcMain.handle('diagnostics:tail', (): DiagnosticsLogOutcome => {
    try {
      return { ok: true, path: logger.getFilePath(), lines: logger.readTail(300) }
    } catch (error) {
      return { ok: false, path: logger.getFilePath(), lines: [], error: errorText(error) }
    }
  })
  ipcMain.handle('diagnostics:open', async (): Promise<DiagnosticsActionOutcome> => {
    const folder = dirname(logger.getFilePath())
    try {
      await mkdir(folder, { recursive: true })
      const failure = await shell.openPath(folder)
      return failure ? { ok: false, path: folder, error: failure } : { ok: true, path: folder }
    } catch (error) {
      return { ok: false, path: folder, error: errorText(error) }
    }
  })
  ipcMain.handle('converter:status', (): ConverterStatus => {
    if (isSmoke && process.env.SMOKE_ODA_MISSING === '1') {
      return { found: false, path: null }
    }
    return detectOdaConverter()
  })
  ipcMain.handle('converter:open-download', async (): Promise<ConverterActionOutcome> => {
    try {
      await shell.openExternal(ODA_DOWNLOAD_URL)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
  ipcMain.handle('drawing:open', async () => {
    const result = await dialog.showOpenDialog({
      title: '打开 CAD 图纸',
      properties: ['openFile'],
      filters: [{ name: 'CAD 图纸', extensions: ['dxf', 'dwg'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return loadDrawing(result.filePaths[0])
  })
  ipcMain.handle('drawing:load', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) {
      return {
        ok: false,
        error: { code: 'bad_path', message: '图纸路径无效' }
      } satisfies DrawingOpenResult
    }
    return loadDrawing(filePath)
  })
  ipcMain.handle('drawing:auto-open', () => {
    const smokePath = process.env.SMOKE_DXF
    return smokePath ? { path: resolve(smokePath) } : null
  })
  ipcMain.handle(
    'drawing:layer',
    async (_event, input: unknown): Promise<LayerEntitiesResult> => {
      const parsed = LayerEntitiesRequestSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, entities: [], error: '图层请求无效' }
      }
      const { path: filePath, layer } = parsed.data
      if (!currentDrawing || resolve(filePath) !== currentDrawing.path) {
        return { ok: false, entities: [], error: '图纸已切换，请重新加载' }
      }
      try {
        await sidecar.start()
        const started = Date.now()
        const entities = await sidecar.layerEntities(filePath, layer)
        logger.write('info', 'parse', '图层加载完成', {
          layer,
          entities: entities.length,
          ms: Date.now() - started
        })
        return { ok: true, entities }
      } catch (error) {
        logger.write('error', 'parse', '图层加载失败', {
          path: filePath,
          layer,
          message: errorText(error)
        })
        return { ok: false, entities: [], error: errorText(error) }
      }
    }
  )
  ipcMain.handle('settings:get', () => settingsStore.getPublic())
  ipcMain.handle('settings:save', async (_event, input: unknown): Promise<SettingsSaveResult> => {
    const parsed = ModelSettingsSaveSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '设置内容无效' }
    }
    try {
      return { ok: true, settings: await settingsStore.save(parsed.data) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('model:providers', () => modelRuntime.listProviders())
  ipcMain.handle('model:list', (_event, provider: unknown) =>
    typeof provider === 'string' && provider ? modelRuntime.listModels(provider) : []
  )
  ipcMain.handle('model:test', async () => {
    const result = await modelRuntime.testConnection()
    if (!result.ok) {
      logger.write('error', 'model', '连接测试失败', result.message)
    }
    return result
  })
  ipcMain.handle('agent:ask', async (_event, input: unknown): Promise<AgentAskResult> => {
    const parsed = AgentAskSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '问题内容无效' }
    }
    try {
      const sessionId = ensureSession(parsed.data.prompt)
      historyStore.appendMessage(sessionId, { role: 'user', text: parsed.data.prompt })
      const outcome = await qaAgent.ask(parsed.data, broadcastAgentEvent)
      historyStore.updateDrawing(
        sessionId,
        currentDrawing ? { path: currentDrawing.path, name: currentDrawing.name } : null
      )
      historyStore.appendMessage(sessionId, {
        role: 'assistant',
        text: outcome.text,
        sources: outcome.sources,
        references: outcome.references,
        ...(outcome.error ? { error: outcome.error } : {})
      })
      if (outcome.error) {
        logger.write('error', 'model', '读图问答失败', outcome.error)
      }
      return {
        ...(outcome.error ? { ok: false, error: outcome.error } : { ok: true }),
        sessionId
      }
    } catch (error) {
      logger.write('error', 'model', '读图问答异常', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('agent:abort', () => qaAgent.abort())
  registerKbIpc()
  registerDesignIpc()
  registerHistoryIpc()
}

function sessionTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat
}

function ensureSession(prompt: string): string {
  if (currentSessionId && historyStore.getSession(currentSessionId)) {
    historyStore.setLastSession(currentSessionId)
    return currentSessionId
  }
  const created = historyStore.createSession({
    title: sessionTitle(prompt),
    drawingPath: currentDrawing?.path ?? null,
    drawingName: currentDrawing?.name ?? null
  })
  currentSessionId = created.id
  historyStore.setLastSession(created.id)
  return created.id
}

function sessionById(sessionId: string): HistorySessionOutcome {
  const session = historyStore.getSession(sessionId)
  return session ? { ok: true, session } : { ok: false, error: '会话不存在' }
}

function currentSession(): HistorySessionOutcome {
  if (!currentSessionId) {
    return { ok: true }
  }
  const outcome = sessionById(currentSessionId)
  if (!outcome.ok) {
    currentSessionId = null
    historyStore.clearLastSession()
    return { ok: true }
  }
  return outcome
}

function registerHistoryIpc(): void {
  ipcMain.handle('history:list', (): HistoryListOutcome => {
    try {
      return { ok: true, sessions: historyStore.listSessions() }
    } catch (error) {
      return { ok: false, sessions: [], error: errorText(error) }
    }
  })

  ipcMain.handle('history:current', (): HistorySessionOutcome => currentSession())

  ipcMain.handle('history:get', (_event, input: unknown): HistorySessionOutcome => {
    const parsed = HistoryIdSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '会话标识无效' }
    }
    return sessionById(parsed.data.sessionId)
  })

  ipcMain.handle('history:create', (_event, input: unknown): HistorySessionOutcome => {
    const parsed = HistoryCreateSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '会话标题无效' }
    }
    try {
      const created = historyStore.createSession(parsed.data)
      currentSessionId = created.id
      historyStore.setLastSession(created.id)
      return sessionById(created.id)
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })

  ipcMain.handle('history:open', (_event, input: unknown): HistorySessionOutcome => {
    const parsed = HistoryIdSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '会话标识无效' }
    }
    const outcome = sessionById(parsed.data.sessionId)
    if (outcome.ok) {
      currentSessionId = parsed.data.sessionId
      historyStore.setLastSession(parsed.data.sessionId)
    }
    return outcome
  })

  ipcMain.handle('history:delete', (_event, input: unknown): HistoryActionOutcome => {
    const parsed = HistoryIdSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '会话标识无效' }
    }
    try {
      if (!historyStore.deleteSession(parsed.data.sessionId)) {
        return { ok: false, error: '会话不存在' }
      }
      if (currentSessionId === parsed.data.sessionId) {
        currentSessionId = null
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
}

function registerDesignIpc(): void {
  ipcMain.handle('design:propose', async (_event, input: unknown): Promise<DesignProposal> => {
    const parsed = DesignPromptSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '生成需求无效' }
    }
    try {
      const outcome = await designAgent.propose(parsed.data.prompt)
      if (!outcome.list) {
        const message = outcome.error ?? '未能整理参数清单'
        logger.write('error', 'model', '参数整理失败', message)
        return { ok: false, error: message }
      }
      const session = designSessions.create(outcome.list)
      if (outcome.error) {
        logger.write('warn', 'model', '参数整理存在警告', outcome.error)
      }
      return {
        ok: true,
        session,
        ...(outcome.error ? { warning: outcome.error } : {})
      }
    } catch (error) {
      logger.write('error', 'model', '参数整理异常', error)
      return { ok: false, error: errorText(error) }
    }
  })

  ipcMain.handle(
    'design:confirm',
    (_event, input: unknown): DesignConfirmOutcome => {
      const parsed = DesignConfirmSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, error: '确认内容无效' }
      }
      return designSessions.confirm(parsed.data.listId, parsed.data.values)
    }
  )

  ipcMain.handle('design:cancel', (_event, input: unknown): DesignActionOutcome => {
    const parsed = DesignCancelSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: '取消内容无效' }
    }
    return designSessions.cancel(parsed.data.listId)
  })
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^handler_error:\s*/,
    ''
  )
}

function isImagePath(path: string): boolean {
  return ['.png', '.jpg', '.jpeg'].includes(extname(path).toLowerCase())
}

function registerKbIpc(): void {
  ipcMain.handle('kb:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入知识库文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '知识库文件', extensions: ['pdf', 'docx', 'dxf', 'csv', 'png', 'jpg', 'jpeg'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('kb:import', async (_event, paths: unknown): Promise<KbImportOutcome> => {
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string' || !item)) {
      return { ok: false, error: '导入路径无效' }
    }
    try {
      await sidecar.start()
      const documents: KbDocument[] = []
      for (const filePath of paths as string[]) {
        if (!isImagePath(filePath)) {
          documents.push(await sidecar.kbImport(kbRoot, filePath))
          continue
        }
        try {
          const recognition = await visionRecognizer.recognize(filePath)
          documents.push(await sidecar.kbImport(kbRoot, filePath, recognition))
        } catch (error) {
          documents.push(
            await sidecar.kbImport(kbRoot, filePath, { error: errorText(error) })
          )
        }
      }
      return { ok: true, documents }
    } catch (error) {
      logger.write('error', 'kb', '知识库导入失败', error)
      return { ok: false, error: errorText(error) }
    }
  })

  ipcMain.handle('kb:list', async (): Promise<KbListOutcome> => {
    try {
      await sidecar.start()
      return { ok: true, documents: await sidecar.kbList(kbRoot) }
    } catch (error) {
      return { ok: false, documents: [], error: errorText(error) }
    }
  })

  ipcMain.handle('kb:delete', async (_event, docId: unknown): Promise<KbActionOutcome> => {
    if (typeof docId !== 'string' || !docId) {
      return { ok: false, error: '文档标识无效' }
    }
    try {
      await sidecar.start()
      const deleted = await sidecar.kbDelete(kbRoot, docId)
      return deleted ? { ok: true } : { ok: false, error: '未找到该文档' }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })

  ipcMain.handle('kb:rebuild', async (): Promise<KbRebuildOutcome> => {
    try {
      await sidecar.start()
      return { ok: true, ...(await sidecar.kbRebuild(kbRoot)) }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })

  ipcMain.handle('kb:search', async (_event, query: unknown): Promise<KbSearchOutcome> => {
    if (typeof query !== 'string' || !query.trim()) {
      return { ok: false, hits: [], error: '请输入检索内容' }
    }
    try {
      await sidecar.start()
      return { ok: true, hits: await sidecar.kbSearch(kbRoot, query.trim()) }
    } catch (error) {
      return { ok: false, hits: [], error: errorText(error) }
    }
  })
}

function broadcastAgentEvent(event: AgentStreamEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agent:event', event)
  }
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  const smokeDxf = process.env.SMOKE_DXF
  const smokeInfo = smokeDxf ? await stat(smokeDxf).catch(() => null) : null
  const deadline =
    Date.now() + (smokeInfo && isDrawingOversize(smokeInfo.size) ? 180_000 : 30_000)
  const expected = process.env.SMOKE_EXPECT
  const shotPath = process.env.SMOKE_SHOT
  const settingsMode = process.env.SMOKE_SETTINGS === '1'
  const qaMode = process.env.SMOKE_QA === '1'
  const highlightMode = process.env.SMOKE_HIGHLIGHT === '1'
  const kbMode = process.env.SMOKE_KB === '1'
  const kbQaMode = process.env.SMOKE_KB_QA === '1'
  const designMode = process.env.SMOKE_DESIGN === '1'
  const historyMode = process.env.SMOKE_HISTORY
  const recoveryMode = process.env.SMOKE_RECOVERY === '1'
  const odaMode = process.env.SMOKE_ODA === '1'

  while (Date.now() < deadline) {
    if (lastStatus.state === 'error') {
      console.error(`SMOKE_FAIL ${lastStatus.detail ?? 'sidecar error'}`)
      await sidecar.stop()
      app.exit(1)
      return
    }

    const text = await readBody(window)

    const baseReady =
      lastStatus.state === 'ready' && text.includes('侧车服务就绪') && text.includes('ezdxf')
    const expectationMet = !expected || text.includes(expected)

    if (baseReady && (settingsMode || qaMode || highlightMode || kbMode || kbQaMode || designMode || historyMode || recoveryMode || odaMode || expectationMet)) {
      if (settingsMode) {
        try {
          await runSettingsSmoke(window, shotPath)
          console.log('SMOKE_OK settings fake-mode')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (qaMode) {
        try {
          await runQaSmoke(window, shotPath)
          console.log('SMOKE_OK qa fake-mode')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (highlightMode) {
        try {
          await runHighlightSmoke(window, shotPath)
          console.log('SMOKE_OK highlight')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (kbMode) {
        try {
          await runKbSmoke(window, shotPath)
          console.log('SMOKE_OK kb')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (kbQaMode) {
        try {
          await runKbQaSmoke(window, shotPath)
          console.log('SMOKE_OK kb-qa')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (designMode) {
        try {
          await runDesignSmoke(window, shotPath)
          console.log('SMOKE_OK design')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (historyMode) {
        try {
          await runHistorySmoke(window, historyMode, shotPath)
          console.log(`SMOKE_OK history-${historyMode}`)
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (recoveryMode) {
        try {
          await runRecoverySmoke(window, shotPath)
          console.log('SMOKE_OK recovery')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (odaMode) {
        try {
          await runOdaGuideSmoke(window, shotPath)
          console.log('SMOKE_OK oda-guide')
          app.quit()
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
        }
        return
      }

      if (process.env.SMOKE_LAYERS === '1') {
        try {
          await verifyLayerToggle(window)
        } catch (error) {
          console.error(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`)
          await sidecar.stop()
          app.exit(1)
          return
        }
      }

      if (process.env.SMOKE_LAYER_LOAD === '1') {
        const heartbeat = setInterval(async () => {
          const body = await readBody(window).catch((error) => `ERR:${String(error)}`)
          console.log(
            `SMOKE_HEARTBEAT crashed=${window.webContents.isCrashed()} len=${body.length} tail=${body.slice(-200).replace(/\s+/g, ' ')}`
          )
        }, 10_000)
        try {
          await waitForBody(window, '图层已加载完成', Date.now() + 180_000)
          console.log('SMOKE_STEP body-complete')
          await waitForCondition(
            async () => (await countInkPixels(window)) > 0,
            '渐进加载完成后画布未绘制图形'
          )
          console.log('SMOKE_STEP ink-ok')
          await verifyLayerToggle(window, 30_000)
          console.log('SMOKE_STEP toggle-ok')
          await verifyWheelZoom(window)
          console.log('SMOKE_STEP wheel-ok')
          if (shotPath) {
            window.webContents.invalidate()
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        } catch (error) {
          const body = await readBody(window).catch(() => '')
          if (shotPath) {
            await captureShot(window, shotPath).catch(() => undefined)
          }
          console.error(
            `SMOKE_FAIL ${error instanceof Error ? error.message : String(error)} body=${body.slice(-600)}`
          )
          await sidecar.stop()
          app.exit(1)
          return
        } finally {
          clearInterval(heartbeat)
        }
      }

      if (shotPath) {
        await captureShot(window, shotPath)
      }
      console.log(
        `SMOKE_OK ezdxf=${lastStatus.health?.ezdxf ?? 'unknown'}${expected ? ` expect=${expected}` : ''}`
      )
      app.quit()
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  console.error(
    `SMOKE_FAIL timeout status=${JSON.stringify(lastStatus)} expected=${expected ?? '-'}`
  )
  await sidecar.stop()
  app.exit(1)
}

async function readBody(window: BrowserWindow): Promise<string> {
  return withTimeout(
    window.webContents.executeJavaScript('document.body.innerText'),
    5_000,
    '读取页面文本超时'
  ).catch(() => '')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function waitForBody(window: BrowserWindow, needle: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if ((await readBody(window)).includes(needle)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`页面未出现「${needle}」`)
}

async function fillKbQuery(window: BrowserWindow, value: string): Promise<void> {
  const filled = (await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.kb__search-form input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)) as boolean
  if (!filled) {
    throw new Error('未找到知识库检索输入框')
  }
}

async function clickButtonByText(window: BrowserWindow, text: string): Promise<void> {
  const clicked = (await window.webContents.executeJavaScript(`(() => {
    const target = Array.from(document.querySelectorAll('button')).find((button) =>
      (button.textContent || '').includes(${JSON.stringify(text)})
    );
    if (!target) return false;
    target.click();
    return true;
  })()`)) as boolean

  if (!clicked) {
    throw new Error(`未找到按钮「${text}」`)
  }
}

async function countInkPixels(window: BrowserWindow): Promise<number> {
  return withTimeout(
    window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.drawing-canvas');
    if (!canvas) return -1;
    const context = canvas.getContext('2d');
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] + data[index + 1] + data[index + 2] > 120) count += 1;
    }
    return count;
  })()`),
    15_000,
    '读取画布像素超时（渲染进程无响应）'
  ) as Promise<number>
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function verifyLayerToggle(window: BrowserWindow, timeoutMs = 5_000): Promise<void> {
  await waitForCondition(
    async () => (await countInkPixels(window)) > 0,
    '画布未绘制任何图形',
    timeoutMs
  )

  await clickButtonByText(window, '全隐')
  await waitForCondition(
    async () => (await countInkPixels(window)) === 0,
    '全隐后画布仍有图形',
    timeoutMs
  )

  await clickButtonByText(window, '全显')
  await waitForCondition(
    async () => (await countInkPixels(window)) > 0,
    '全显后画布未恢复',
    timeoutMs
  )
}

async function verifyWheelZoom(window: BrowserWindow): Promise<void> {
  const dispatched = (await window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.drawing-canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true
    }));
    return true;
  })()`)) as boolean
  if (!dispatched) {
    throw new Error('未找到画布，无法验证缩放')
  }
  await waitForCondition(
    async () => (await countInkPixels(window)) > 0,
    '缩放后画布未绘制图形'
  )
}

async function runSettingsSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 20_000

  await clickButtonByText(window, '设置')
  await waitForBody(window, '模型设置', deadline)

  await window.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('.settings input[type="checkbox"]');
    if (!box) return false;
    if (!box.checked) box.click();
    return true;
  })()`)

  await clickButtonByText(window, '保存设置')
  await waitForBody(window, '设置已保存', deadline)

  await clickButtonByText(window, '测试连接')
  await waitForBody(window, '连接成功', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }
}

async function runQaSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 30_000

  await enableFakeMode(window, deadline)
  await askQuestion(window, '这张图有多少个实体？')
  await waitForBody(window, '假模型回答', deadline)
  await waitForBody(window, '工具调用', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }
}

async function runHighlightSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 30_000

  await enableFakeMode(window, deadline)
  await askQuestion(window, 'WALLS 图层里有什么？')
  await waitForBody(window, '图层「WALLS」共有 2 个实体', deadline)

  const chips = (await window.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.chat__ref')).map((node) => ({
      text: node.textContent || '',
      title: node.getAttribute('title') || ''
    }));
  })()`)) as { text: string; title: string }[]
  if (chips.length !== 2) {
    throw new Error(`引用芯片数量应为 2，实际 ${chips.length}`)
  }
  if (!chips.every((chip) => chip.title.includes('图层 WALLS')) || !['#31', '#32'].every((handle) => chips.some((chip) => chip.text === handle))) {
    throw new Error(`引用芯片缺少句柄或图层信息：${JSON.stringify(chips)}`)
  }

  const initialHighlight = await countAmberPixels(window)
  if (initialHighlight !== 0) {
    throw new Error('点击引用前画布不应有高亮')
  }

  const clicked = (await window.webContents.executeJavaScript(`(() => {
    const chip = Array.from(document.querySelectorAll('.chat__ref')).find((node) =>
      (node.textContent || '').includes('#31')
    );
    if (!chip) return false;
    chip.click();
    return true;
  })()`)) as boolean
  if (!clicked) {
    throw new Error('未找到 #31 引用芯片')
  }

  await waitForCondition(async () => (await countAmberPixels(window)) > 0, '点击引用后画布未高亮')
  await waitForBody(window, '直线 · 图层 WALLS', deadline)

  const clickedSecond = (await window.webContents.executeJavaScript(`(() => {
    const chip = Array.from(document.querySelectorAll('.chat__ref')).find((node) =>
      (node.textContent || '').includes('#32')
    );
    if (!chip) return false;
    chip.click();
    return true;
  })()`)) as boolean
  if (!clickedSecond) {
    throw new Error('未找到 #32 引用芯片')
  }
  await waitForBody(window, '已高亮 2 个实体', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }

  await clickButtonByText(window, '取消高亮')
  await waitForCondition(
    async () => (await countAmberPixels(window)) === 0,
    '取消高亮后画布仍有高亮'
  )
}

async function runKbSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 60_000
  const dir = process.env.SMOKE_KB_DIR
  if (!dir) {
    throw new Error('缺少 SMOKE_KB_DIR')
  }
  const files = [
    'spec.pdf',
    'manual.docx',
    'notes.dxf',
    'params.csv',
    'scan.png',
    'broken.pdf',
    'scan-broken.png'
  ].map((name) => resolve(dir, name))

  await enableFakeMode(window, deadline)
  await clickButtonByText(window, '知识库')
  await waitForBody(window, '尚未导入文档', deadline)
  const imported = (await window.webContents.executeJavaScript(
    `window.cad.kb.importPaths(${JSON.stringify(files)})`
  )) as KbImportOutcome
  if (!imported.ok) {
    throw new Error(`导入失败：${imported.error ?? '未知错误'}`)
  }
  const documents = imported.documents ?? []
  const readyCount = documents.filter((doc) => doc.status === 'ready').length
  const failedCount = documents.filter((doc) => doc.status === 'failed').length
  if (readyCount !== 5 || failedCount !== 2) {
    throw new Error(`导入结果应为 5 就绪 / 2 失败，实际 ${readyCount} / ${failedCount}`)
  }

  await clickButtonByText(window, '刷新')
  await waitForBody(window, '5 个就绪 · 2 个失败', deadline)
  await waitForBody(window, 'PDF 解析失败', deadline)
  await waitForBody(window, '视觉识别失败', deadline)

  const rows = (await window.webContents.executeJavaScript(`(() => {
    const find = (name) => Array.from(document.querySelectorAll('.kb__documents > li')).find(
      (row) => (row.querySelector('.kb__name')?.textContent || '') === name
    );
    const scan = find('scan.png');
    const brokenScan = find('scan-broken.png');
    return {
      scan: scan ? scan.textContent || '' : '',
      scanLow: Boolean(scan && scan.querySelector('.kb__confidence--low')),
      brokenScan: brokenScan ? brokenScan.textContent || '' : '',
      brokenError: brokenScan?.querySelector('.kb__error')?.textContent || '',
      brokenRetry: Boolean(brokenScan && Array.from(brokenScan.querySelectorAll('button')).some(
        (node) => (node.textContent || '').includes('重试')
      ))
    };
  })()`)) as {
    scan: string
    scanLow: boolean
    brokenScan: string
    brokenError: string
    brokenRetry: boolean
  }
  if (!['扫描图', '视觉识别', '置信 0.55'].every((text) => rows.scan.includes(text))) {
    throw new Error(`扫描图缺少识别来源或置信度：${rows.scan}`)
  }
  if (!rows.scanLow) {
    throw new Error('扫描图低置信未使用醒目标记')
  }
  if (!rows.brokenError.includes('图片文件已损坏') || !rows.brokenRetry) {
    throw new Error(
      `无法识别的扫描图应显示原因与重试：${JSON.stringify({
        error: rows.brokenError,
        retry: rows.brokenRetry
      })}`
    )
  }

  const hasRetry = (await window.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.kb__doc-actions button')).some((node) =>
      (node.textContent || '').includes('重试')
    );
  })()`)) as boolean
  if (!hasRetry) {
    throw new Error('失败文档缺少重试按钮')
  }

  await fillKbQuery(window, '纵坡 0.3')
  await clickButtonByText(window, '检索')
  await waitForCondition(
    async () =>
      ((await window.webContents.executeJavaScript(
        `document.querySelectorAll('.kb__hits li').length`
      )) as number) > 0,
    '检索没有返回结果'
  )

  const hit = (await window.webContents.executeJavaScript(`(() => {
    const source = document.querySelector('.kb__hit-source');
    const text = document.querySelector('.kb__hit-text');
    return {
      source: source ? source.textContent || '' : '',
      text: text ? text.textContent || '' : ''
    };
  })()`)) as { source: string; text: string }
  if (!hit.source.includes('params.csv') || !hit.source.includes('第 2 行')) {
    throw new Error(`检索结果缺少来源或行号：${JSON.stringify(hit)}`)
  }
  if (!hit.text.includes('纵坡')) {
    throw new Error(`检索片段内容不符：${hit.text}`)
  }

  const removed = (await window.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      node.getAttribute('title') === '删除 params.csv'
    );
    if (!button) return false;
    button.click();
    return true;
  })()`)) as boolean
  if (!removed) {
    throw new Error('未找到 params.csv 的删除按钮')
  }
  await waitForBody(window, '已删除：params.csv', deadline)
  await waitForCondition(
    async () =>
      (await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.kb__search-form button');
        return Boolean(button && !button.disabled);
      })()`)) as boolean,
    '删除后检索按钮未恢复可用'
  )
  await clickButtonByText(window, '检索')
  await waitForCondition(async () => {
    const state = (await window.webContents.executeJavaScript(`(() => ({
      busy: document.body.innerText.includes('检索中…'),
      empty: document.body.innerText.includes('没有命中片段'),
      names: Array.from(document.querySelectorAll('.kb__hit-name')).map(
        (node) => node.textContent || ''
      )
    }))()`)) as { busy: boolean; empty: boolean; names: string[] }
    return (
      !state.busy &&
      (state.empty || (state.names.length > 0 && !state.names.some((name) => name.includes('params.csv'))))
    )
  }, '删除后检索仍返回 params.csv')

  await fillKbQuery(window, '排水沟净宽')
  await clickButtonByText(window, '检索')
  await waitForCondition(
    async () =>
      ((await window.webContents.executeJavaScript(`(() => {
        return Array.from(document.querySelectorAll('.kb__hit-name')).some(
          (node) => (node.textContent || '').includes('scan.png')
        );
      })()`)) as boolean),
    '扫描图未被基准问题检索命中'
  )

  const scanHit = (await window.webContents.executeJavaScript(`(() => {
    const hits = Array.from(document.querySelectorAll('.kb__hits li')).filter(
      (node) => (node.querySelector('.kb__hit-name')?.textContent || '').includes('scan.png')
    );
    const hit = hits.find(
      (node) => (node.querySelector('.kb__hit-text')?.textContent || '').includes('排水沟净宽')
    ) || hits[0];
    if (!hit) return null;
    return {
      source: hit.querySelector('.kb__hit-source')?.textContent || '',
      text: hit.querySelector('.kb__hit-text')?.textContent || '',
      warning: hit.querySelector('.kb__hit-warning')?.textContent || ''
    };
  })()`)) as { source: string; text: string; warning: string } | null
  if (!scanHit) {
    throw new Error('未找到扫描图的检索命中')
  }
  if (!['视觉识别', '低置信'].every((text) => scanHit.source.includes(text))) {
    throw new Error(`扫描图命中缺少来源标识：${scanHit.source}`)
  }
  if (!scanHit.text.includes('排水沟净宽')) {
    throw new Error(`扫描图命中片段内容不符：${scanHit.text}`)
  }
  if (!scanHit.warning.includes('不能作为唯一依据')) {
    throw new Error(`低置信命中缺少提示：${scanHit.warning}`)
  }

  const before = (await window.webContents.executeJavaScript(
    'window.cad.kb.list()'
  )) as KbListOutcome
  if (!before.ok) {
    throw new Error(`读取知识库列表失败：${before.error ?? '未知错误'}`)
  }
  const expectedChunks = before.documents.reduce((total, doc) => total + doc.chunkCount, 0)

  await clickButtonByText(window, '重建索引')
  await waitForBody(
    window,
    `重建完成：${before.documents.length} 个文档，${expectedChunks} 个索引片段`,
    deadline
  )

  const after = (await window.webContents.executeJavaScript(
    'window.cad.kb.list()'
  )) as KbListOutcome
  const signature = (doc: KbDocument): string =>
    `${doc.name}:${doc.status}:${doc.chunkCount}`
  const beforeKeys = before.documents.map(signature).sort()
  const afterKeys = (after.documents ?? []).map(signature).sort()
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    throw new Error(
      `重建后索引不一致：${JSON.stringify(beforeKeys)} vs ${JSON.stringify(afterKeys)}`
    )
  }

  await fillKbQuery(window, '排水沟净宽')
  await waitForCondition(
    async () =>
      (await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.kb__search-form button');
        return Boolean(button && !button.disabled);
      })()`)) as boolean,
    '重建后检索按钮未恢复可用'
  )
  await clickButtonByText(window, '检索')
  await waitForCondition(
    async () =>
      (await window.webContents.executeJavaScript(`(() => {
        return Array.from(document.querySelectorAll('.kb__hit-name')).some(
          (node) => (node.textContent || '').includes('scan.png')
        );
      })()`)) as boolean,
    '重建后扫描图不再可检索'
  )
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.kb__hits')?.scrollIntoView({ block: 'center' });
    return true;
  })()`)

  if (shotPath) {
    await captureShot(window, shotPath)
  }
}

async function runDesignSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 90_000
  const dir = process.env.SMOKE_KB_DIR
  if (!dir) {
    throw new Error('缺少 SMOKE_KB_DIR')
  }
  const genRoot = process.env.SMOKE_GEN_ROOT
  if (!genRoot) {
    throw new Error('缺少 SMOKE_GEN_ROOT')
  }
  await rm(genRoot, { recursive: true, force: true })
  await mkdir(genRoot, { recursive: true })

  const files = ['spec.pdf', 'manual.docx', 'notes.dxf', 'params.csv'].map((name) =>
    resolve(dir, name)
  )
  const imported = (await window.webContents.executeJavaScript(
    `window.cad.kb.importPaths(${JSON.stringify(files)})`
  )) as KbImportOutcome
  if (!imported.ok) {
    throw new Error(`导入知识库失败：${imported.error ?? '未知错误'}`)
  }
  const failed = (imported.documents ?? []).filter((doc) => doc.status !== 'ready')
  if (failed.length > 0) {
    throw new Error(`知识库导入失败：${failed.map((doc) => doc.name).join('、')}`)
  }

  await enableFakeMode(window, deadline)
  await clickButtonByText(window, '生成')
  await waitForBody(window, '生成新图', deadline)

  await fillDesignPrompt(window, '生成一条 600×600 排水沟断面图，壁厚 100mm')
  await clickButtonByText(window, '整理参数')
  await waitForBody(window, '排水沟典型断面', deadline)
  await waitForBody(window, '待确认', deadline)

  interface DesignRow {
    id: string
    name: string
    value: string
    unit: string
    basis: string
    assumed: boolean
  }
  const rows = (await window.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.design__param')).map((row) => ({
      id: row.getAttribute('data-param') || '',
      name: row.querySelector('.design__param-name')?.textContent || '',
      value: row.querySelector('.design__param-value')?.value || '',
      unit: row.querySelector('.design__param-unit')?.textContent || '',
      basis: row.querySelector('.design__param-basis')?.textContent || '',
      assumed: Boolean(row.querySelector('.design__assumed'))
    }));
  })()`)) as DesignRow[]

  if (rows.length !== 4) {
    throw new Error(`参数清单应有 4 项，实际 ${rows.length}`)
  }
  const width = rows.find((row) => row.id === 'width')
  if (!width || width.name !== '净宽' || width.value !== '600' || width.unit !== 'mm') {
    throw new Error(`净宽参数不符：${JSON.stringify(width)}`)
  }
  if (!width.basis.includes('·') || width.basis.includes('无直接依据')) {
    throw new Error(`净宽缺少知识库依据：${width.basis}`)
  }
  const cover = rows.find((row) => row.id === 'cover')
  if (!cover?.assumed || !cover.basis.includes('假设')) {
    throw new Error(`盖板厚度应标为假设：${JSON.stringify(cover)}`)
  }

  await assertNoDxf(genRoot, '确认前')

  await fillDesignValue(window, 'width', '800')
  await clickButtonByText(window, '确认参数')
  await waitForBody(window, '后续生成将使用上表数值', deadline)

  const confirmed = (await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.design__param[data-param="width"] .design__param-value');
    const inputs = Array.from(document.querySelectorAll('.design__param-value'));
    return {
      width: input?.value || '',
      disabled: inputs.length > 0 && inputs.every((node) => node.disabled)
    };
  })()`)) as { width: string; disabled: boolean }
  if (confirmed.width !== '800') {
    throw new Error(`确认后净宽应为 800，实际 ${confirmed.width}`)
  }
  if (!confirmed.disabled) {
    throw new Error('确认后参数输入框应锁定')
  }

  await assertNoDxf(genRoot, '确认后')

  if (shotPath) {
    await captureShot(window, shotPath)
  }

  await clickButtonByText(window, '整理参数')
  await waitForBody(window, '待确认', deadline)
  await clickButtonByText(window, '取消')
  await waitForBody(window, '已取消，未生成任何文件。', deadline)
  await assertNoDxf(genRoot, '取消后')
}

async function fillDesignPrompt(window: BrowserWindow, value: string): Promise<void> {
  const filled = (await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.design__prompt');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)) as boolean
  if (!filled) {
    throw new Error('未找到生成需求输入框')
  }
}

async function fillDesignValue(window: BrowserWindow, param: string, value: string): Promise<void> {
  const filled = (await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.design__param[data-param="${param}"] .design__param-value');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)) as boolean
  if (!filled) {
    throw new Error(`未找到参数「${param}」的输入框`)
  }
}

async function assertNoDxf(dir: string, stage: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  const dxf = entries.filter((entry) => entry.toLowerCase().endsWith('.dxf'))
  if (dxf.length > 0) {
    throw new Error(`${stage}不应产生 DXF 文件：${dxf.join('、')}`)
  }
}

async function runHistorySmoke(
  window: BrowserWindow,
  mode: string,
  shotPath?: string
): Promise<void> {
  const deadline = Date.now() + 60_000
  const question = '这张图有多少个实体？'
  const listSessions = async (): Promise<HistoryListOutcome> =>
    (await window.webContents.executeJavaScript('window.cad.history.list()')) as HistoryListOutcome

  if (mode === 'seed') {
    await enableFakeMode(window, deadline)
    if (process.env.SMOKE_DXF) {
      await waitForBody(window, 'simple.dxf', deadline)
    }
    await askQuestion(window, question)
    await waitForBody(window, '假模型回答', deadline)

    const outcome = await listSessions()
    if (!outcome.ok || outcome.sessions.length !== 1) {
      throw new Error(`提问后应自动创建 1 个会话：${JSON.stringify(outcome)}`)
    }
    const session = outcome.sessions[0]
    if (session.title !== question) {
      throw new Error(`会话标题不符：${session.title}`)
    }
    if (session.messageCount !== 2 || session.generationCount !== 0) {
      throw new Error(`会话计数不符：${JSON.stringify(session)}`)
    }
    if (process.env.SMOKE_DXF && session.drawingName !== 'simple.dxf') {
      throw new Error(`会话未关联图纸：${JSON.stringify(session)}`)
    }

    await clickButtonByText(window, '历史')
    await waitForBody(window, question, deadline)
    await waitForBody(window, '2 条消息', deadline)
    await clickHistorySession(window)
    await waitForBody(window, '尚无生成记录', deadline)
    await waitForBody(window, '假模型回答', deadline)

    if (shotPath) {
      await captureShot(window, shotPath)
    }
    return
  }

  if (mode !== 'restore') {
    throw new Error(`未知 SMOKE_HISTORY 模式：${mode}`)
  }

  await waitForBody(window, '假模型回答', deadline)
  if (process.env.SMOKE_DXF) {
    await waitForBody(window, 'simple.dxf', deadline)
  }

  await clickButtonByText(window, '历史')
  await waitForBody(window, question, deadline)

  const restored = await listSessions()
  if (!restored.ok || restored.sessions.length !== 1) {
    throw new Error(`重启后应恢复 1 个会话：${JSON.stringify(restored)}`)
  }
  const session = restored.sessions[0]
  if (session.title !== question || session.messageCount !== 2) {
    throw new Error(`恢复的会话不符：${JSON.stringify(session)}`)
  }
  if (process.env.SMOKE_DXF && session.drawingName !== 'simple.dxf') {
    throw new Error(`恢复的会话缺少图纸关联：${JSON.stringify(session)}`)
  }

  await clickHistorySession(window)
  await waitForBody(window, '尚无生成记录', deadline)
  await waitForBody(window, '提问', deadline)
  await waitForBody(window, '回答', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }

  await window.webContents.executeJavaScript(
    '(() => { window.confirm = () => true; return true })()'
  )
  await clickButtonByText(window, '删除')
  await waitForBody(window, '会话已删除', deadline)

  const after = await listSessions()
  if (!after.ok || after.sessions.length !== 0) {
    throw new Error(`删除后应无会话：${JSON.stringify(after)}`)
  }
}

async function clickHistorySession(window: BrowserWindow): Promise<void> {
  const clicked = (await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('.history__session');
    if (!target) return false;
    target.click();
    return true;
  })()`)) as boolean
  if (!clicked) {
    throw new Error('未找到历史会话')
  }
}

async function runRecoverySmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 60_000
  const killed = (await window.webContents.executeJavaScript(
    'window.cad.sidecar.killForTest()'
  )) as DiagnosticsActionOutcome
  if (!killed.ok) {
    throw new Error(`无法终止侧车：${killed.error ?? '未知错误'}`)
  }

  await waitForCondition(async () => {
    const text = await readBody(window)
    return text.includes('侧车服务异常') || text.includes('侧车服务启动中')
  }, '未观察到侧车异常或恢复中状态')

  await waitForBody(window, '侧车服务就绪', deadline)

  const status = (await window.webContents.executeJavaScript(
    'window.cad.sidecar.getStatus()'
  )) as SidecarStatus
  if (status.state !== 'ready' || !status.health?.ezdxf) {
    throw new Error(`侧车未恢复健康：${JSON.stringify(status)}`)
  }

  await waitForCondition(async () => {
    const log = (await window.webContents.executeJavaScript(
      'window.cad.diagnostics.tail()'
    )) as DiagnosticsLogOutcome
    const text = log.lines.join('\n')
    return log.ok && text.includes('自动恢复成功')
  }, '日志中缺少侧车自动恢复记录')

  await clickButtonByText(window, '设置')
  await waitForBody(window, '诊断日志', deadline)
  await waitForBody(window, '自动恢复成功', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }
}

async function runOdaGuideSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 20_000

  await waitForBody(window, '未检测到 ODA File Converter', deadline)

  const status = (await window.webContents.executeJavaScript(
    'window.cad.converter.status()'
  )) as ConverterStatus
  if (status.found) {
    throw new Error(`测试模式应返回未安装：${JSON.stringify(status)}`)
  }

  await clickButtonByText(window, '查看安装指引')
  await waitForBody(window, 'DWG 转换器', deadline)
  await waitForBody(window, '打开下载页', deadline)
  await clickButtonByText(window, '重新检测')
  await waitForBody(window, '未安装', deadline)

  if (shotPath) {
    await captureShot(window, shotPath)
  }

  await clickButtonByText(window, '图纸')
  await waitForBody(window, '未检测到 ODA File Converter', deadline)
  await clickButtonByText(window, '暂时忽略')
  await waitForCondition(
    async () => !(await readBody(window)).includes('未检测到 ODA File Converter'),
    '点击「暂时忽略」后提示条仍然存在'
  )
}

async function runKbQaSmoke(window: BrowserWindow, shotPath?: string): Promise<void> {
  const deadline = Date.now() + 60_000
  const dir = process.env.SMOKE_KB_DIR
  if (!dir) {
    throw new Error('缺少 SMOKE_KB_DIR')
  }
  const files = ['notes.dxf', 'params.csv', 'spec.pdf', 'manual.docx'].map((name) =>
    resolve(dir, name)
  )

  const imported = (await window.webContents.executeJavaScript(
    `window.cad.kb.importPaths(${JSON.stringify(files)})`
  )) as KbImportOutcome
  if (!imported.ok) {
    throw new Error(`导入失败：${imported.error ?? '未知错误'}`)
  }

  await enableFakeMode(window, deadline)
  await askQuestion(window, '排水沟净宽有哪些规范要求？')
  await waitForBody(window, '知识库检索到相关条款', deadline)
  await waitForBody(window, 'ask_knowledge', deadline)
  await waitForBody(window, '出处（', deadline)

  const summaries = (await window.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('.chat__source summary')).map(
      (node) => node.textContent || ''
    );
  })()`)) as string[]
  if (!summaries.some((text) => text.includes('notes.dxf') && text.includes('句柄 #A1F'))) {
    throw new Error(`出处缺少 notes.dxf 或句柄 #A1F：${JSON.stringify(summaries)}`)
  }

  const snippet = (await window.webContents.executeJavaScript(`(() => {
    const source = Array.from(document.querySelectorAll('.chat__source')).find((node) =>
      (node.querySelector('summary')?.textContent || '').includes('notes.dxf')
    );
    if (!source) return '';
    source.open = true;
    return source.querySelector('.chat__source-text')?.textContent || '';
  })()`)) as string
  if (!snippet.includes('排水沟净宽')) {
    throw new Error(`展开出处后未显示原文片段：${snippet}`)
  }

  await askQuestion(window, '隧道照明亮度规范要求是什么？')
  await waitForBody(window, '依据不足', deadline)
  await waitForBody(window, '没有检索到', deadline)

  const lastAnswer = (await window.webContents.executeJavaScript(`(() => {
    const answers = Array.from(document.querySelectorAll('.chat__answer'));
    const last = answers.at(-1);
    return {
      count: answers.length,
      hasSources: last ? Boolean(last.querySelector('.chat__sources')) : null
    };
  })()`)) as { count: number; hasSources: boolean | null }
  if (lastAnswer.count !== 2) {
    throw new Error(`应有两轮问答，实际 ${lastAnswer.count}`)
  }
  if (lastAnswer.hasSources !== false) {
    throw new Error('无命中回答不应展示出处')
  }

  if (shotPath) {
    await captureShot(window, shotPath)
  }
}

async function enableFakeMode(window: BrowserWindow, deadline: number): Promise<void> {
  await clickButtonByText(window, '设置')
  await waitForBody(window, '模型设置', deadline)
  await window.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('.settings input[type="checkbox"]');
    if (!box) return false;
    if (!box.checked) box.click();
    return true;
  })()`)
  await clickButtonByText(window, '保存设置')
  await waitForBody(window, '设置已保存', deadline)

  await clickButtonByText(window, '图纸')
  await waitForBody(window, '读图问答', deadline)
}

async function askQuestion(window: BrowserWindow, prompt: string): Promise<void> {
  const filled = (await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.chat__composer textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(prompt)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)) as boolean
  if (!filled) {
    throw new Error('未找到问答输入框')
  }
  await clickButtonByText(window, '发送')
}

async function countAmberPixels(window: BrowserWindow): Promise<number> {
  return (await window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.drawing-canvas');
    if (!canvas) return -1;
    const context = canvas.getContext('2d');
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 200 && data[index + 1] > 140 && data[index + 2] < 100) count += 1;
    }
    return count;
  })()`)) as number
}

async function captureShot(window: BrowserWindow, shotPath: string): Promise<void> {
  await mkdir(dirname(shotPath), { recursive: true })
  let image: Electron.NativeImage | null = null
  for (let attempt = 0; attempt < 3 && !image; attempt += 1) {
    try {
      image = await window.webContents.capturePage()
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  if (!image) throw new Error('截图失败')
  await writeFile(shotPath, image.toPNG())
}

app.whenReady().then(async () => {
  await settingsStore.init()
  logger.write('info', 'app', '应用启动', {
    version: app.getVersion(),
    electron: process.versions.electron
  })
  sidecar.onStatusChange(handleSidecarStatus)
  registerIpc()
  const window = createWindow()
  const healthTimer = setInterval(() => {
    void checkSidecarHealth()
  }, 20_000)
  healthTimer.unref?.()
  app.on('before-quit', () => clearInterval(healthTimer))

  try {
    await sidecar.start()
  } catch {
    // 状态事件已广播错误
  }

  if (isSmoke) {
    await runSmoke(window)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  void sidecar.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void sidecar.stop()
})
