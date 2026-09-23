import type { FlacConversionResult } from '@common/flacConverter'

export interface FlacConversionResultSummary {
  hasAnomalies: boolean
  countMismatch: boolean
  skippedCount: number
  failedCount: number
}

export const anomalousSkippedItems = (result: FlacConversionResult): FlacConversionResult['skipped'] =>
  result.skipped.filter(item => item.reason != '目标 MP3 已存在，禁止覆盖。')

export const summarizeFlacConversionResult = (result: FlacConversionResult): FlacConversionResultSummary => ({
  hasAnomalies: anomalousSkippedItems(result).length > 0 || result.failed.length > 0 || !result.countMatches,
  countMismatch: !result.countMatches,
  skippedCount: result.skipped.length,
  failedCount: result.failed.length,
})
