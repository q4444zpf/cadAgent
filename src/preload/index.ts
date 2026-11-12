import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentAsk,
  AgentAskResult,
  AgentStreamEvent,
  ConnectionTestResult,
  ConverterActionOutcome,
  ConverterStatus,
  DesignActionOutcome,
  DesignCancel,
  DesignConfirm,
  DesignConfirmOutcome,
  DesignPrompt,
  DesignProposal,
  DiagnosticsActionOutcome,
  DiagnosticsLogOutcome,
  DrawingOpenResult,
  DrawingPhaseEvent,
  HistoryActionOutcome,
  HistoryCreate,
  HistoryListOutcome,
  HistorySessionOutcome,
  KbActionOutcome,
  KbImportOutcome,
  KbListOutcome,
  KbRebuildOutcome,
  KbSearchOutcome,
  LayerEntitiesResult,
  ModelProvider,
  ModelSettingsSave,
  ProjectCloseOutcome,
  ProjectInfo,
  ProjectOpenOutcome,
  ProjectPickFilesOutcome,
  ProjectVerifyFilesOutcome,
  PublicModelSettings,
  SettingsSaveResult,
  SidecarStatus
} from '../shared/protocol'

contextBridge.exposeInMainWorld('cad', {
  sidecar: {
    getStatus: (): Promise<SidecarStatus> => ipcRenderer.invoke('sidecar:get-status'),
    restart: (): Promise<SidecarStatus> => ipcRenderer.invoke('sidecar:restart'),
    onStatus: (callback: (status: SidecarStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: SidecarStatus): void => {
        callback(status)
      }
      ipcRenderer.on('sidecar:status', listener)
      return () => {
        ipcRenderer.removeListener('sidecar:status', listener)
      }
    },
    killForTest: (): Promise<DiagnosticsActionOutcome> => ipcRenderer.invoke('sidecar:kill')
  },
  drawing: {
    open: (): Promise<DrawingOpenResult | null> => ipcRenderer.invoke('drawing:open'),
    load: (path: string): Promise<DrawingOpenResult> => ipcRenderer.invoke('drawing:load', path),
    layer: (path: string, layer: string): Promise<LayerEntitiesResult> =>
      ipcRenderer.invoke('drawing:layer', { path, layer }),
    autoOpen: (): Promise<{ path: string } | null> => ipcRenderer.invoke('drawing:auto-open'),
    onPhase: (callback: (event: DrawingPhaseEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DrawingPhaseEvent): void => {
        callback(payload)
      }
      ipcRenderer.on('drawing:phase', listener)
      return () => {
        ipcRenderer.removeListener('drawing:phase', listener)
      }
    }
  },
  project: {
    open: (): Promise<ProjectOpenOutcome> => ipcRenderer.invoke('project:open'),
    current: (): Promise<ProjectInfo | null> => ipcRenderer.invoke('project:current'),
    close: (): Promise<ProjectCloseOutcome> => ipcRenderer.invoke('project:close'),
    pickFiles: (): Promise<ProjectPickFilesOutcome> => ipcRenderer.invoke('project:pick-files'),
    verifyFiles: (paths: string[]): Promise<ProjectVerifyFilesOutcome> =>
      ipcRenderer.invoke('project:verify-files', paths)
  },
  settings: {
    get: (): Promise<PublicModelSettings> => ipcRenderer.invoke('settings:get'),
    save: (input: ModelSettingsSave): Promise<SettingsSaveResult> =>
      ipcRenderer.invoke('settings:save', input)
  },
  model: {
    providers: (): Promise<ModelProvider[]> => ipcRenderer.invoke('model:providers'),
    models: (provider: string): Promise<string[]> => ipcRenderer.invoke('model:list', provider),
    test: (): Promise<ConnectionTestResult> => ipcRenderer.invoke('model:test')
  },
  agent: {
    ask: (input: AgentAsk): Promise<AgentAskResult> => ipcRenderer.invoke('agent:ask', input),
    abort: (): Promise<boolean> => ipcRenderer.invoke('agent:abort'),
    onEvent: (callback: (event: AgentStreamEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentStreamEvent): void => {
        callback(payload)
      }
      ipcRenderer.on('agent:event', listener)
      return () => {
        ipcRenderer.removeListener('agent:event', listener)
      }
    }
  },
  kb: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('kb:pick'),
    importPaths: (paths: string[]): Promise<KbImportOutcome> =>
      ipcRenderer.invoke('kb:import', paths),
    list: (): Promise<KbListOutcome> => ipcRenderer.invoke('kb:list'),
    remove: (docId: string): Promise<KbActionOutcome> =>
      ipcRenderer.invoke('kb:delete', docId),
    rebuild: (): Promise<KbRebuildOutcome> => ipcRenderer.invoke('kb:rebuild'),
    search: (query: string): Promise<KbSearchOutcome> => ipcRenderer.invoke('kb:search', query)
  },
  design: {
    propose: (input: DesignPrompt): Promise<DesignProposal> =>
      ipcRenderer.invoke('design:propose', input),
    confirm: (input: DesignConfirm): Promise<DesignConfirmOutcome> =>
      ipcRenderer.invoke('design:confirm', input),
    cancel: (input: DesignCancel): Promise<DesignActionOutcome> =>
      ipcRenderer.invoke('design:cancel', input)
  },
  history: {
    list: (): Promise<HistoryListOutcome> => ipcRenderer.invoke('history:list'),
    current: (): Promise<HistorySessionOutcome> => ipcRenderer.invoke('history:current'),
    get: (sessionId: string): Promise<HistorySessionOutcome> =>
      ipcRenderer.invoke('history:get', { sessionId }),
    create: (input: HistoryCreate): Promise<HistorySessionOutcome> =>
      ipcRenderer.invoke('history:create', input),
    open: (sessionId: string): Promise<HistorySessionOutcome> =>
      ipcRenderer.invoke('history:open', { sessionId }),
    remove: (sessionId: string): Promise<HistoryActionOutcome> =>
      ipcRenderer.invoke('history:delete', { sessionId })
  },
  diagnostics: {
    tail: (): Promise<DiagnosticsLogOutcome> => ipcRenderer.invoke('diagnostics:tail'),
    openLogs: (): Promise<DiagnosticsActionOutcome> => ipcRenderer.invoke('diagnostics:open')
  },
  converter: {
    status: (): Promise<ConverterStatus> => ipcRenderer.invoke('converter:status'),
    openDownload: (): Promise<ConverterActionOutcome> =>
      ipcRenderer.invoke('converter:open-download')
  }
})
