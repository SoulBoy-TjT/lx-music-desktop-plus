import { resolveDownloadQuality } from '@common/utils/downloadQuality'

export interface BatchDownloadQualityState {
  available: boolean
  reason: 'no_online_tracks' | 'source_unsupported' | 'track_unsupported' | 'track_fallback' | null
}

export const getBatchDownloadQualityState = (
  list: LX.Music.MusicInfo[],
  quality: LX.Quality,
  sourceQualityList: LX.QualityList,
): BatchDownloadQualityState => {
  const onlineTracks = list.filter((track): track is LX.Music.MusicInfoOnline => track.source != 'local')
  if (!onlineTracks.length) return { available: false, reason: 'no_online_tracks' }

  if (onlineTracks.some(track => !sourceQualityList[track.source]?.length)) {
    return { available: false, reason: 'source_unsupported' }
  }

  const resolvedQualitys = onlineTracks.map(track =>
    resolveDownloadQuality(track, quality, sourceQualityList[track.source]),
  )
  if (resolvedQualitys.some(quality => quality == null)) {
    return { available: false, reason: 'track_unsupported' }
  }

  return {
    available: true,
    reason: resolvedQualitys.some(resolvedQuality => resolvedQuality != quality) ? 'track_fallback' : null,
  }
}
