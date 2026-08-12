export type AudioCheckStatus = 'playable' | 'unplayable' | 'check_failed' | 'skipped'

export type SongOrganizerAnomalyType =
  | 'unplayable_audio'
  | 'audio_check_failed'
  | 'unsupported_file'
  | 'duplicate_hardlink'
  | 'reparse_point'
  | 'empty_directory'
  | 'operation_failed'

export interface SongOrganizerCapability {
  supported: boolean
  platform: NodeJS.Platform
  arch: string
  validatorAvailable: boolean
  validatorPath?: string
  reason?: 'unsupported_platform' | 'validator_unavailable'
}

export interface AudioValidationResult {
  status: Exclude<AudioCheckStatus, 'skipped'>
  errorCode?: string
  errorMessage?: string
}

export interface SongOrganizerAnomaly {
  id: string
  type: SongOrganizerAnomalyType
  path: string
  relativePath: string
  artistPath: string
  artistName: string
  albumPath?: string
  albumName?: string
  size: number
  status: string
  reason?: string
  fileIdentity?: string
  mtimeMs?: number
  cleanupEligible?: boolean
  keepPath?: string
}

export interface SongOrganizerFolderSummary {
  path: string
  name: string
  baseName: string
  audioCount: number
  playableCount: number
  unplayableCount: number
  checkFailedCount: number
  unsupportedFileCount: number
  targetName: string
  needsRename: boolean
}

export interface SongOrganizerArtistSummary extends SongOrganizerFolderSummary {
  albums: SongOrganizerFolderSummary[]
  blockedReasons: string[]
}

export interface SongOrganizerTotals {
  artistCount: number
  albumCount: number
  audioCount: number
  playableCount: number
  unplayableCount: number
  checkFailedCount: number
  unsupportedFileCount: number
  duplicateHardlinkCount: number
  reparsePointCount: number
  emptyDirectoryCount: number
  renameCount: number
}

export interface SongOrganizerRenameStep {
  type: 'album' | 'artist'
  from: string
  to: string
}

export interface SongOrganizerArtistRenamePlan {
  artistPath: string
  artistName: string
  targetName: string
  steps: SongOrganizerRenameStep[]
  blockedReasons: string[]
}

export interface SongOrganizerCleanupItem {
  path: string
  type: Extract<SongOrganizerAnomalyType, 'unsupported_file' | 'duplicate_hardlink' | 'reparse_point' | 'empty_directory'>
  artistPath: string
  size: number
  keepPath?: string
  fileIdentity?: string
  mtimeMs?: number
  referencedListCount: number
}

export interface SongOrganizerCleanupPreview {
  taskId: string
  items: SongOrganizerCleanupItem[]
  totalSize: number
  referencedItemCount: number
  referencedListCount: number
  blockedArtists: Array<{ artistPath: string, reasons: string[] }>
}

export type SongOrganizerOperationStepPhase = 'preparing' | 'cleanup' | 'renaming' | 'rollback' | 'rescanning'

export interface SongOrganizerOperationStepResult {
  path: string
  targetPath?: string
  status: 'succeeded' | 'skipped' | 'failed' | 'rolled_back' | 'rollback_failed'
  phase?: SongOrganizerOperationStepPhase
  reason?: string
}

export interface SongOrganizerOperationResult {
  taskId: string
  type: 'cleanup' | 'rename' | 'organize'
  succeeded: SongOrganizerOperationStepResult[]
  skipped: SongOrganizerOperationStepResult[]
  failed: SongOrganizerOperationStepResult[]
  rollbackFailed: SongOrganizerOperationStepResult[]
}

export interface SongOrganizerSnapshot {
  taskId: string
  root: string
  status: 'complete' | 'cancelled' | 'failed'
  checkedCount: number
  totalAudioCount: number
  artists: SongOrganizerArtistSummary[]
  anomalies: SongOrganizerAnomaly[]
  renamePlan: SongOrganizerArtistRenamePlan[]
  totals: SongOrganizerTotals
  validationStatus?: 'unchecked' | 'checked'
  errorCode?: string
  errorMessage?: string
}

export interface SongOrganizerCheckParams {
  taskId?: string
  quickSnapshotId: string
  artistPath: string
}

export interface SongOrganizerValidationSnapshot {
  id: string
  taskId: string
  quickSnapshotId: string
  root: string
  artistPath: string
  status: 'complete'
  checkedAt: number
  checkedCount: number
  totalAudioCount: number
  audioFingerprints: SongOrganizerAudioFingerprint[]
  snapshot: SongOrganizerSnapshot
}

export interface SongOrganizerAudioFingerprint {
  path: string
  fileIdentity?: string
  size: number
  mtimeMs: number
}

export interface SongOrganizerScanParams {
  root: string
  taskId?: string
}

export interface SongOrganizerScanProgress {
  taskId: string
  phase: 'discovering' | 'validating'
  checkedCount: number
  totalAudioCount: number
  currentPath?: string
}

export type SongOrganizerOperationProgressPhase = 'preparing' | 'cleanup' | 'renaming' | 'rollback' | 'rescanning' | 'completed' | 'failed'

export interface SongOrganizerOperationProgress {
  operationId: string
  sourceTaskId: string
  type: 'rename' | 'organize'
  phase: SongOrganizerOperationProgressPhase
  artistPath: string
  completed: number
  total: number
  currentRelativeTarget?: string
}

export interface SongOrganizerRuntimeState {
  revision: number
  status: 'idle' | 'scanning' | 'complete' | 'cancelled' | 'failed'
  taskId?: string
  root?: string
  progress?: SongOrganizerScanProgress
  snapshot?: SongOrganizerSnapshot
  validations?: SongOrganizerValidationSnapshot[]
  errorMessage?: string
}

export interface SongOrganizerApplyParams {
  taskId: string
  validationId?: string
  operationId?: string
  artistPaths: string[]
  playingFilePath?: string
}

export interface SongOrganizerCleanupApplyParams extends SongOrganizerApplyParams {
  confirmedItemPaths: string[]
}

export interface SongOrganizerOrganizePreview extends SongOrganizerCleanupPreview {
  validationId: string
  renameSteps: SongOrganizerRenameStep[]
}

export interface SongOrganizerOrganizeApplyParams extends SongOrganizerCleanupApplyParams {
  validationId: string
}

export interface SongOrganizerRecovery {
  operationId: string
  type: 'cleanup' | 'rename'
  root: string
  startedAt: number
  completed: boolean
  steps: Array<{
    from: string
    to?: string
    status: 'planned' | 'succeeded' | 'failed' | 'rolled_back' | 'rollback_failed'
    reason?: string
  }>
}
