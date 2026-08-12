export interface FlacConverterCapability {
  supported: boolean
  platform: NodeJS.Platform
  arch: string
  ffmpegAvailable: boolean
  reason?: 'unsupported_platform' | 'ffmpeg_unavailable'
}

export interface FlacConversionPreviewItem {
  sourcePath: string
  targetPath: string
  kind: 'flac_to_mp3' | 'copy_mp3'
  size: number
  mtimeMs?: number
  fileIdentity?: string
  status: 'ready' | 'skipped'
  reason?: string
}

export interface FlacConversionPreview {
  sourceDirectory: string
  outputDirectory: string
  items: FlacConversionPreviewItem[]
  readyCount: number
  skippedCount: number
  totalSize: number
  flacCount: number
  mp3Count: number
}

export interface FlacConverterArtistFolder {
  name: string
  path: string
  outputDirectory: string
  flacCount: number
  mp3Count: number
  songCount: number
}

export interface FlacConverterArtistScanParams {
  rootDirectory: string
  outputParentDirectory?: string
}

export interface FlacConverterArtistScanResult {
  rootDirectory: string
  artists: FlacConverterArtistFolder[]
}

export interface FlacConversionPreviewParams {
  sourceDirectory: string
  outputParentDirectory?: string
}

export interface FlacConversionApplyParams extends FlacConversionPreviewParams {
  confirmedSourcePaths: string[]
}

export interface FlacConversionProgress {
  taskId: string
  sourceDirectory: string
  completedCount: number
  totalCount: number
  phase: 'running' | 'pausing' | 'paused' | 'completed'
  currentPath?: string
  currentKind?: FlacConversionPreviewItem['kind']
}

export interface FlacConversionPauseState {
  busy: boolean
  pauseRequested: boolean
  paused: boolean
}

export interface FlacConversionResultItem {
  sourcePath: string
  targetPath: string
  reason?: string
}

export interface FlacConversionResult {
  taskId: string
  outputDirectory: string
  succeeded: FlacConversionResultItem[]
  skipped: FlacConversionResultItem[]
  failed: FlacConversionResultItem[]
  sourceSongCount: number
  outputSongCount: number
  countMatches: boolean
}
