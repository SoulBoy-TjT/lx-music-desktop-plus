const ARTIST_SUFFIX = /（\d+首）$/u
const ALBUM_SUFFIX = / \(\d+首\)$/u

export const stripArtistCountSuffix = (name: string): string => name.replace(ARTIST_SUFFIX, '')

export const stripAlbumCountSuffix = (name: string): string => name.replace(ALBUM_SUFFIX, '')

export const buildArtistDirectoryName = (name: string, count: number): string => `${stripArtistCountSuffix(name)}（${count}首）`

export const buildAlbumDirectoryName = (name: string, count: number): string => `${stripAlbumCountSuffix(name)} (${count}首)`
