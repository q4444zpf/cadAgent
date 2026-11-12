import { z } from 'zod'

export const SidecarRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({})
})

export type SidecarRequest = z.infer<typeof SidecarRequestSchema>

export const SidecarErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string()
})

export const SidecarResponseSchema = z.union([
  z.object({
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown()
  }),
  z.object({
    id: z.string().nullable(),
    ok: z.literal(false),
    error: SidecarErrorSchema
  })
])

export type SidecarResponse = z.infer<typeof SidecarResponseSchema>

export const HealthResultSchema = z.object({
  service: z.literal('cad-service'),
  version: z.string().min(1),
  ezdxf: z.string().min(1),
  python: z.string().min(1)
})

export type HealthResult = z.infer<typeof HealthResultSchema>

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'error'

export interface SidecarStatus {
  state: SidecarState
  detail?: string
  health?: HealthResult
}

export const PointSchema = z.tuple([z.number(), z.number()])

const entityBase = {
  handle: z.string(),
  layer: z.string(),
  color: z.number().int()
}

export const DrawingEntitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('line'),
    ...entityBase,
    start: PointSchema,
    end: PointSchema
  }),
  z.object({
    kind: z.literal('polyline'),
    ...entityBase,
    points: z.array(PointSchema).min(2),
    closed: z.boolean()
  }),
  z.object({
    kind: z.literal('circle'),
    ...entityBase,
    center: PointSchema,
    radius: z.number()
  }),
  z.object({
    kind: z.literal('arc'),
    ...entityBase,
    center: PointSchema,
    radius: z.number(),
    startAngle: z.number(),
    endAngle: z.number()
  }),
  z.object({
    kind: z.literal('text'),
    ...entityBase,
    insert: PointSchema,
    text: z.string(),
    height: z.number(),
    rotation: z.number()
  })
])

export type DrawingEntity = z.infer<typeof DrawingEntitySchema>

export const DrawingLayerSchema = z.object({
  name: z.string(),
  color: z.number().int(),
  entityCount: z.number().int().nonnegative()
})

export type DrawingLayer = z.infer<typeof DrawingLayerSchema>

export const DrawingBoundsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number()
})

export type DrawingBounds = z.infer<typeof DrawingBoundsSchema>

export const DrawingSchema = z.object({
  path: z.string(),
  name: z.string(),
  layers: z.array(DrawingLayerSchema),
  entities: z.array(DrawingEntitySchema),
  bounds: DrawingBoundsSchema.nullable(),
  unsupported: z.record(z.string(), z.number().int()),
  summaryOnly: z.boolean().optional(),
  entityCounts: z.record(z.string(), z.number().int()).optional(),
  textSamples: z.array(z.string()).optional()
})

export type Drawing = z.infer<typeof DrawingSchema>

export function drawingEntityCount(drawing: Drawing): number {
  return drawing.entityCounts
    ? Object.values(drawing.entityCounts).reduce((sum, count) => sum + count, 0)
    : drawing.entities.length
}

export const DrawingOpenResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), drawing: DrawingSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() })
  })
])

export type DrawingOpenResult = z.infer<typeof DrawingOpenResultSchema>

export interface DrawingPhaseEvent {
  phase: 'converting'
  name: string
}

export const LayerEntitiesRequestSchema = z.object({
  path: z.string().min(1),
  layer: z.string().min(1)
})

export type LayerEntitiesRequest = z.infer<typeof LayerEntitiesRequestSchema>

export interface LayerEntitiesResult {
  ok: boolean
  entities: DrawingEntity[]
  error?: string
}

export const FileAttachmentSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['drawing', 'archive', 'document', 'text', 'image', 'other']),
  size: z.number().int().nonnegative()
})

export type FileAttachment = z.infer<typeof FileAttachmentSchema>

export const ProjectEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir', 'archive', 'symlink']),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative(),
  extension: z.string().optional(),
  format: z.string().optional()
})

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>

export const ProjectScanSchema = z.object({
  path: z.string(),
  entries: z.array(ProjectEntrySchema),
  totals: z.object({
    files: z.number().int().nonnegative(),
    dirs: z.number().int().nonnegative(),
    archives: z.number().int().nonnegative()
  }),
  byExtension: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
  ignored: z.array(z.string()),
  warnings: z.array(z.string())
})

export type ProjectScanResult = z.infer<typeof ProjectScanSchema>

export const ArchiveEntrySchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  compressedSize: z.number().int().nonnegative().nullable(),
  isDir: z.boolean(),
  isLink: z.boolean(),
  modifiedAt: z.number().int().nullable()
})

export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>

export const ArchiveListSchema = z.object({
  path: z.string(),
  format: z.string(),
  entryCount: z.number().int().nonnegative(),
  totalUncompressedBytes: z.number().int().nonnegative(),
  entries: z.array(ArchiveEntrySchema),
  truncated: z.boolean()
})

export type ArchiveListResult = z.infer<typeof ArchiveListSchema>

export const ArchiveExtractSchema = z.object({
  path: z.string(),
  target: z.string(),
  filesExtracted: z.number().int().nonnegative(),
  directoriesCreated: z.number().int().nonnegative(),
  bytesExtracted: z.number().int().nonnegative()
})

export type ArchiveExtractResult = z.infer<typeof ArchiveExtractSchema>

export const FileReadSchema = z.object({
  path: z.string(),
  kind: z.enum(['dxf', 'pdf', 'docx', 'text', 'image']),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  encoding: z.string().nullable(),
  content: z.string().optional(),
  pages: z.number().int().nonnegative().optional(),
  paragraphs: z.number().int().nonnegative().optional(),
  summary: DrawingSchema.optional()
})

export type FileReadResult = z.infer<typeof FileReadSchema>

export const ModelSettingsSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  fakeMode: z.boolean()
})

export type ModelSettings = z.infer<typeof ModelSettingsSchema>

export const ModelSettingsSaveSchema = ModelSettingsSchema.extend({
  apiKey: z.string().nullable().optional()
})

export type ModelSettingsSave = z.infer<typeof ModelSettingsSaveSchema>

export const PublicModelSettingsSchema = ModelSettingsSchema.extend({
  hasApiKey: z.boolean(),
  secretStorage: z.enum(['os', 'unavailable'])
})

export type PublicModelSettings = z.infer<typeof PublicModelSettingsSchema>

export const SettingsSaveResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: PublicModelSettingsSchema }),
  z.object({ ok: z.literal(false), error: z.string() })
])

export type SettingsSaveResult = z.infer<typeof SettingsSaveResultSchema>

export const ModelProviderSchema = z.object({
  id: z.string(),
  name: z.string()
})

export type ModelProvider = z.infer<typeof ModelProviderSchema>

export const ConnectionTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string() }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(['auth', 'network', 'unknown']),
    message: z.string()
  })
])

export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>

export const AgentAskSchema = z.object({
  requestId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  attachments: z.array(FileAttachmentSchema).max(10).optional()
})

export type AgentAsk = z.infer<typeof AgentAskSchema>

export interface EntityReference {
  handle: string
  exists: boolean
  kind?: string
  layer?: string
}

export type AgentStreamEvent =
  | { type: 'text_delta'; requestId: string; delta: string }
  | {
      type: 'tool_start'
      requestId: string
      callId: string
      name: string
      args: unknown
    }
  | {
      type: 'tool_end'
      requestId: string
      callId: string
      name: string
      ok: boolean
      output: string
      durationMs?: number
    }
  | {
      type: 'run_end'
      requestId: string
      text: string
      aborted: boolean
      references?: EntityReference[]
      sources?: KbHit[]
      error?: string
    }

export interface AgentAskResult {
  ok: boolean
  error?: string
  sessionId?: string
}

export const KbDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  type: z.string(),
  sourceType: z.enum(['text', 'vision']).optional(),
  confidence: z.number().optional().nullable(),
  status: z.enum(['ready', 'failed']),
  chunkCount: z.number().int().nonnegative(),
  importedAt: z.number().int(),
  error: z.string().nullable().optional()
})

export type KbDocument = z.infer<typeof KbDocumentSchema>

export const KbLocationSchema = z.record(z.string(), z.union([z.string(), z.number()]))

export type KbLocation = z.infer<typeof KbLocationSchema>

export const KbHitSchema = z.object({
  docId: z.string(),
  docName: z.string(),
  text: z.string(),
  location: KbLocationSchema,
  sourceType: z.enum(['text', 'vision']).optional(),
  confidence: z.number().optional(),
  score: z.number()
})

export type KbHit = z.infer<typeof KbHitSchema>

export const VisionRecognitionSchema = z.object({
  description: z.string(),
  points: z.array(z.string()),
  confidence: z.number()
})

export type VisionRecognition = z.infer<typeof VisionRecognitionSchema>

export interface VisionFailure {
  error: string
}

export type KbRecognition = VisionRecognition | VisionFailure

export const LOW_CONFIDENCE = 0.6

export function isLowConfidence(hit: {
  sourceType?: string
  confidence?: number | null
}): boolean {
  return hit.sourceType === 'vision' && typeof hit.confidence === 'number'
    ? hit.confidence < LOW_CONFIDENCE
    : false
}

export interface KbImportOutcome {
  ok: boolean
  documents?: KbDocument[]
  error?: string
}

export interface KbListOutcome {
  ok: boolean
  documents: KbDocument[]
  error?: string
}

export interface KbActionOutcome {
  ok: boolean
  error?: string
}

export interface KbRebuildOutcome extends KbActionOutcome {
  documents?: number
  failed?: number
  chunks?: number
}

export interface KbSearchOutcome {
  ok: boolean
  hits: KbHit[]
  error?: string
}

export const DesignParameterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.string().min(1),
  unit: z.string(),
  basis: z.string(),
  assumed: z.boolean()
})

export type DesignParameter = z.infer<typeof DesignParameterSchema>

export const ParameterListSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  drawingType: z.string().min(1),
  summary: z.string(),
  parameters: z.array(DesignParameterSchema).min(1)
})

export type ParameterList = z.infer<typeof ParameterListSchema>

export type DesignStatus = 'draft' | 'confirmed' | 'cancelled'

export interface DesignSessionView {
  list: ParameterList
  status: DesignStatus
  confirmedValues?: Record<string, string>
}

export interface DesignProposal {
  ok: boolean
  session?: DesignSessionView
  warning?: string
  error?: string
}

export interface DesignConfirmOutcome {
  ok: boolean
  session?: DesignSessionView
  error?: string
}

export const DesignPromptSchema = z.object({
  prompt: z.string().trim().min(1).max(4000)
})

export type DesignPrompt = z.infer<typeof DesignPromptSchema>

export const DesignConfirmSchema = z.object({
  listId: z.string().min(1),
  values: z.record(z.string(), z.string())
})

export type DesignConfirm = z.infer<typeof DesignConfirmSchema>

export const DesignCancelSchema = z.object({
  listId: z.string().min(1)
})

export type DesignCancel = z.infer<typeof DesignCancelSchema>

export interface DesignActionOutcome {
  ok: boolean
  error?: string
}

export interface ProjectInfo {
  root: string
  name: string
}

export interface ProjectOpenOutcome {
  ok: boolean
  project?: ProjectInfo
  canceled?: boolean
  error?: string
}

export interface ProjectPickFilesOutcome {
  ok: boolean
  files?: FileAttachment[]
  canceled?: boolean
  error?: string
}

export interface ProjectCloseOutcome {
  ok: boolean
  error?: string
}

export interface ProjectVerifyFilesOutcome {
  ok: boolean
  missing?: string[]
  error?: string
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  sources?: KbHit[]
  references?: EntityReference[]
  attachments?: FileAttachment[]
  error?: string
}

export interface HistorySessionSummary {
  id: string
  title: string
  drawingPath: string | null
  drawingName: string | null
  projectRoot: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  generationCount: number
}

export const ValidationReportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string())
})

export type ValidationReport = z.infer<typeof ValidationReportSchema>

export interface GenerationRecordView {
  id: string
  createdAt: number
  filePath: string
  fileExists: boolean
  parameters: DesignParameter[]
  validation: ValidationReport | null
}

export interface HistorySessionView extends HistorySessionSummary {
  messages: HistoryMessage[]
  generations: GenerationRecordView[]
}

export interface HistoryListOutcome {
  ok: boolean
  sessions: HistorySessionSummary[]
  error?: string
}

export interface HistorySessionOutcome {
  ok: boolean
  session?: HistorySessionView
  projectUnavailable?: boolean
  error?: string
}

export interface HistoryActionOutcome {
  ok: boolean
  error?: string
}

export const HistoryCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  drawingPath: z.string().nullable().optional(),
  drawingName: z.string().nullable().optional()
})

export type HistoryCreate = z.infer<typeof HistoryCreateSchema>

export const HistoryIdSchema = z.object({
  sessionId: z.string().min(1)
})

export type HistoryId = z.infer<typeof HistoryIdSchema>

export interface DiagnosticsLogOutcome {
  ok: boolean
  path: string
  lines: string[]
  error?: string
}

export interface DiagnosticsActionOutcome {
  ok: boolean
  path?: string
  error?: string
}

export interface ConverterStatus {
  found: boolean
  path: string | null
  version?: string
}

export interface ConverterActionOutcome {
  ok: boolean
  error?: string
}
