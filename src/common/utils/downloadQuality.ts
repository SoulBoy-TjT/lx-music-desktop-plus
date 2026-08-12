import { QUALITYS } from '@common/constants'

export const resolveDownloadQuality = (
  musicInfo: LX.Music.MusicInfoOnline,
  preferredQuality: LX.Quality,
  sourceQualitys: LX.Quality[] | undefined,
): LX.Quality | null => {
  if (!sourceQualitys?.length) return null

  const preferredIndex = QUALITYS.indexOf(preferredQuality)
  const candidates = preferredIndex < 0 ? QUALITYS : QUALITYS.slice(preferredIndex)
  const quality = candidates.find(quality =>
    sourceQualitys.includes(quality) &&
    (quality == '128k' || musicInfo.meta._qualitys[quality] != null),
  )
  return quality ?? null
}
