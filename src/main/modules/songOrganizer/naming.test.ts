import { describe, expect, it } from 'vitest'
import { buildAlbumDirectoryName, buildArtistDirectoryName, stripAlbumCountSuffix, stripArtistCountSuffix } from './naming'

describe('song organizer naming', () => {
  it('uses Easy Music count suffixes idempotently', () => {
    expect(buildArtistDirectoryName('歌手（12首）', 3)).toBe('歌手（3首）')
    expect(buildArtistDirectoryName('歌手', 0)).toBe('歌手（0首）')
    expect(buildAlbumDirectoryName('专辑 (12首)', 3)).toBe('专辑 (3首)')
    expect(buildAlbumDirectoryName('专辑', 0)).toBe('专辑 (0首)')
  })

  it('only strips a strict suffix at the end', () => {
    expect(stripArtistCountSuffix('歌手（2首）特别版')).toBe('歌手（2首）特别版')
    expect(stripAlbumCountSuffix('专辑(2首)')).toBe('专辑(2首)')
  })
})
