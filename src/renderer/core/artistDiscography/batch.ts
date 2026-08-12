import { prepareArtistDiscographyApply } from './apply'
import { createArtistDiscographyModule } from './module'
import type {
  ArtistDiscographyBatchModule,
  ArtistDiscographyBatchModuleOptions,
  ArtistDiscographySource,
  ArtistRef,
  DiscographyBatchApplyResult,
  DiscographyIssue,
  DiscographyPlan,
} from './types'

export const ARTIST_DISCOGRAPHY_SOURCES = ['kg', 'tx', 'wy', 'kw'] as const satisfies readonly ArtistDiscographySource[]

export const ARTIST_DISCOGRAPHY_PLAYLIST_SUFFIXES: Readonly<Record<ArtistDiscographySource, string>> = {
  kg: '酷狗',
  tx: 'qq',
  wy: '网易',
  kw: '酷我',
}

export const createArtistDiscographyPlaylistName = (
  artistName: string,
  source: ArtistDiscographySource,
  trackCount: number,
): string => `${artistName.trim()}-${ARTIST_DISCOGRAPHY_PLAYLIST_SUFFIXES[source]}-${trackCount}首`

export const createArtistDiscographyPlaylistNames = (
  artistName: string,
  trackCounts: Readonly<Record<ArtistDiscographySource, number>>,
): Record<ArtistDiscographySource, string> => {
  const name = artistName.trim()
  return {
    kg: createArtistDiscographyPlaylistName(name, 'kg', trackCounts.kg),
    tx: createArtistDiscographyPlaylistName(name, 'tx', trackCounts.tx),
    wy: createArtistDiscographyPlaylistName(name, 'wy', trackCounts.wy),
    kw: createArtistDiscographyPlaylistName(name, 'kw', trackCounts.kw),
  }
}

const normalizeSources = (sources: readonly ArtistDiscographySource[]) => {
  const requestedSources = new Set(sources)
  return ARTIST_DISCOGRAPHY_SOURCES.filter(source => requestedSources.has(source))
}

const isSameSourceOrder = (
  left: readonly ArtistDiscographySource[],
  right: readonly ArtistDiscographySource[],
) => left.length == right.length && left.every((source, index) => source == right[index])

const hasValidPlanShape = (plan: {
  sources: readonly ArtistDiscographySource[]
  plans: Partial<Record<ArtistDiscographySource, DiscographyPlan>>
}) => {
  const sources = normalizeSources(plan.sources)
  if (!sources.length || !isSameSourceOrder(plan.sources, sources)) return false
  const sourceSet = new Set<ArtistDiscographySource>(sources)
  const planSources = Object.keys(plan.plans) as ArtistDiscographySource[]
  return planSources.length == sources.length &&
    planSources.every(source => sourceSet.has(source)) &&
    sources.every(source => plan.plans[source]?.source == source)
}

const createIssue = (
  code: DiscographyIssue['code'],
  message: string,
  source?: ArtistDiscographySource,
): DiscographyIssue => ({
  code,
  stage: 'apply',
  message,
  severity: 'error',
  source,
  retryable: true,
})

const createFailedPlan = (
  source: ArtistDiscographySource,
  fetchedAt: number,
): DiscographyPlan => ({
  source,
  status: 'failed',
  artist: null,
  expectedAlbumCount: null,
  actualAlbumCount: 0,
  albums: [],
  tracks: [],
  deduplications: [],
  rawTrackCount: 0,
  deduplicatedTrackCount: 0,
  canApply: false,
  fetchedAt,
  issues: [{
    code: 'provider_unavailable',
    stage: 'artist',
    message: 'The music provider could not create a discography plan.',
    severity: 'error',
    source,
    retryable: true,
  }],
})

const getAlbumConcurrency = (value: number | undefined) => {
  if (typeof value != 'number' || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(3, Math.floor(value)))
}

const getBatchStatus = (
  sources: readonly ArtistDiscographySource[],
  plans: Partial<Record<ArtistDiscographySource, DiscographyPlan>>,
): 'ready' | 'blocked' | 'cancelled' => {
  const values = sources.map(source => plans[source]).filter((plan): plan is DiscographyPlan => plan != null)
  if (values.length != sources.length) return 'blocked'
  if (values.some(plan => plan.status == 'failed')) return 'blocked'
  if (values.some(plan => plan.status == 'cancelled')) return 'cancelled'
  return values.every(plan => plan.status == 'complete' || plan.status == 'partial')
    ? 'ready'
    : 'blocked'
}

const canBatchApply = (
  sources: readonly ArtistDiscographySource[],
  plans: Partial<Record<ArtistDiscographySource, DiscographyPlan>>,
) => sources.some(source => plans[source]?.canApply == true)

export const createArtistDiscographyBatchModule = (
  options: ArtistDiscographyBatchModuleOptions,
): ArtistDiscographyBatchModule => {
  const now = options.now ?? Date.now
  let lastBatchTimestamp = -1
  let batchSequence = 0
  let lastIdTimestamp = -1
  let idSequence = 0
  let activeBatchId: string | null = null
  const createBatchId = () => {
    const timestamp = now()
    if (timestamp == lastBatchTimestamp) batchSequence++
    else {
      lastBatchTimestamp = timestamp
      batchSequence = 0
    }
    return `discography_batch_${timestamp}${batchSequence ? `_${batchSequence}` : ''}`
  }
  const createPlaylistId = options.createPlaylistId ?? (() => {
    const timestamp = now()
    if (timestamp == lastIdTimestamp) idSequence++
    else {
      lastIdTimestamp = timestamp
      idSequence = 0
    }
    return `userlist_${timestamp}${idSequence ? `_${idSequence}` : ''}`
  })
  const modules = Object.fromEntries(ARTIST_DISCOGRAPHY_SOURCES.map(source => [
    source,
    createArtistDiscographyModule({
      catalog: options.catalogs[source],
      playlist: options.playlist,
      albumConcurrency: getAlbumConcurrency(options.albumConcurrency),
      now,
      createPlaylistId,
    }),
  ])) as Record<ArtistDiscographySource, ReturnType<typeof createArtistDiscographyModule>>

  return {
    async plan(input) {
      const sources = normalizeSources(input.sources)
      if (!sources.length) throw new Error('At least one music source is required.')
      const batchId = createBatchId()
      activeBatchId = batchId
      const arrived = new Set<ArtistDiscographySource>()
      const waiters = new Map<ArtistDiscographySource, {
        artist: ArtistRef
        resolve: (confirmed: boolean) => void
      }>()
      let confirmationStarted = false
      let coordinationCancelled = input.signal?.aborted == true

      const settleWaiters = (confirmed: boolean) => {
        for (const waiter of waiters.values()) waiter.resolve(confirmed)
        waiters.clear()
      }

      const cancelCoordination = () => {
        coordinationCancelled = true
        confirmationStarted = true
        settleWaiters(false)
      }
      input.signal?.addEventListener('abort', cancelCoordination, { once: true })

      const maybeConfirm = () => {
        if (coordinationCancelled) {
          settleWaiters(false)
          return
        }
        if (confirmationStarted || arrived.size != sources.length) return
        confirmationStarted = true
        const artists = sources
          .map(source => waiters.get(source)?.artist)
          .filter((artist): artist is ArtistRef => artist != null)
        if (!artists.length) {
          settleWaiters(false)
          return
        }
        void Promise.resolve()
          .then(async() => await (input.confirmArtists?.(artists) ?? true))
          .then(
            confirmed => {
              settleWaiters(confirmed && input.signal?.aborted != true)
            },
            () => {
              settleWaiters(false)
            },
          )
      }

      const tasks = sources.map(async source => {
        let reachedArtistConfirmation = false
        try {
          return await modules[source].plan({
            source,
            artistRef: input.artistName,
            signal: input.signal,
            onProgress: progress => input.onProgress?.({ source, progress }),
            confirmArtist: async artist => {
              reachedArtistConfirmation = true
              arrived.add(source)
              if (coordinationCancelled || input.signal?.aborted == true) return false
              return await new Promise<boolean>(resolve => {
                waiters.set(source, { artist, resolve })
                maybeConfirm()
              })
            },
          })
        } catch {
          return createFailedPlan(source, now())
        } finally {
          if (!reachedArtistConfirmation) {
            arrived.add(source)
            maybeConfirm()
          }
        }
      })
      let planned: DiscographyPlan[]
      try {
        planned = await Promise.all(tasks)
      } finally {
        input.signal?.removeEventListener('abort', cancelCoordination)
      }
      const plans = Object.fromEntries(planned.map(plan => [plan.source, plan])) as Partial<
      Record<ArtistDiscographySource, DiscographyPlan>
      >
      const status = getBatchStatus(sources, plans)
      return {
        batchId,
        artistName: input.artistName.trim(),
        sources,
        status,
        plans,
        fetchedAt: Math.max(...sources.map(source => plans[source]!.fetchedAt)),
        canApply: canBatchApply(sources, plans),
      }
    },

    async apply(input) {
      const plannedTrackCounts: DiscographyBatchApplyResult['plannedTrackCounts'] = {}
      const prepared = new Map<ArtistDiscographySource, {
        tracks: LX.Music.MusicInfoOnline[]
      }>()
      const issues: DiscographyIssue[] = []
      const batch = input.plan
      const artistName = batch.artistName.trim()
      const selectedSourceSet = new Set(input.sources)
      const sources = normalizeSources(input.sources)
      const hasValidSelectedSources = sources.length > 0 &&
        sources.length == input.sources.length &&
        selectedSourceSet.size == input.sources.length &&
        sources.every(source => batch.sources.includes(source))
      const validPlanShape = hasValidPlanShape(batch)
      const actualStatus = validPlanShape
        ? getBatchStatus(batch.sources, batch.plans)
        : 'blocked'
      const actualCanApply = validPlanShape && canBatchApply(batch.sources, batch.plans)
      if (
        !batch.batchId.trim() ||
        batch.batchId != activeBatchId ||
        !artistName ||
        !validPlanShape ||
        !hasValidSelectedSources ||
        batch.status != actualStatus ||
        batch.canApply != actualCanApply ||
        !actualCanApply
      ) {
        issues.push(createIssue(
          'invalid_provider_response',
          'The batch plan is stale, blocked, or invalid.',
        ))
      }

      for (const source of sources) {
        const plan = batch.plans[source]
        if (plan?.source != source) {
          issues.push(createIssue('invalid_provider_response', 'The batch contains an invalid source plan.', source))
          continue
        }
        const result = prepareArtistDiscographyApply({
          plan,
          target: { type: 'new', name: artistName },
        })
        plannedTrackCounts[source] = result.tracks.length
        if (result.issues.length) {
          issues.push(...result.issues.map(issue => ({ ...issue, source })))
          continue
        }
        if (!plan.canApply) {
          issues.push(createIssue(
            'invalid_provider_response',
            'The selected source plan cannot be applied.',
            source,
          ))
          continue
        }
        if (plan.deduplicatedTrackCount != result.tracks.length) {
          issues.push(createIssue(
            'invalid_provider_response',
            'The prepared track count does not match the batch plan.',
            source,
          ))
          continue
        }
        prepared.set(source, { tracks: result.tracks })
      }
      if (issues.length || prepared.size != sources.length) {
        return {
          status: 'validation_failed',
          listIds: {},
          residualPlaylists: [],
          plannedTrackCounts,
          failedSource: issues[0]?.source ?? null,
          issues,
        }
      }

      const targets: Array<{
        source: ArtistDiscographySource
        id: string
        name: string
        tracks: LX.Music.MusicInfoOnline[]
      }> = []
      const targetIds = new Set<string>()
      for (const source of sources) {
        const target = prepared.get(source)!
        try {
          const id = createPlaylistId()
          if (typeof id != 'string' || !id.trim() || targetIds.has(id)) throw new Error('invalid playlist ID')
          targetIds.add(id)
          targets.push({
            source,
            id,
            name: createArtistDiscographyPlaylistName(artistName, source, target.tracks.length),
            tracks: target.tracks,
          })
        } catch {
          return {
            status: 'validation_failed',
            listIds: {},
            residualPlaylists: [],
            plannedTrackCounts,
            failedSource: source,
            issues: [createIssue(
              'playlist_create_failed',
              'A local playlist ID could not be created.',
              source,
            )],
          }
        }
      }

      const created: typeof targets = []
      let failedSource: ArtistDiscographySource | null = null
      for (const target of targets) {
        try {
          await options.playlist.create(target.id, target.name)
          created.push(target)
          await options.playlist.add(target.id, target.tracks)
        } catch {
          failedSource = target.source
          issues.push(createIssue(
            created.at(-1)?.source == target.source ? 'playlist_add_failed' : 'playlist_create_failed',
            created.at(-1)?.source == target.source
              ? 'The tracks could not be added to a new playlist.'
              : 'A local playlist could not be created.',
            target.source,
          ))
          break
        }
      }

      if (failedSource) {
        const residualPlaylists: DiscographyBatchApplyResult['residualPlaylists'] = []
        for (const item of [...created].reverse()) {
          try {
            await options.playlist.remove(item.id)
          } catch {
            residualPlaylists.push({ source: item.source, id: item.id, name: item.name })
            issues.push(createIssue(
              'playlist_rollback_failed',
              'A playlist created by the batch could not be removed automatically.',
              item.source,
            ))
          }
        }
        return {
          status: residualPlaylists.length ? 'failed_with_residuals' : 'failed_rolled_back',
          listIds: {},
          residualPlaylists,
          plannedTrackCounts,
          failedSource,
          issues,
        }
      }

      return {
        status: 'applied',
        listIds: Object.fromEntries(created.map(item => [item.source, item.id])),
        residualPlaylists: [],
        plannedTrackCounts,
        failedSource: null,
        issues: [],
      }
    },
  }
}
