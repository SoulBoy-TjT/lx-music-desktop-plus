import type {
  AlbumRef,
  ArtistCatalogPort,
  CatalogCollection,
  DiscographyIssue,
  DiscographyIssueStage,
} from '@renderer/core/artistDiscography/types'
import { DiscographyError } from '@renderer/core/artistDiscography/types'
import { httpFetch } from '../../request'
import {
  classifyWyArtistNameMatch,
  mapWyAlbumDetailResponse,
  mapWyAlbumPage,
  mapWyArtistResponse,
  mapWyArtistSearchResponse,
} from './artistDiscographyMapper'

const ARTIST_SEARCH_URL = 'https://music.163.com/api/search/get/web'
const ALBUM_PAGE_SIZE = 50
const MAX_ALBUM_PAGES = 1000
const MAX_REQUEST_ATTEMPTS = 3

interface HttpResponse {
  statusCode: number
  body: unknown
}

interface HttpRequestObject {
  promise: Promise<HttpResponse>
  cancelHttp?: () => void
}

interface WyRequestOptions {
  method?: 'get' | 'post'
  form?: Record<string, string | number | boolean>
}

class WyRequestError extends Error {
  readonly statusCode: number | null
  readonly retryable: boolean

  constructor(message: string, statusCode: number | null, retryable: boolean) {
    super(message)
    this.name = 'WyRequestError'
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssueStage,
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity' | 'source'>> & {
    severity?: DiscographyIssue['severity']
  } = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: details.severity ?? 'error',
  source: 'wy',
  ...details,
})

const createAbortError = () => {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw createAbortError()
}

const isAbortError = (error: unknown) => error instanceof Error && error.name == 'AbortError'

const requestJsonOnce = async(
  url: string,
  signal?: AbortSignal,
  options: WyRequestOptions = {},
): Promise<unknown> => {
  throwIfAborted(signal)
  const request = httpFetch(url, {
    method: options.method ?? 'get',
    form: options.form,
    timeout: 15000,
  }) as unknown as HttpRequestObject
  const onAbort = () => request.cancelHttp?.()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await request.promise
    throwIfAborted(signal)
    if (response.statusCode != 200) {
      throw new WyRequestError(
        'NetEase request failed.',
        response.statusCode,
        response.statusCode == 429 || response.statusCode >= 500,
      )
    }
    return response.body
  } catch (error) {
    if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

const requestJson = async(
  url: string,
  signal?: AbortSignal,
  options?: WyRequestOptions,
): Promise<unknown> => {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    try {
      return await requestJsonOnce(url, signal, options)
    } catch (error) {
      if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
      const retryable = !(error instanceof WyRequestError) || error.retryable
      if (!retryable || attempt == MAX_REQUEST_ATTEMPTS) throw error
    }
  }
  throw new Error('Unreachable retry state.')
}

const providerFailureIssue = (
  stage: DiscographyIssueStage,
  artistId?: string,
  albumId?: string,
) => createIssue(
  'provider_unavailable',
  stage,
  'NetEase is temporarily unavailable while collecting the catalog.',
  { artistId, albumId, retryable: true },
)

const albumProviderFailure = (albumId: string): CatalogCollection<LX.Music.MusicInfoOnline> => ({
  items: [],
  reportedTotal: null,
  complete: false,
  issues: [providerFailureIssue('album_tracks', undefined, albumId)],
})

const normalizePositiveId = (value: string) => /^\d+$/.test(value) && BigInt(value) > 0n

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const normalizeInteger = (value: unknown): number | null => {
  if (typeof value == 'number' && Number.isSafeInteger(value)) return value
  if (typeof value == 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return null
}

const getProviderResponseCode = (raw: unknown) => {
  return isRecord(raw) ? normalizeInteger(raw.code) : null
}

const hasNonSuccessProviderCode = (raw: unknown) => {
  const code = getProviderResponseCode(raw)
  return code != null && code != 200
}

const isAlbumVerificationRequired = (raw: unknown) => {
  return isRecord(raw) &&
    getProviderResponseCode(raw) == -462 &&
    isRecord(raw.data) &&
    normalizeInteger(raw.data.verifyType) == 50
}

const isArtistNameInput = (value: string) => {
  if (!value || value.length > 120) return false
  if (
    /^\d+$/.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^(?:www\.)?music\.163\.com\//i.test(value)
  ) return false
  return !Array.from(value).some(character => character.charCodeAt(0) < 32)
}

const collectArtistAlbums = async(
  artistId: string,
  artistName: string,
  initialReportedTotal: number | null,
  signal?: AbortSignal,
): Promise<CatalogCollection<AlbumRef>> => {
  const items: AlbumRef[] = []
  const issues: DiscographyIssue[] = []
  const seenAlbumIds = new Set<string>()
  const seenPageSignatures = new Set<string>()
  let reportedTotal = initialReportedTotal
  let complete = true
  let stopped = false

  for (let page = 0; page < MAX_ALBUM_PAGES; page++) {
    throwIfAborted(signal)
    const offset = page * ALBUM_PAGE_SIZE
    let raw: unknown
    try {
      raw = await requestJson(
        `https://music.163.com/api/artist/albums/${encodeURIComponent(artistId)}?offset=${offset}&limit=${ALBUM_PAGE_SIZE}&total=true`,
        signal,
      )
    } catch (error) {
      if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
      complete = false
      issues.push(providerFailureIssue('albums', artistId))
      stopped = true
      break
    }

    const mapped = mapWyAlbumPage(raw, artistId, artistName)
    issues.push(...mapped.issues)
    if (mapped.issues.some(issue => issue.severity == 'error')) complete = false
    if (!mapped.validResponse) {
      complete = false
      stopped = true
      break
    }

    if (mapped.reportedTotal != null) {
      if (reportedTotal == null) reportedTotal = mapped.reportedTotal
      else if (reportedTotal != mapped.reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          'albums',
          'NetEase changed the reported album total while paging.',
          {
            artistId,
            expected: reportedTotal,
            actual: mapped.reportedTotal,
            retryable: true,
          },
        ))
      }
    }

    const signature = `${mapped.rawItemCount}:${mapped.pageKeys.join('|')}`
    if (mapped.rawItemCount > 0 && seenPageSignatures.has(signature)) {
      complete = false
      issues.push(createIssue(
        'pagination_inconsistent',
        'albums',
        'NetEase returned the same album page more than once.',
        { artistId, retryable: true },
      ))
      stopped = true
      break
    }
    if (mapped.rawItemCount > 0) seenPageSignatures.add(signature)

    for (const album of mapped.items) {
      if (seenAlbumIds.has(album.id)) {
        complete = false
        issues.push(createIssue(
          'duplicate_album',
          'albums',
          'NetEase returned the same stable album ID more than once.',
          { artistId, albumId: album.id },
        ))
        continue
      }
      seenAlbumIds.add(album.id)
      items.push(album)
    }

    if (!mapped.more) {
      stopped = true
      break
    }
    if (mapped.rawItemCount == 0) {
      complete = false
      issues.push(createIssue(
        'pagination_inconsistent',
        'albums',
        'NetEase returned an empty album page while more results were declared.',
        { artistId, retryable: true },
      ))
      stopped = true
      break
    }
  }

  if (!stopped) {
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      'albums',
      'NetEase album pagination exceeded the safety limit.',
      { artistId, retryable: true },
    ))
  }
  if (reportedTotal != null && reportedTotal != items.length) {
    complete = false
    if (!issues.some(issue =>
      issue.code == 'pagination_inconsistent' &&
      issue.expected == reportedTotal &&
      issue.actual == items.length,
    )) {
      issues.push(createIssue(
        'pagination_inconsistent',
        'albums',
        'NetEase reported album total does not match the unique collected album count.',
        { artistId, expected: reportedTotal, actual: items.length, retryable: true },
      ))
    }
  }

  return { items, reportedTotal, complete, issues }
}

export const createWyArtistCatalogAdapter = (): ArtistCatalogPort => {
  const artistNames = new Map<string, string>()
  const artistAlbumCounts = new Map<string, number | null>()

  return {
    async resolveArtist(rawRef, signal) {
      const input = rawRef.trim()
      if (!isArtistNameInput(input)) {
        throw new DiscographyError(createIssue(
          'invalid_artist_ref',
          'input',
          'Enter a NetEase artist name.',
        ))
      }

      let searchRaw: unknown
      try {
        searchRaw = await requestJson(ARTIST_SEARCH_URL, signal, {
          method: 'post',
          form: {
            s: input,
            name: input,
            type: 100,
            offset: 0,
            total: true,
            limit: 10,
          },
        })
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw createAbortError()
        throw new DiscographyError(providerFailureIssue('artist'))
      }

      const searchResult = mapWyArtistSearchResponse(searchRaw)
      if (searchResult.kind == 'invalid') {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'NetEase returned an invalid artist search response.',
          { retryable: true },
        ))
      }
      const candidate = searchResult.artists.find(artist =>
        classifyWyArtistNameMatch(input, artist.name) != null)
      if (!candidate) {
        throw new DiscographyError(createIssue(
          'artist_not_found',
          'artist',
          'NetEase did not return an exact artist-name or alias match.',
        ))
      }

      let artistRaw: unknown
      try {
        artistRaw = await requestJson(
          `https://music.163.com/api/artist/${encodeURIComponent(candidate.id)}`,
          signal,
        )
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw createAbortError()
        throw new DiscographyError(providerFailureIssue('artist', candidate.id))
      }

      const artistResult = mapWyArtistResponse(artistRaw)
      if (
        artistResult.kind == 'invalid' ||
        artistResult.artist.id != candidate.id ||
        classifyWyArtistNameMatch(input, artistResult.artist.name) == null
      ) {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'NetEase returned a different or invalid canonical artist.',
          { artistId: candidate.id, retryable: true },
        ))
      }

      artistNames.set(artistResult.artist.id, artistResult.artist.name)
      artistAlbumCounts.set(artistResult.artist.id, artistResult.artist.albumCount)
      return artistResult.artist
    },

    async getArtistAlbums(artistId, signal) {
      if (!normalizePositiveId(artistId)) {
        return {
          items: [],
          reportedTotal: null,
          complete: false,
          issues: [createIssue(
            'invalid_artist_ref',
            'albums',
            'A valid NetEase artist ID is required.',
            { artistId },
          )],
        }
      }
      return collectArtistAlbums(
        artistId,
        artistNames.get(artistId) ?? '',
        artistAlbumCounts.get(artistId) ?? null,
        signal,
      )
    },

    async getAlbumTracks(albumId, signal) {
      if (!normalizePositiveId(albumId)) {
        return {
          items: [],
          reportedTotal: null,
          complete: false,
          issues: [createIssue(
            'invalid_provider_response',
            'album_tracks',
            'A valid NetEase album ID is required.',
            { albumId },
          )],
        }
      }

      try {
        let raw = await requestJson(
          `https://music.163.com/api/album/${encodeURIComponent(albumId)}`,
          signal,
        )
        if (isAlbumVerificationRequired(raw)) {
          raw = await requestJson(
            `https://music.163.com/api/v1/album/${encodeURIComponent(albumId)}`,
            signal,
          )
          if (hasNonSuccessProviderCode(raw)) return albumProviderFailure(albumId)
          return mapWyAlbumDetailResponse(raw, albumId, 'v1')
        }
        if (hasNonSuccessProviderCode(raw)) return albumProviderFailure(albumId)
        return mapWyAlbumDetailResponse(raw, albumId)
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw createAbortError()
        return albumProviderFailure(albumId)
      }
    },
  }
}

export default createWyArtistCatalogAdapter
