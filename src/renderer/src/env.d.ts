/// <reference types="vite/client" />

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
  HistoryActionOutcome,
  HistoryCreate,
  HistoryListOutcome,
  HistorySessionOutcome,
  KbActionOutcome,
  KbImportOutcome,
  KbListOutcome,
  KbRebuildOutcome,
  KbSearchOutcome,
  ModelProvider,
  ModelSettingsSave,
  PublicModelSettings,
  SettingsSaveResult,
  SidecarStatus
} from '../../shared/protocol'

declare global {
  interface Window {
    cad: {
      sidecar: {
        getStatus: () => Promise<SidecarStatus>
        restart: () => Promise<SidecarStatus>
        onStatus: (callback: (status: SidecarStatus) => void) => () => void
        killForTest: () => Promise<DiagnosticsActionOutcome>
      }
      drawing: {
        open: () => Promise<DrawingOpenResult | null>
        load: (path: string) => Promise<DrawingOpenResult>
        autoOpen: () => Promise<{ path: string } | null>
      }
      settings: {
        get: () => Promise<PublicModelSettings>
        save: (input: ModelSettingsSave) => Promise<SettingsSaveResult>
      }
      model: {
        providers: () => Promise<ModelProvider[]>
        models: (provider: string) => Promise<string[]>
        test: () => Promise<ConnectionTestResult>
      }
      agent: {
        ask: (input: AgentAsk) => Promise<AgentAskResult>
        abort: () => Promise<boolean>
        onEvent: (callback: (event: AgentStreamEvent) => void) => () => void
      }
      kb: {
        pick: () => Promise<string[]>
        importPaths: (paths: string[]) => Promise<KbImportOutcome>
        list: () => Promise<KbListOutcome>
        remove: (docId: string) => Promise<KbActionOutcome>
        rebuild: () => Promise<KbRebuildOutcome>
        search: (query: string) => Promise<KbSearchOutcome>
      }
      design: {
        propose: (input: DesignPrompt) => Promise<DesignProposal>
        confirm: (input: DesignConfirm) => Promise<DesignConfirmOutcome>
        cancel: (input: DesignCancel) => Promise<DesignActionOutcome>
      }
      history: {
        list: () => Promise<HistoryListOutcome>
        current: () => Promise<HistorySessionOutcome>
        get: (sessionId: string) => Promise<HistorySessionOutcome>
        create: (input: HistoryCreate) => Promise<HistorySessionOutcome>
        open: (sessionId: string) => Promise<HistorySessionOutcome>
        remove: (sessionId: string) => Promise<HistoryActionOutcome>
      }
      diagnostics: {
        tail: () => Promise<DiagnosticsLogOutcome>
        openLogs: () => Promise<DiagnosticsActionOutcome>
      }
      converter: {
        status: () => Promise<ConverterStatus>
        openDownload: () => Promise<ConverterActionOutcome>
      }
    }
  }
}

export {}
