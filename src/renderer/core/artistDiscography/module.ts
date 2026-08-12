import { applyArtistDiscography } from './apply'
import { planArtistDiscography } from './plan'
import type {
  ArtistDiscographyModule,
  ArtistDiscographyModuleOptions,
} from './types'

const getAlbumConcurrency = (value: number | undefined) => {
  if (typeof value != 'number' || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(3, Math.floor(value)))
}

export const createArtistDiscographyModule = (
  options: ArtistDiscographyModuleOptions,
): ArtistDiscographyModule => {
  const now = options.now ?? Date.now
  let lastIdTimestamp = -1
  let idSequence = 0
  const createPlaylistId = options.createPlaylistId ?? (() => {
    const timestamp = now()
    if (timestamp == lastIdTimestamp) idSequence++
    else {
      lastIdTimestamp = timestamp
      idSequence = 0
    }
    return `userlist_${timestamp}${idSequence ? `_${idSequence}` : ''}`
  })

  return {
    plan: async input => planArtistDiscography(input, {
      catalog: options.catalog,
      albumConcurrency: getAlbumConcurrency(options.albumConcurrency),
      now,
    }),
    apply: async input => applyArtistDiscography(input, {
      playlist: options.playlist,
      createPlaylistId,
    }),
  }
}
