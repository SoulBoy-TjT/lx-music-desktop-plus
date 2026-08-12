import type {
  AlbumRef,
  ArtistCatalogPort,
  DiscographyIssue,
  DiscographyIssueStage,
} from '@renderer/core/artistDiscography/types'
import { DiscographyError } from '@renderer/core/artistDiscography/types'
import { httpFetch } from '../../request'
import { filterMusicInfoList } from './musicInfo'
import {
  mapKgAlbumPage,
  mapKgArtistResponse,
  mapKgArtistSearchResponse,
  mapKgExpandedTracks,
  mapKgRawAlbumTrackPage,
  normalizeKgArtistName,
  parseKgArtistReference,
  type KgRawAlbumTrack,
} from './artistDiscographyMapper'
import { collectKgPaginated } from './artistDiscographyPagination'
import { executeKgWithRetry } from './artistDiscographyRetry'

const ALBUM_PAGE_SIZE = 100
const ALBUM_TRACK_PAGE_SIZE = 100
const MAX_REQUEST_ATTEMPTS = 3
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'

interface HttpResponse {
  statusCode: number
  body: unknown
}

interface HttpRequestObject {
  promise: Promise<HttpResponse>
  cancelHttp?: () => void
}

interface KgRequestOptions {
  method?: 'get' | 'post'
  headers?: Record<string, string>
  body?: Record<string, unknown>
  json?: boolean
}

class KgRequestError extends Error {
  readonly statusCode: number | null
  readonly retryable: boolean

  constructor(message: string, statusCode: number | null, retryable: boolean) {
    super(message)
    this.name = 'KgRequestError'
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

class KgInvalidResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KgInvalidResponseError'
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

const isSignalAborted = (signal?: AbortSignal) => signal?.aborted == true

const isAbortError = (error: unknown) => {
  return error instanceof Error && error.name == 'AbortError'
}

const requestJsonOnce = async(
  url: string,
  signal?: AbortSignal,
  options: KgRequestOptions = {},
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
      throw new KgRequestError(
        'KuGou request failed.',
        response.statusCode,
        response.statusCode == 429 || response.statusCode >= 500,
      )
    }
    return response.body
  } catch (error) {
    if (isSignalAborted(signal) || isAbortError(error)) throw createAbortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

const requestJson = async(
  url: string,
  signal?: AbortSignal,
  options?: KgRequestOptions,
): Promise<unknown> => {
  return executeKgWithRetry({
    maxAttempts: MAX_REQUEST_ATTEMPTS,
    signal,
    execute: async() => await requestJsonOnce(url, signal, options),
    shouldRetry: error => !(error instanceof KgRequestError) || error.retryable,
  })
}

const providerFailureIssue = (
  stage: DiscographyIssueStage,
  artistId?: string,
  albumId?: string,
) => createIssue(
  'provider_unavailable',
  stage,
  'KuGou is temporarily unavailable while collecting the catalog.',
  { artistId, albumId, retryable: true },
)

const normalizePaginationError = (
  error: unknown,
  stage: DiscographyIssueStage,
  artistId?: string,
  albumId?: string,
) => error instanceof KgInvalidResponseError
  ? createIssue(
    'invalid_provider_response',
    stage,
    'KuGou returned an invalid catalog response.',
    { artistId, albumId, retryable: true },
  )
  : providerFailureIssue(stage, artistId, albumId)

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const expandAlbumTracks = async(
  tracks: KgRawAlbumTrack[],
  signal?: AbortSignal,
): Promise<unknown> => {
  throwIfAborted(signal)
  const body = await requestJson(
    'https://gateway.kugou.com/v3/album_audio/audio',
    signal,
    {
      method: 'post',
      json: true,
      body: {
        data: tracks.map(item => ({
          hash: item.raw.hash,
          album_audio_id: item.albumAudioId,
        })),
        area_code: '1',
        show_privilege: 1,
        show_album_info: '1',
        is_publish: '',
        appid: 1005,
        clientver: 11451,
        mid: '1',
        dfid: '-',
        clienttime: Date.now(),
        key: 'OIlwieks28dk2k092lksi2UIkp',
        fields: 'album_info,author_name,audio_info,ori_audio_name,base,songname,classification',
      },
      headers: {
        'KG-THash': '13a3164',
        'KG-RC': '1',
        'KG-Fake': '0',
        'KG-RF': '00869891',
        'User-Agent': 'Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi',
        'x-router': 'kmr.service.kugou.com',
      },
    },
  )
  throwIfAborted(signal)
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new KgInvalidResponseError('KuGou returned an invalid expanded track response.')
  }
  const expandedTracks: unknown[] = []
  for (const item of body.data) {
    const rawTrack = Array.isArray(item) ? item[0] : null
    if (!isRecord(rawTrack)) continue
    try {
      const [track] = filterMusicInfoList([rawTrack])
      if (track) expandedTracks.push(track)
    } catch {
      // Keep valid album tracks and let the caller report the missing expansion.
    }
  }
  return expandedTracks
}

export const createKgArtistCatalogAdapter = (): ArtistCatalogPort => {
  const artistNames = new Map<string, string>()

  return {
    async resolveArtist(rawRef, signal) {
      const input = rawRef.trim()
      if (!input || input.length > 120 || Array.from(input).some(char => char.charCodeAt(0) < 32)) {
        throw new DiscographyError(createIssue(
          'invalid_artist_ref',
          'input',
          'Enter a KuGou artist name.',
        ))
      }

      const isDirectReference = /^\d{1,20}$/.test(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
      let reference = isDirectReference ? parseKgArtistReference(input) : null
      let requestedArtistName: string | null = null

      if (isDirectReference && !reference) {
        throw new DiscographyError(createIssue(
          'invalid_artist_ref',
          'input',
          'Enter a KuGou artist name, numeric ID, or official artist link.',
        ))
      }

      if (!reference) {
        requestedArtistName = input
        let searchRaw: unknown
        try {
          searchRaw = await requestJson(
            `https://mobiles.kugou.com/api/v3/search/singer?format=json&keyword=${encodeURIComponent(input)}&page=1&pagesize=10`,
            signal,
          )
        } catch (error) {
          if (isSignalAborted(signal) || isAbortError(error)) throw createAbortError()
          throw new DiscographyError(createIssue(
            'provider_unavailable',
            'artist',
            'KuGou is temporarily unavailable while searching for the artist.',
            { retryable: true },
          ))
        }

        const searchResult = mapKgArtistSearchResponse(searchRaw)
        if (searchResult.kind == 'invalid') {
          throw new DiscographyError(createIssue(
            'invalid_provider_response',
            'artist',
            'KuGou returned an invalid artist search response.',
            { retryable: true },
          ))
        }
        const normalizedName = normalizeKgArtistName(input)
        const matchedArtist = searchResult.artists.find(artist => normalizeKgArtistName(artist.name) == normalizedName)
        if (matchedArtist) {
          reference = { kind: 'numeric', value: matchedArtist.id }
        } else {
          const legacyToken = /^(?=[a-z0-9]{8,64}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i.test(input)
            ? parseKgArtistReference(input)
            : null
          if (legacyToken?.kind == 'token') {
            reference = legacyToken
            requestedArtistName = null
          } else {
            throw new DiscographyError(createIssue(
              'artist_not_found',
              'artist',
              'KuGou did not return an exact artist-name match.',
            ))
          }
        }
      }

      if (!reference) {
        throw new DiscographyError(createIssue('invalid_artist_ref', 'input', 'Enter a KuGou artist name.'))
      }

      let raw: unknown
      try {
        raw = reference.kind == 'token'
          ? await requestJson(
            `https://m.kugou.com/singer/info/${encodeURIComponent(reference.value)}/?json=true`,
            signal,
            { headers: { 'User-Agent': MOBILE_USER_AGENT } },
          )
          : await requestJson(
            `https://mobiles.kugou.com/api/v5/singer/info?singerid=${encodeURIComponent(reference.value)}`,
            signal,
          )
      } catch (error) {
        if (isSignalAborted(signal) || isAbortError(error)) throw createAbortError()
        if (reference.kind == 'token' && error instanceof KgRequestError && error.statusCode == 404) {
          throw new DiscographyError(createIssue(
            'invalid_artist_ref',
            'input',
            'The KuGou artist link or token is invalid.',
          ))
        }
        throw new DiscographyError(createIssue(
          'provider_unavailable',
          'artist',
          'KuGou is temporarily unavailable while resolving the artist.',
          { retryable: true },
        ))
      }

      const mappedArtist = mapKgArtistResponse(raw)
      if (mappedArtist.kind == 'not_found') {
        throw new DiscographyError(createIssue(
          reference.kind == 'token' ? 'invalid_artist_ref' : 'artist_not_found',
          reference.kind == 'token' ? 'input' : 'artist',
          reference.kind == 'token'
            ? 'The KuGou artist link or token is invalid.'
            : 'The KuGou artist ID does not exist.',
        ))
      }
      if (mappedArtist.kind == 'invalid') {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'KuGou returned an invalid artist response.',
          { artistId: reference.value, retryable: true },
        ))
      }
      const artist = mappedArtist.artist
      if (reference.kind == 'numeric' && artist.id != reference.value) {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'KuGou resolved a different artist ID than requested.',
          { artistId: reference.value, retryable: true },
        ))
      }
      if (requestedArtistName && normalizeKgArtistName(artist.name) != normalizeKgArtistName(requestedArtistName)) {
        throw new DiscographyError(createIssue(
          'invalid_provider_response',
          'artist',
          'KuGou resolved a different artist name than requested.',
          { artistId: reference.value, retryable: true },
        ))
      }
      artistNames.set(artist.id, artist.name)
      return artist
    },

    async getArtistAlbums(artistId, signal) {
      return collectKgPaginated<AlbumRef>({
        stage: 'albums',
        artistId,
        limit: ALBUM_PAGE_SIZE,
        signal,
        fetchPage: async page => await requestJson(
          `https://mobiles.kugou.com/api/v5/singer/album?singerid=${encodeURIComponent(artistId)}&page=${page}&pagesize=${ALBUM_PAGE_SIZE}`,
          signal,
        ),
        mapPage: raw => mapKgAlbumPage(raw, artistId, artistNames.get(artistId) ?? ''),
        getItemId: album => album.id,
        duplicateCode: 'duplicate_album',
        normalizePageError: error => normalizePaginationError(error, 'albums', artistId),
      })
    },

    async getAlbumTracks(albumId, signal) {
      return collectKgPaginated<LX.Music.MusicInfoOnline>({
        stage: 'album_tracks',
        albumId,
        limit: ALBUM_TRACK_PAGE_SIZE,
        signal,
        fetchPage: async page => await requestJson(
          `https://mobiles.kugou.com/api/v3/album/song?version=9108&albumid=${encodeURIComponent(albumId)}&plat=0&pagesize=${ALBUM_TRACK_PAGE_SIZE}&area_code=0&page=${page}&with_res_tag=0`,
          signal,
        ),
        mapPage: async raw => {
          const rawPage = mapKgRawAlbumTrackPage(raw, albumId)
          if (!rawPage.validResponse || !rawPage.items.length) {
            return { ...rawPage, items: [] }
          }
          throwIfAborted(signal)
          const expandedRaw = await expandAlbumTracks(rawPage.items, signal)
          throwIfAborted(signal)
          const expanded = mapKgExpandedTracks(expandedRaw, albumId)
          const issues = [...rawPage.issues, ...expanded.issues]
          const expectedTrackIds = new Set(rawPage.items.map(item => item.key))
          const items = expanded.items.filter(track => {
            if (expectedTrackIds.has(track.id)) return true
            issues.push(createIssue(
              'invalid_provider_response',
              'album_tracks',
              'KuGou expanded an unexpected album detail track.',
              { albumId, trackId: track.id, retryable: true },
            ))
            return false
          })
          if (items.length != rawPage.items.length) {
            issues.push(createIssue(
              'invalid_provider_response',
              'album_tracks',
              'KuGou did not expand every album detail track.',
              {
                albumId,
                expected: rawPage.items.length,
                actual: items.length,
                retryable: true,
              },
            ))
          }
          return {
            ...rawPage,
            items,
            issues,
          }
        },
        getItemId: track => track.id,
        duplicateCode: 'duplicate_track',
        normalizePageError: error => normalizePaginationError(error, 'album_tracks', undefined, albumId),
      })
    },
  }
}

export default createKgArtistCatalogAdapter
