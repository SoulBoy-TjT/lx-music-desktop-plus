import { describe, expect, it } from 'vitest'
import type { FlacConversionResult } from '@common/flacConverter'
import { summarizeFlacConversionResult } from './resultState'

const result = (overrides: Partial<FlacConversionResult> = {}): FlacConversionResult => ({
  taskId: 'task',
  outputDirectory: 'output',
  succeeded: [],
  skipped: [],
  failed: [],
  sourceSongCount: 2,
  outputSongCount: 2,
  countMatches: true,
  ...overrides,
})

describe('FLAC conversion result visibility', () => {
  it('hides details when conversion has no anomalies', () => {
    expect(summarizeFlacConversionResult(result())).toEqual({
      hasAnomalies: false,
      countMismatch: false,
      skippedCount: 0,
      failedCount: 0,
    })
  })

  it('shows details for skipped, failed, or count-mismatched results', () => {
    expect(summarizeFlacConversionResult(result({
      skipped: [{ sourcePath: 'a', targetPath: 'b', reason: 'exists' }],
      outputSongCount: 1,
      countMatches: false,
    }))).toEqual({
      hasAnomalies: true,
      countMismatch: true,
      skippedCount: 1,
      failedCount: 0,
    })
  })
})
