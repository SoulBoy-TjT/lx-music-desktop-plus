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
  mapTxAlbumPage,
  mapTxAlbumTrackPage,
  mapTxArtistSearchResponse,
  normalizeTxArtistName,
  type TxMappedPage,
} from './artistDiscographyMapper'

const ARTIST_SEARCH_LIMIT = 10
const ALBUM_PAGE_SIZE = 100
const ALBUM_TRACK_PAGE_SIZE = 100
const MAX_REQUEST_ATTEMPTS = 3
const MAX_PAGES = 1000
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

interface HttpResponse {
  statusCode: number
  body: unknown
}

interface HttpRequestObject {
  promise: Promise<HttpResponse>
  cancelHttp?: () => void
}

interface TxRequestOptions {
  method?: 'get' | 'post'
  headers?: Record<string, string>
  body?: Record<string, unknown>
  json?: boolean
}

interface TxMusicuRequest {
  module: string
  method: string
  param: Record<string, unknown>
}

interface PaginationOptions<T> {
  stage: DiscographyIssueStage
  artistId?: string
  albumId?: string
  limit: number
  signal?: AbortSignal
  fetchPage: (begin: number) => Promise<unknown>
  mapPage: (raw: unknown) => TxMappedPage<T>
  getItemId: (item: T) => string
  duplicateCode: 'duplicate_album' | 'duplicate_track'
}

class TxRequestError extends Error {
  readonly statusCode: number | null
  readonly retryable: boolean

  constructor(message: string, statusCode: number | null, retryable: boolean) {
    super(message)
    this.name = 'TxRequestError'
    this.statusCode = statusCode
    this.retryable = retryable
  }
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

const requestJsonOnce = async(
  url: string,
  signal?: AbortSignal,
  options: TxRequestOptions = {},
): Promise<unknown> => {
  throwIfAborted(signal)
  const request = httpFetch(url, {
    method: options.method ?? 'get',
    headers: options.headers,
    body: options.body,
    json: options.json,
    timeout: 15000,
  }) as unknown as HttpRequestObject
  const onAbort = () => request.cancelHttp?.()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await request.promise
    throwIfAborted(signal)
    if (response.statusCode != 200) {
      throw new TxRequestError(
        'QQ Music request failed.',
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
  options?: TxRequestOptions,
): Promise<unknown> => {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    throwIfAborted(signal)
    try {
      return await requestJsonOnce(url, signal, options)
    } catch (error) {
      if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
      const retryable = !(error instanceof TxRequestError) || error.retryable
      if (!retryable || attempt == MAX_REQUEST_ATTEMPTS) throw error
    }
  }
  throw new Error('Unreachable retry state.')
}

const createMusicuBody = (request: TxMusicuRequest): Record<string, unknown> => ({
  comm: {
    cv: 4747474,
    ct: 24,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    uin: 0,
  },
  req: request,
})

const requestMusicu = async(
  request: TxMusicuRequest,
  signal?: AbortSignal,
): Promise<unknown> => await requestJson(MUSICU_URL, signal, {
  method: 'post',
  json: true,
  headers: { 'User-Agent': USER_AGENT },
  body: createMusicuBody(request),
})

const paginationFailureIssue = (
  stage: DiscographyIssueStage,
  artistId?: string,
  albumId?: string,
) => createIssue(
  'provider_unavailable',
  stage,
  'QQ Music is temporarily unavailable while collecting the catalog.',
  { artistId, albumId, retryable: true },
)

const collectTxPaginated = async<T>(
  options: PaginationOptions<T>,
): Promise<CatalogCollection<T>> => {
  const items: T[] = []
  const issues: DiscographyIssue[] = []
  const seenItemIds = new Set<string>()
  const seenPageSignatures = new Set<string>()
  let reportedTotal: number | null = null
  let rawProgress = 0
  let complete = true
  let stopped = false

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    throwIfAborted(options.signal)
    let mappedPage: TxMappedPage<T>
    try {
      mappedPage = options.mapPage(await options.fetchPage(rawProgress))
      throwIfAborted(options.signal)
    } catch (error) {
      if (options.signal?.aborted == true || isAbortError(error)) throw createAbortError()
      complete = false
      issues.push(paginationFailureIssue(options.stage, options.artistId, options.albumId))
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
          'QQ Music changed the reported total while paging the catalog.',
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
        'QQ Music returned the same catalog page more than once.',
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
          'QQ Music returned the same stable ID more than once while paging.',
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
          'QQ Music returned an empty page before the reported total was reached.',
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

    if (reportedTotal != null && rawProgress >= reportedTotal) {
      if (rawProgress > reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          options.stage,
          'QQ Music returned more raw items than its reported total.',
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

    if (reportedTotal == null && mappedPage.rawItemCount < options.limit) {
      stopped = true
      break
    }
  }

  if (!stopped) {
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      options.stage,
      'QQ Music pagination exceeded the safety limit.',
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
        'QQ Music reported total does not match the unique collected item count.',
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

export const createTxArtistCatalogAdapter = (): ArtistCatalogPort => {
  const artistNames = new Map<string, string>()

  return {
    async resolveArtist(rawRef, signal) {
      const input = rawRef.trim()
      if (
        !input ||
        input.length > 120 ||
        Array.from(input).some(char => char.charCodeAt(0) < 32) ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
      ) {
        throw new DiscographyError(createIssue(
          'invalid_artist_ref',
          'input',
          'Enter a QQ Music artist name.',
        ))
      }

      let raw: unknown
      try {
        raw = await requestJson(
          `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=${ARTIST_SEARCH_LIMIT}&w=${encodeURIComponent(input)}&t=9`,
          signal,
          { headers: { 'User-Agent': USER_AGENT } },
        )
      } catch (error) {
        if (signal?.aborted == true || isAbortError(error)) throw createAbortError()
        throw new DiscographyError(createIssue(
          'provider_unavailable',
          'artist',
          'QQ Music is temporarily unavailable while searching for the artist.',
          { retryable: true },
        ))
      }

      const result = mapTxArtistSearchResponse(raw)
      if (result.kind == 'invalid') {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'QQ Music returned an invalid artist search response.',
          { retryable: true },
        ))
      }
      const normalizedName = normalizeTxArtistName(input)
      const artist = result.artists.find(item => normalizeTxArtistName(item.name) == normalizedName)
      if (!artist) {
        throw new DiscographyError(createIssue(
          'artist_not_found',
          'artist',
          'QQ Music did not return an exact artist-name match.',
        ))
      }
      artistNames.set(artist.id, artist.name)
      return artist
    },

    async getArtistAlbums(artistId, signal) {
      return await collectTxPaginated<AlbumRef>({
        stage: 'albums',
        artistId,
        limit: ALBUM_PAGE_SIZE,
        signal,
        fetchPage: async begin => await requestMusicu({
          module: 'music.musichallAlbum.AlbumListServer',
          method: 'GetAlbumList',
          param: {
            singerMid: artistId,
            order: 0,
            begin,
            num: ALBUM_PAGE_SIZE,
            songNumTag: 1,
            singerID: 0,
          },
        }, signal),
        mapPage: raw => mapTxAlbumPage(raw, artistId, artistNames.get(artistId) ?? ''),
        getItemId: album => album.id,
        duplicateCode: 'duplicate_album',
      })
    },

    async getAlbumTracks(albumId, signal) {
      return await collectTxPaginated<LX.Music.MusicInfoOnline>({
        stage: 'album_tracks',
        albumId,
        limit: ALBUM_TRACK_PAGE_SIZE,
        signal,
        fetchPage: async begin => await requestMusicu({
          module: 'music.musichallAlbum.AlbumSongList',
          method: 'GetAlbumSongList',
          param: {
            albumMid: albumId,
            begin,
            num: ALBUM_TRACK_PAGE_SIZE,
            order: 2,
          },
        }, signal),
        mapPage: raw => mapTxAlbumTrackPage(raw, albumId),
        getItemId: track => track.id,
        duplicateCode: 'duplicate_track',
      })
    },
  }
}

export default createTxArtistCatalogAdapter
