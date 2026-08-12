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
  mapKwAlbumPage,
  mapKwAlbumTrackPage,
  mapKwArtistSearchResponse,
  normalizeKwArtistName,
  type KwMappedPage,
  type KwTrackNumbering,
} from './artistDiscographyMapper'

const ARTIST_SEARCH_LIMIT = 10
const ALBUM_PAGE_SIZE = 100
const ALBUM_TRACK_PAGE_SIZE = 100
const MAX_REQUEST_ATTEMPTS = 3
const MAX_PAGES = 1000

interface HttpResponse {
  statusCode: number
  body: unknown
}

interface HttpRequestObject {
  promise: Promise<HttpResponse>
  cancelHttp?: () => void
}

class KwRequestError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'KwRequestError'
    this.retryable = retryable
  }
}

interface KwPaginationOptions<T> {
  stage: DiscographyIssueStage
  artistId?: string
  albumId?: string
  limit: number
  signal?: AbortSignal
  fetchPage: (page: number) => Promise<unknown>
  mapPage: (raw: unknown, page: number, rawOffset: number) => KwMappedPage<T>
  getItemId: (item: T) => string
  duplicateCode: 'duplicate_album' | 'duplicate_track'
}

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssueStage,
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity'>> & {
    severity?: DiscographyIssue['severity']
  } = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: details.severity ?? 'error',
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

const isAbortError = (error: unknown) => {
  return error instanceof Error && error.name == 'AbortError'
}

const executeWithRetry = async<T>(
  execute: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    try {
      const result = await execute()
      throwIfAborted(signal)
      return result
    } catch (error) {
      if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
      const retryable = !(error instanceof KwRequestError) || error.retryable
      if (!retryable || attempt == MAX_REQUEST_ATTEMPTS) throw error
    }
  }
  throw new Error('Unreachable retry state.')
}

const requestRawOnce = async(url: string, signal?: AbortSignal): Promise<unknown> => {
  throwIfAborted(signal)
  const request = httpFetch(url, {
    method: 'get',
    timeout: 15000,
  }) as unknown as HttpRequestObject
  const onAbort = () => request.cancelHttp?.()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await request.promise
    throwIfAborted(signal)
    if (response.statusCode != 200) {
      throw new KwRequestError(
        'Kuwo request failed.',
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

const requestRaw = async(url: string, signal?: AbortSignal): Promise<unknown> => {
  return await executeWithRetry(async() => await requestRawOnce(url, signal), signal)
}

const providerFailureIssue = (
  stage: DiscographyIssueStage,
  error: unknown,
  artistId?: string,
  albumId?: string,
) => createIssue(
  'provider_unavailable',
  stage,
  'Kuwo is temporarily unavailable while collecting the catalog.',
  {
    artistId,
    albumId,
    retryable: !(error instanceof KwRequestError) || error.retryable,
  },
)

const collectPaginated = async<T>(
  options: KwPaginationOptions<T>,
): Promise<CatalogCollection<T>> => {
  const items: T[] = []
  const issues: DiscographyIssue[] = []
  const seenItemIds = new Set<string>()
  const seenPageSignatures = new Set<string>()
  let reportedTotal: number | null = null
  let rawProgress = 0
  let complete = true
  let stopped = false

  for (let page = 0; page < MAX_PAGES; page++) {
    throwIfAborted(options.signal)
    let mappedPage: KwMappedPage<T>
    try {
      mappedPage = options.mapPage(await options.fetchPage(page), page, rawProgress)
      throwIfAborted(options.signal)
    } catch (error) {
      if (options.signal?.aborted == true || isAbortError(error)) throw createAbortError()
      complete = false
      issues.push(providerFailureIssue(
        options.stage,
        error,
        options.artistId,
        options.albumId,
      ))
      stopped = true
      break
    }

    issues.push(...mappedPage.issues)
    if (mappedPage.issues.some(issue => issue.severity == 'error')) complete = false
    if (!mappedPage.validResponse) {
      complete = false
      stopped = true
      break
    }

    if (mappedPage.reportedTotal != null) {
      if (reportedTotal == null) reportedTotal = mappedPage.reportedTotal
      else if (reportedTotal != mappedPage.reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          options.stage,
          'Kuwo changed the reported total while paging the catalog.',
          {
            artistId: options.artistId,
            albumId: options.albumId,
            expected: reportedTotal,
            actual: mappedPage.reportedTotal,
            retryable: true,
          },
        ))
      }
    }

    const pageSignature = `${mappedPage.rawItemCount}:${mappedPage.pageKeys.join('|')}`
    if (mappedPage.rawItemCount > 0 && seenPageSignatures.has(pageSignature)) {
      complete = false
      issues.push(createIssue(
        'pagination_inconsistent',
        options.stage,
        'Kuwo returned the same catalog page more than once.',
        { artistId: options.artistId, albumId: options.albumId, retryable: true },
      ))
      stopped = true
      break
    }
    if (mappedPage.rawItemCount > 0) seenPageSignatures.add(pageSignature)

    rawProgress += mappedPage.rawItemCount
    for (const item of mappedPage.items) {
      const itemId = options.getItemId(item)
      if (seenItemIds.has(itemId)) {
        complete = false
        issues.push(createIssue(
          options.duplicateCode,
          options.stage,
          'Kuwo returned the same stable ID more than once while paging.',
          {
            artistId: options.artistId,
            albumId: options.albumId ?? (options.duplicateCode == 'duplicate_album' ? itemId : undefined),
            trackId: options.duplicateCode == 'duplicate_track' ? itemId : undefined,
          },
        ))
        continue
      }
      seenItemIds.add(itemId)
      items.push(item)
    }

    if (mappedPage.rawItemCount == 0) {
      if (reportedTotal != null && rawProgress < reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          options.stage,
          'Kuwo returned an empty page before the reported total was reached.',
          {
            artistId: options.artistId,
            albumId: options.albumId,
            expected: reportedTotal,
            actual: rawProgress,
            retryable: true,
          },
        ))
      }
      stopped = true
      break
    }

    if (reportedTotal != null) {
      if (rawProgress >= reportedTotal) {
        if (rawProgress > reportedTotal) {
          complete = false
          issues.push(createIssue(
            'pagination_inconsistent',
            options.stage,
            'Kuwo returned more raw items than its reported total.',
            {
              artistId: options.artistId,
              albumId: options.albumId,
              expected: reportedTotal,
              actual: rawProgress,
              retryable: true,
            },
          ))
        }
        stopped = true
        break
      }
      continue
    }

    if (mappedPage.rawItemCount < options.limit) {
      stopped = true
      break
    }
  }

  if (!stopped) {
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      options.stage,
      'Kuwo pagination exceeded the safety limit.',
      { artistId: options.artistId, albumId: options.albumId, retryable: true },
    ))
  }
  if (reportedTotal != null && items.length != reportedTotal) {
    complete = false
    if (!issues.some(issue =>
      issue.code == 'pagination_inconsistent' &&
      issue.expected == reportedTotal &&
      issue.actual == items.length,
    )) {
      issues.push(createIssue(
        'pagination_inconsistent',
        options.stage,
        'Kuwo reported total does not match the unique collected item count.',
        {
          artistId: options.artistId,
          albumId: options.albumId,
          expected: reportedTotal,
          actual: items.length,
          retryable: true,
        },
      ))
    }
  }

  return { items, reportedTotal, complete, issues }
}

const validateArtistNameInput = (rawName: string): string => {
  const name = rawName.trim()
  if (
    !name ||
    name.length > 120 ||
    Array.from(name).some(char => char.charCodeAt(0) < 32) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(name)
  ) {
    throw new DiscographyError(createIssue(
      'invalid_artist_ref',
      'input',
      'Enter a Kuwo artist name.',
    ))
  }
  return name
}

export const createKwArtistCatalogAdapter = (): ArtistCatalogPort => ({
  async resolveArtist(rawName, signal) {
    const artistName = validateArtistNameInput(rawName)
    let raw: unknown
    try {
      raw = await requestRaw(
        `https://search.kuwo.cn/r.s?all=${encodeURIComponent(artistName)}&ft=artist&itemset=web_2013&client=kt&pn=0&rn=${ARTIST_SEARCH_LIMIT}&rformat=json&encoding=utf8`,
        signal,
      )
    } catch (error) {
      if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
      throw new DiscographyError(providerFailureIssue('artist', error))
    }

    const mapped = mapKwArtistSearchResponse(raw)
    if (mapped.kind == 'invalid') {
      throw new DiscographyError(createIssue(
        'invalid_provider_response',
        'artist',
        'Kuwo returned an invalid artist search response.',
        { retryable: true },
      ))
    }
    const normalizedName = normalizeKwArtistName(artistName)
    const artist = mapped.artists.find(candidate => normalizeKwArtistName(candidate.name) == normalizedName)
    if (!artist) {
      throw new DiscographyError(createIssue(
        'artist_not_found',
        'artist',
        'Kuwo did not return an exact artist-name match.',
      ))
    }
    return artist
  },

  async getArtistAlbums(artistId, signal) {
    return await collectPaginated<AlbumRef>({
      stage: 'albums',
      artistId,
      limit: ALBUM_PAGE_SIZE,
      signal,
      fetchPage: async page => await requestRaw(
        `https://search.kuwo.cn/r.s?stype=albumlist&artistid=${encodeURIComponent(artistId)}&pn=${page}&rn=${ALBUM_PAGE_SIZE}&show_copyright_off=0&encoding=utf8&rformat=json&vipver=MUSIC_9.1.0`,
        signal,
      ),
      mapPage: (raw, page) => mapKwAlbumPage(raw, artistId, page),
      getItemId: album => album.id,
      duplicateCode: 'duplicate_album',
    })
  },

  async getAlbumTracks(albumId, signal) {
    let trackNumbering: Exclude<KwTrackNumbering, 'invalid'> | null = null
    let zeroBasedSequenceInvalid = false
    let rawTrackCount = 0
    const collection = await collectPaginated<LX.Music.MusicInfoOnline>({
      stage: 'album_tracks',
      albumId,
      limit: ALBUM_TRACK_PAGE_SIZE,
      signal,
      fetchPage: async page => await requestRaw(
        `https://search.kuwo.cn/r.s?pn=${page}&rn=${ALBUM_TRACK_PAGE_SIZE}&stype=albuminfo&albumid=${encodeURIComponent(albumId)}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`,
        signal,
      ),
      mapPage: (raw, _page, rawOffset) => {
        const mapped = mapKwAlbumTrackPage(raw, albumId, rawOffset, trackNumbering)
        rawTrackCount = rawOffset + mapped.rawItemCount
        if (mapped.trackNumbering == 'invalid') {
          zeroBasedSequenceInvalid = true
          trackNumbering ??= 'zero_based'
        } else if (trackNumbering == null && mapped.trackNumbering != null) {
          trackNumbering = mapped.trackNumbering
        }
        return mapped
      },
      getItemId: track => track.id,
      duplicateCode: 'duplicate_track',
    })
    if (
      trackNumbering == 'zero_based' &&
      (zeroBasedSequenceInvalid || collection.reportedTotal != rawTrackCount)
    ) {
      return { ...collection, items: [], complete: false }
    }
    return collection
  },
})

export default createKwArtistCatalogAdapter
