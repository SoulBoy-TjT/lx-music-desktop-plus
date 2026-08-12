import {
  ARTIST_DISCOGRAPHY_SOURCES,
} from '@renderer/core/artistDiscography'
import type {
  ArtistDiscographySource,
  DiscographyBatchPlan,
  DiscographyPlan,
} from '@renderer/core/artistDiscography'

export type DiscographySourceSelection = Record<ArtistDiscographySource, boolean>

export const createDiscographySourceSelection = (
  sources: readonly ArtistDiscographySource[] = ARTIST_DISCOGRAPHY_SOURCES,
): DiscographySourceSelection => {
  const selected = new Set(sources)
  return {
    kg: selected.has('kg'),
    tx: selected.has('tx'),
    wy: selected.has('wy'),
    kw: selected.has('kw'),
  }
}

export const getSelectedDiscographySources = (
  selection: Readonly<DiscographySourceSelection>,
  allowedSources: readonly ArtistDiscographySource[] = ARTIST_DISCOGRAPHY_SOURCES,
): ArtistDiscographySource[] => {
  const allowed = new Set(allowedSources)
  return ARTIST_DISCOGRAPHY_SOURCES.filter(source => allowed.has(source) && selection[source])
}

export const canGenerateDiscographyPlaylist = (
  plan: DiscographyPlan | undefined,
): plan is DiscographyPlan => {
  if (!plan?.canApply) return false
  return (plan.status == 'complete' || plan.status == 'partial') &&
    plan.artist != null &&
    plan.albums.length > 0 &&
    plan.deduplicatedTrackCount > 0
}

export const createDiscographyGenerateSelection = (
  plan: DiscographyBatchPlan,
): DiscographySourceSelection => createDiscographySourceSelection(
  plan.sources.filter(source => canGenerateDiscographyPlaylist(plan.plans[source])),
)
