<template>
  <main class="scroll" :class="$style.main">
    <section :class="$style.panel">
      <div :class="$style.heading">
        <div>
          <h1>{{ $t('tools__discography_title') }}</h1>
        </div>
        <div :class="$style.sourceSelector">
          <span>{{ $t('tools__discography_fetch_sources') }}</span>
          <div :class="$style.sourceBadges">
            <base-checkbox
              v-for="item in sourceConfigs"
              :id="`discography-fetch-${item.source}`"
              :key="item.source"
              :model-value="fetchSourceSelection[item.source]"
              :label="item.label"
              :class="$style.sourceOption"
              :disabled="isPlanning || isApplying"
              @update:model-value="setFetchSourceSelected(item.source, Boolean($event))"
            />
          </div>
        </div>
      </div>

      <form :class="$style.collectForm" @submit.prevent="handlePlan">
        <label :class="$style.fieldLabel" for="discography-artist-name">
          {{ $t('tools__discography_artist_ref') }}
        </label>
        <div :class="$style.inputRow">
          <base-input
            id="discography-artist-name"
            v-model="artistName"
            :class="$style.artistInput"
            :disabled="isPlanning || isApplying"
            :placeholder="$t('tools__discography_artist_ref_placeholder')"
            @submit="handlePlan"
          />
          <base-btn
            type="submit"
            :disabled="!artistName.trim() || selectedFetchSources.length == 0 || isPlanning || isApplying"
          >
            {{ isPlanning ? $t('tools__discography_collecting') : $t('tools__discography_collect') }}
          </base-btn>
          <base-btn v-if="isPlanning" type="button" outline @click="handleCancel">
            {{ $t('tools__discography_cancel') }}
          </base-btn>
        </div>
        <p :class="$style.help">{{ $t('tools__discography_artist_ref_help') }}</p>
        <p v-if="selectedFetchSources.length == 0" :class="$style.selectionError" role="alert">
          {{ $t('tools__discography_fetch_sources_required') }}
        </p>
      </form>

      <div v-if="hasProgress" :class="$style.progressList" role="status" aria-live="polite">
        <p v-for="item in progressSourceConfigs" :key="item.source">
          <strong>{{ item.label }}</strong>
          <span>{{ sourceProgressText(item.source) }}</span>
        </p>
      </div>
      <p v-if="unexpectedMessage" :class="$style.error" role="alert">
        {{ unexpectedMessage }}
      </p>
    </section>

    <template v-if="batchPlan">
      <section v-for="item in sourcePlans" :key="item.source" :class="$style.panel">
        <div :class="$style.previewHeader">
          <div :class="$style.artist">
            <img v-if="item.plan.artist?.avatar" :src="item.plan.artist.avatar ?? ''" alt="">
            <div>
              <h2>{{ item.label }} · {{ item.plan.artist?.name || $t('tools__discography_unknown_artist') }}</h2>
              <p v-if="item.plan.artist">ID: {{ item.plan.artist.id }}</p>
            </div>
          </div>
          <span :class="[$style.planStatus, $style[item.plan.status]]">
            {{ planStatusText(item.plan.status) }}
          </span>
        </div>

        <h3>{{ $t('tools__discography_preview') }}</h3>
        <dl :class="$style.stats">
          <div>
            <dt>{{ $t('tools__discography_declared_albums') }}</dt>
            <dd>{{ formatCount(item.plan.expectedAlbumCount) }}</dd>
          </div>
          <div>
            <dt>{{ $t('tools__discography_collected_albums') }}</dt>
            <dd>{{ item.plan.actualAlbumCount }}</dd>
          </div>
          <div>
            <dt>{{ $t('tools__discography_raw_tracks') }}</dt>
            <dd>{{ item.plan.rawTrackCount }}</dd>
          </div>
          <div>
            <dt>{{ $t('tools__discography_unique_tracks') }}</dt>
            <dd>{{ item.plan.deduplicatedTrackCount }}</dd>
          </div>
        </dl>

        <div v-if="item.preview.issues.length" :class="$style.issueGroup">
          <h3>{{ $t('tools__discography_catalog_issues') }}</h3>
          <ul>
            <li
              v-for="(previewIssue, index) in item.preview.issues"
              :key="`${previewIssue.issue.code}-${String(index)}`"
              :class="previewIssue.issue.severity == 'error' ? $style.issueError : $style.issueWarning"
            >
              {{ issueText(previewIssue.issue, previewIssue.albumName) }}
            </li>
          </ul>
        </div>

        <div v-if="item.preview.deduplications.length" :class="$style.deduplicationGroup">
          <div :class="$style.deduplicationHeading">
            <div>
              <h3>{{ $t('tools__discography_deduplication_title') }}</h3>
              <p>{{ $t('tools__discography_deduplication_help') }}</p>
            </div>
            <span>{{ $t('tools__discography_deduplication_count', {
              count: item.preview.deduplications.length,
            }) }}</span>
          </div>

          <ul :class="$style.deduplicationList">
            <li v-for="audit in item.preview.deduplications" :key="audit.key">
              <div :class="$style.deduplicationItemHeader">
                <div>
                  <span :class="$style.deduplicationType">{{ deduplicationScopeText(audit.scope) }}</span>
                  <strong>{{ audit.name ?? $t(audit.kind == 'track'
                    ? 'tools__discography_unknown_track'
                    : 'tools__discography_unknown_album') }}</strong>
                  <small v-if="audit.singer">{{ audit.singer }}</small>
                </div>
                <base-btn min outline type="button" @click="copyDeduplicationAudit(item.source, audit)">
                  {{ copiedDeduplicationKey == deduplicationKey(item.source, audit)
                    ? $t('tools__discography_deduplication_copied')
                    : $t('tools__discography_deduplication_copy') }}
                </base-btn>
              </div>

              <dl v-if="audit.identifier" :class="$style.deduplicationIdentifier">
                <div>
                  <dt>{{ deduplicationIdentifierText(audit.identifier.kind) }}</dt>
                  <dd>{{ audit.identifier.value }}</dd>
                </div>
              </dl>

              <div :class="$style.deduplicationDecision">
                <div>
                  <strong>{{ $t('tools__discography_deduplication_retained') }}</strong>
                  <span>{{ deduplicationLocationText(audit.kind, audit.kept) }}</span>
                </div>
                <div>
                  <strong>{{ $t('tools__discography_deduplication_removed') }}</strong>
                  <span>{{ deduplicationLocationText(audit.kind, audit.removed) }}</span>
                </div>
              </div>

              <p v-if="audit.limited" :class="$style.deduplicationLimitation">
                {{ $t('tools__discography_deduplication_limited') }}
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section :class="$style.panel">
        <h3>{{ $t('tools__discography_playlist_targets') }}</h3>
        <ul :class="$style.playlistTargets">
          <li v-for="item in sourcePlans" :key="item.source">
            <base-checkbox
              :id="`discography-generate-${item.source}`"
              :model-value="generateSourceSelection[item.source]"
              :label="item.label"
              :disabled="!item.canGenerate || isApplying || applyResult?.status == 'applied'"
              @update:model-value="setGenerateSourceSelected(item.source, Boolean($event))"
            />
            <strong>{{ playlistNames[item.source] }}</strong>
            <small>{{ $t('tools__discography_source_summary', {
              albums: item.plan.actualAlbumCount,
              tracks: item.plan.deduplicatedTrackCount,
            }) }}</small>
          </li>
        </ul>

        <p :class="$style.downloadTip">{{ $t('tools__discography_download_tip') }}</p>

        <div v-if="applyResult?.status != null && applyResult?.status != 'applied'" :class="$style.applyFailure" role="alert">
          <h3>{{ $t('tools__discography_apply_failed') }}</h3>
          <p>{{ applyFailureText(applyResult?.status) }}</p>
          <p v-if="residualPlaylistSummary">
            {{ $t('tools__discography_batch_residual_lists', {
              ids: residualPlaylistSummary,
            }) }}
          </p>
          <ul>
            <li v-for="(issue, index) in applyResult?.issues ?? []" :key="`${issue.code}-${String(index)}`">
              {{ batchIssueText(issue) }}
            </li>
          </ul>
        </div>

        <div v-if="applyResult?.status == 'applied'" :class="$style.applySuccess" role="status">
          <h3>{{ $t('tools__discography_batch_apply_success') }}</h3>
          <div :class="$style.openActions">
            <base-btn
              v-for="item in appliedSourceConfigs"
              :key="item.source"
              min
              outline
              type="button"
              @click="openPlaylist(item.source)"
            >
              {{ $t('tools__discography_open_playlist', { source: item.label }) }}
            </base-btn>
          </div>
        </div>

        <div :class="$style.applyActions">
          <p v-if="applyBlockedReason">{{ applyBlockedReason }}</p>
          <base-btn type="button" :disabled="applyDisabled" @click="handleApply">
            {{ isApplying ? $t('tools__discography_applying') : $t('tools__discography_apply') }}
          </base-btn>
        </div>
      </section>
    </template>
  </main>

  <material-modal
    :show="pendingArtists.length > 0"
    :bg-close="false"
    :close-btn="false"
    teleport="#view"
    @close="settleArtistConfirmation(false)"
  >
    <main :class="$style.artistConfirm">
      <h2>{{ $t('tools__discography_confirm_artist_title') }}</h2>
      <p :class="$style.confirmHelp">
        {{ $t('tools__discography_confirm_artists', { count: pendingArtists.length }) }}
      </p>
      <ul :class="$style.artistConfirmList">
        <li v-for="artist in pendingArtists" :key="artist.source">
          <img v-if="artist.avatar" :src="artist.avatar" :alt="artist.name">
          <div v-else :class="$style.artistAvatarFallback" aria-hidden="true">♪</div>
          <div>
            <strong>{{ sourceLabel(artist.source) }} · {{ artist.name }}</strong>
            <span>ID: {{ artist.id }}</span>
            <span>{{ $t('tools__discography_declared_albums') }}：{{ formatCount(artist.albumCount) }}</span>
          </div>
        </li>
      </ul>
      <div :class="$style.confirmActions">
        <base-btn outline type="button" @click="settleArtistConfirmation(false)">
          {{ $t('cancel_button_text') }}
        </base-btn>
        <base-btn type="button" @click="settleArtistConfirmation(true)">
          {{ $t('confirm_button_text') }}
        </base-btn>
      </div>
    </main>
  </material-modal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { clipboardWriteText } from '@common/utils/electron'
import { onDeactivated } from 'vue'
import { useI18n } from '@renderer/plugins/i18n'
import { dialog } from '@renderer/plugins/Dialog'
import { userLists } from '@renderer/store/list/state'
import {
  ARTIST_DISCOGRAPHY_SOURCES,
  createArtistDiscographyBatchModule,
  createArtistDiscographyPlaylistName,
} from '@renderer/core/artistDiscography'
import type {
  ArtistDiscographySource,
  ArtistRef,
  DiscographyBatchApplyResult,
  DiscographyBatchPlan,
  DiscographyIssue,
  DiscographyPlanProgress,
  DiscographyPlanStatus,
} from '@renderer/core/artistDiscography'
import { createLocalPlaylistAdapter } from '@renderer/core/artistDiscography/adapters/playlist'
import { createKgArtistCatalogAdapter } from '@renderer/utils/musicSdk/kg/artistDiscography'
import { createKwArtistCatalogAdapter } from '@renderer/utils/musicSdk/kw/artistDiscography'
import { createTxArtistCatalogAdapter } from '@renderer/utils/musicSdk/tx/artistDiscography'
import { createWyArtistCatalogAdapter } from '@renderer/utils/musicSdk/wy/artistDiscography'
import {
  createDiscographyDeduplicationPresentation,
  createDiscographyPreview,
} from './preview'
import {
  canGenerateDiscographyPlaylist,
  createDiscographyGenerateSelection,
  createDiscographySourceSelection,
  getSelectedDiscographySources,
} from './sourceSelection'
import type {
  DiscographyDeduplicationIdentifierPresentation,
  DiscographyDeduplicationOccurrencePresentation,
  DiscographyDeduplicationPresentation,
} from './preview'

const t = useI18n()
const router = useRouter()
const playlist = createLocalPlaylistAdapter()
const discography = createArtistDiscographyBatchModule({
  catalogs: {
    kg: createKgArtistCatalogAdapter(),
    tx: createTxArtistCatalogAdapter(),
    wy: createWyArtistCatalogAdapter(),
    kw: createKwArtistCatalogAdapter(),
  },
  playlist,
})

const sourceTranslationKeys: Record<ArtistDiscographySource, 'tools__discography_source_kg' | 'tools__discography_source_tx' | 'tools__discography_source_wy' | 'tools__discography_source_kw'> = {
  kg: 'tools__discography_source_kg',
  tx: 'tools__discography_source_tx',
  wy: 'tools__discography_source_wy',
  kw: 'tools__discography_source_kw',
}
const sourceConfigs = computed(() => ARTIST_DISCOGRAPHY_SOURCES.map(source => ({
  source,
  label: t(sourceTranslationKeys[source]),
})))

const createSourceRecord = <T>(factory: (source: ArtistDiscographySource) => T) => ({
  kg: factory('kg'),
  tx: factory('tx'),
  wy: factory('wy'),
  kw: factory('kw'),
})

const artistName = ref('')
const isPlanning = ref(false)
const isApplying = ref(false)
const isCancelling = ref(false)
const fetchSourceSelection = ref<Record<ArtistDiscographySource, boolean>>(
  createDiscographySourceSelection(),
)
const generateSourceSelection = ref<Record<ArtistDiscographySource, boolean>>(
  createDiscographySourceSelection(),
)
const progressBySource = ref<Record<ArtistDiscographySource, DiscographyPlanProgress | null>>(
  createSourceRecord(() => null),
)
const batchPlan = shallowRef<DiscographyBatchPlan | null>(null)
const applyResult = shallowRef<DiscographyBatchApplyResult | null>(null)
const unexpectedMessage = ref('')
const pendingArtists = shallowRef<ArtistRef[]>([])
const copiedDeduplicationKey = ref('')
let planController: AbortController | null = null
let artistConfirmationResolver: ((confirmed: boolean) => void) | null = null
let copiedDeduplicationTimer: ReturnType<typeof setTimeout> | null = null

const selectedFetchSources = computed(() => getSelectedDiscographySources(fetchSourceSelection.value))
const selectedGenerateSources = computed(() => getSelectedDiscographySources(
  generateSourceSelection.value,
  batchPlan.value?.sources ?? [],
))
const sourcePlans = computed(() => {
  const plan = batchPlan.value
  if (!plan) return []
  return plan.sources.flatMap(source => {
    const sourcePlan = plan.plans[source]
    if (!sourcePlan) return []
    const item = sourceConfigs.value.find(config => config.source == source)!
    const preview = createDiscographyPreview(sourcePlan)
    return [{
      ...item,
      plan: sourcePlan,
      canGenerate: canGenerateDiscographyPlaylist(sourcePlan),
      preview: {
        ...preview,
        deduplications: preview.deduplications.map(createDiscographyDeduplicationPresentation),
      },
    }]
  })
})
const playlistNames = computed<Partial<Record<ArtistDiscographySource, string>>>(() => {
  const plan = batchPlan.value
  if (!plan) return {}
  return Object.fromEntries(plan.sources.flatMap(source => {
    const sourcePlan = plan.plans[source]
    return sourcePlan
      ? [[source, createArtistDiscographyPlaylistName(plan.artistName, source, sourcePlan.deduplicatedTrackCount)]]
      : []
  }))
})
const residualPlaylistSummary = computed(() => applyResult.value?.residualPlaylists
  .map(item => `${item.name} (ID: ${item.id})`)
  .join(', ') ?? '')
const progressSources = computed(() => batchPlan.value?.sources ?? selectedFetchSources.value)
const progressSourceConfigs = computed(() => sourceConfigs.value.filter(
  item => progressSources.value.includes(item.source),
))
const appliedSourceConfigs = computed(() => sourceConfigs.value.filter(
  item => applyResult.value?.listIds[item.source] != null,
))
const hasProgress = computed(() => isPlanning.value || progressSources.value.some(
  source => progressBySource.value[source] != null,
))

const sourceLabel = (source: ArtistDiscographySource) => t(sourceTranslationKeys[source])
const setFetchSourceSelected = (source: ArtistDiscographySource, selected: boolean) => {
  fetchSourceSelection.value = { ...fetchSourceSelection.value, [source]: selected }
}
const setGenerateSourceSelected = (source: ArtistDiscographySource, selected: boolean) => {
  if (selected && !canGenerateDiscographyPlaylist(batchPlan.value?.plans[source])) return
  generateSourceSelection.value = { ...generateSourceSelection.value, [source]: selected }
  applyResult.value = null
}
const applyBlockedReason = computed(() => {
  if (!batchPlan.value) return ''
  if (!selectedGenerateSources.value.length) return t('tools__discography_generate_sources_required')
  const blockedSource = selectedGenerateSources.value.find(
    source => !canGenerateDiscographyPlaylist(batchPlan.value!.plans[source]),
  )
  if (blockedSource) {
    return t('tools__discography_batch_source_blocked', { source: sourceLabel(blockedSource) })
  }
  return ''
})
const applyDisabled = computed(() => {
  if (!batchPlan.value || isPlanning.value || isApplying.value) return true
  if (!batchPlan.value.canApply || !selectedGenerateSources.value.length || applyResult.value?.status == 'applied') return true
  return applyBlockedReason.value.length > 0
})

const formatCount = (count: number | null) => count == null
  ? t('tools__discography_unknown_count')
  : String(count)

const planStatusText = (status: DiscographyPlanStatus) => {
  switch (status) {
    case 'complete': return t('tools__discography_status_complete')
    case 'partial': return t('tools__discography_status_partial')
    case 'failed': return t('tools__discography_status_failed')
    case 'cancelled': return t('tools__discography_status_cancelled')
  }
}

const issueText = (issue: DiscographyIssue, albumName: string | null = null) => {
  let text: string
  switch (issue.code) {
    case 'unsupported_source':
    case 'invalid_artist_ref':
    case 'artist_not_found':
      text = t('tools__discography_issue_input')
      break
    case 'provider_unavailable':
      text = t('tools__discography_issue_provider')
      break
    case 'invalid_provider_response':
      text = t('tools__discography_issue_response')
      break
    case 'pagination_inconsistent':
      text = t('tools__discography_issue_pagination')
      break
    case 'album_incomplete':
      text = t('tools__discography_issue_incomplete')
      break
    case 'empty_catalog':
      text = t('tools__discography_issue_empty')
      break
    case 'cancelled':
      text = t('tools__discography_issue_cancelled')
      break
    case 'duplicate_album':
    case 'duplicate_track':
      text = t('tools__discography_issue_duplicate')
      break
    default:
      text = t('tools__discography_issue_playlist')
      break
  }

  const details: string[] = []
  if (albumName) details.push(`${t('tools__discography_deduplication_album')}: ${albumName}`)
  if (issue.albumId) details.push(`albumId: ${issue.albumId}`)
  if (issue.relatedAlbumId) details.push(`retainedAlbumId: ${issue.relatedAlbumId}`)
  if (issue.trackId) details.push(`trackId: ${issue.trackId}`)
  if (issue.expected != null) details.push(`${issue.expected} → ${issue.actual ?? '?'}`)
  return details.length ? `${text} (${details.join('; ')})` : text
}

const batchIssueText = (issue: DiscographyIssue) => issue.source
  ? `${sourceLabel(issue.source)}：${issueText(issue)}`
  : issueText(issue)

const deduplicationKey = (
  source: ArtistDiscographySource,
  audit: DiscographyDeduplicationPresentation,
) => `${source}-${audit.key}`

const deduplicationScopeText = (scope: DiscographyDeduplicationPresentation['scope']) => {
  switch (scope) {
    case 'album_catalog': return t('tools__discography_deduplication_album_catalog')
    case 'album_tracks': return t('tools__discography_deduplication_album_tracks')
    case 'source_assembly': return t('tools__discography_deduplication_source_assembly')
  }
}

const deduplicationIdentifierText = (kind: DiscographyDeduplicationIdentifierPresentation['kind']) => {
  switch (kind) {
    case 'track_id': return t('tools__discography_deduplication_track_id')
    case 'album_id': return t('tools__discography_deduplication_album_id')
    case 'provider_song_id': return t('tools__discography_deduplication_provider_song_id')
  }
}

const deduplicationLocationText = (
  kind: DiscographyDeduplicationPresentation['kind'],
  occurrence: DiscographyDeduplicationOccurrencePresentation | null,
) => {
  if (!occurrence) return t('tools__discography_deduplication_unknown_location')
  if (kind == 'album') {
    return t('tools__discography_deduplication_album_location', {
      album: occurrence.albumName ?? t('tools__discography_unknown_album'),
      albumId: occurrence.albumId ?? t('tools__discography_unknown_count'),
    })
  }
  return t('tools__discography_deduplication_track_location', {
    album: occurrence.albumName ?? t('tools__discography_unknown_album'),
    albumId: occurrence.albumId ?? t('tools__discography_unknown_count'),
    trackNumber: occurrence.trackNumber ?? t('tools__discography_unknown_count'),
  })
}

const copyDeduplicationAudit = (
  source: ArtistDiscographySource,
  audit: DiscographyDeduplicationPresentation,
) => {
  const entityLabel = audit.kind == 'track'
    ? t('tools__discography_deduplication_track')
    : t('tools__discography_deduplication_album')
  const entityName = audit.name ?? t(
    audit.kind == 'track' ? 'tools__discography_unknown_track' : 'tools__discography_unknown_album',
  )
  const lines = [
    `${t('tools__discography_source')}：${sourceLabel(source)}`,
    `${t('tools__discography_deduplication_type')}：${deduplicationScopeText(audit.scope)}`,
    `${entityLabel}：${entityName}`,
  ]
  if (audit.singer) lines.push(`${t('tools__discography_deduplication_artist')}：${audit.singer}`)
  if (audit.identifier) {
    lines.push(`${deduplicationIdentifierText(audit.identifier.kind)}：${audit.identifier.value}`)
  }
  lines.push(
    `${t('tools__discography_deduplication_retained')}：${deduplicationLocationText(audit.kind, audit.kept)}`,
    `${t('tools__discography_deduplication_removed')}：${deduplicationLocationText(audit.kind, audit.removed)}`,
  )
  if (audit.limited) lines.push(t('tools__discography_deduplication_limited'))

  clipboardWriteText(lines.join('\n'))
  copiedDeduplicationKey.value = deduplicationKey(source, audit)
  if (copiedDeduplicationTimer) clearTimeout(copiedDeduplicationTimer)
  copiedDeduplicationTimer = setTimeout(() => {
    copiedDeduplicationKey.value = ''
    copiedDeduplicationTimer = null
  }, 1600)
}

const applyFailureText = (status: DiscographyBatchApplyResult['status'] | undefined) => {
  switch (status) {
    case 'validation_failed': return t('tools__discography_batch_validation_failed')
    case 'failed_rolled_back': return t('tools__discography_batch_rolled_back')
    case 'failed_with_residuals': return t('tools__discography_batch_rollback_incomplete')
    default: return t('tools__discography_batch_apply_failed')
  }
}

const sourceProgressText = (source: ArtistDiscographySource) => {
  if (isCancelling.value) return t('tools__discography_progress_cancelling')
  const value = progressBySource.value[source]
  if (!value) return t('tools__discography_progress_waiting')
  switch (value.stage) {
    case 'resolving_artist':
      return t('tools__discography_progress_artist')
    case 'fetching_albums':
      return t('tools__discography_progress_albums')
    case 'fetching_album_tracks':
      return t('tools__discography_progress_tracks', {
        completed: value.completed,
        total: value.total,
      })
    case 'completed':
      return t('tools__discography_progress_complete', {
        completed: value.completed,
        total: value.total,
      })
  }
}

const settleArtistConfirmation = (confirmed: boolean) => {
  const resolve = artistConfirmationResolver
  artistConfirmationResolver = null
  pendingArtists.value = []
  resolve?.(confirmed)
}
const confirmResolvedArtists = async(artists: ArtistRef[]) => await new Promise<boolean>(resolve => {
  artistConfirmationResolver = resolve
  pendingArtists.value = artists
})

const handleCancel = () => {
  settleArtistConfirmation(false)
  if (!planController) return
  isCancelling.value = true
  planController.abort()
}

const handlePlan = async() => {
  const name = artistName.value.trim()
  const sources = [...selectedFetchSources.value]
  if (!name || !sources.length || isPlanning.value || isApplying.value) return

  settleArtistConfirmation(false)
  planController?.abort()
  planController = new AbortController()
  isPlanning.value = true
  isCancelling.value = false
  progressBySource.value = createSourceRecord(source => sources.includes(source)
    ? { stage: 'resolving_artist' }
    : null)
  batchPlan.value = null
  applyResult.value = null
  unexpectedMessage.value = ''

  try {
    const nextPlan = await discography.plan({
      artistName: name,
      sources,
      signal: planController.signal,
      onProgress: ({ source, progress }) => {
        progressBySource.value[source] = progress
      },
      confirmArtists: confirmResolvedArtists,
    })
    batchPlan.value = nextPlan
    generateSourceSelection.value = createDiscographyGenerateSelection(nextPlan)
  } catch {
    unexpectedMessage.value = t('tools__discography_unexpected_error')
  } finally {
    isPlanning.value = false
    isCancelling.value = false
  }
}

const handleApply = async() => {
  if (applyDisabled.value || !batchPlan.value) return
  const plan = batchPlan.value
  const sources = [...selectedGenerateSources.value]
  if (!sources.length) return
  const names = { ...playlistNames.value }
  const totalTracks = sources.reduce(
    (count, source) => count + (plan.plans[source]?.deduplicatedTrackCount ?? 0),
    0,
  )

  isApplying.value = true
  unexpectedMessage.value = ''
  applyResult.value = null
  try {
    const duplicateNames = sources
      .map(source => names[source])
      .filter((name): name is string => typeof name == 'string')
      .filter(name => userLists.some(list => list.name == name))

    if (duplicateNames.length && !(await dialog.confirm({
      message: t('tools__discography_duplicate_lists', { names: duplicateNames.join('、') }),
      cancelButtonText: t('cancel_button_text'),
      confirmButtonText: t('confirm_button_text'),
    }))) return

    const confirmed = await dialog.confirm({
      message: t('tools__discography_confirm_batch_apply', { count: totalTracks }),
      cancelButtonText: t('cancel_button_text'),
      confirmButtonText: t('confirm_button_text'),
    })
    if (!confirmed) return

    applyResult.value = await discography.apply({ plan, sources })
  } catch {
    unexpectedMessage.value = t('tools__discography_unexpected_error')
  } finally {
    isApplying.value = false
  }
}

const openPlaylist = async(source: ArtistDiscographySource) => {
  const listId = applyResult.value?.listIds[source]
  if (listId) await router.push({ path: '/list', query: { id: listId } })
}

onDeactivated(() => {
  if (isPlanning.value) handleCancel()
})

onBeforeUnmount(() => {
  settleArtistConfirmation(false)
  planController?.abort()
  if (copiedDeduplicationTimer) clearTimeout(copiedDeduplicationTimer)
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 15px;
  color: var(--color-font);
  border-top: var(--color-list-header-border-bottom);
  font-size: 13px;
}

.panel {
  max-width: 980px;
  margin: 0 auto 15px;
  padding: 16px;
  box-sizing: border-box;
  border-radius: @radius-border;
  background-color: var(--color-content-background);

  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 18px; line-height: 1.4; }
  h2 { font-size: 16px; }
  h3 { margin: 15px 0 10px; font-size: 13px; }
}

.heading, .previewHeader, .deduplicationHeading, .deduplicationItemHeader, .inputRow, .applyActions, .openActions {
  display: flex;
  align-items: center;
}

.heading, .previewHeader, .deduplicationHeading, .deduplicationItemHeader {
  justify-content: space-between;
  gap: 15px;
}

.sourceSelector {
  display: flex;
  align-items: center;
  gap: 9px;

  > span { flex: none; color: var(--color-font-label); }
}

.sourceBadges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.sourceOption, .planStatus, .deduplicationType {
  flex: none;
  border-radius: @form-radius;
  padding: 3px 8px;
  background-color: var(--color-button-background);
}

.collectForm { margin-top: 16px; }

.fieldLabel {
  display: block;
  margin-bottom: 7px;
  color: var(--color-font-label);
}

.inputRow { gap: 8px; }
.artistInput { flex: auto; min-width: 120px; }

.help {
  margin-top: 7px !important;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.5;
}

.selectionError {
  margin-top: 7px !important;
  color: var(--color-font);
  font-size: 12px;
}

.progressList, .error, .downloadTip, .applyFailure, .applySuccess {
  margin-top: 12px !important;
  padding: 9px 10px;
  border-radius: @form-radius;
  line-height: 1.5;
  background-color: var(--color-button-background);
}

.progressList {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;

  p { display: flex; gap: 8px; min-width: 0; }
  strong { flex: none; }
  span { color: var(--color-font-label); .mixin-ellipsis-1(); }
}

.error, .applyFailure { border-left: 3px solid var(--color-font-label); }
.applySuccess { border-left: 3px solid var(--color-primary); }

.artist {
  display: flex;
  align-items: center;
  gap: 10px;

  img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
  p { margin-top: 4px; color: var(--color-font-label); }
}

.complete { color: var(--color-primary); }
.partial, .incomplete, .unknown { color: var(--color-font-label); }
.failed, .cancelled { opacity: .75; }

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(110px, 1fr));
  gap: 8px;

  > div { padding: 10px; border-radius: @form-radius; background-color: var(--color-button-background); }
  dt { color: var(--color-font-label); font-size: 12px; }
  dd { margin: 5px 0 0; font-size: 18px; }
}

.issueGroup ul, .applyFailure ul {
  padding-left: 18px;
  line-height: 1.55;
}
.issueWarning { color: var(--color-font-label); }
.issueError { color: var(--color-font); }

.deduplicationGroup {
  margin-top: 16px;
  padding: 12px;
  border-radius: @form-radius;
  background-color: var(--color-button-background);
}

.deduplicationHeading {
  align-items: flex-start;

  h3 { margin: 0 0 5px; }
  p { color: var(--color-font-label); }
  > span { flex: none; color: var(--color-font-label); }
}

.deduplicationList {
  display: grid;
  gap: 8px;
  margin-top: 10px;

  > li {
    min-width: 0;
    padding: 11px;
    border-radius: @form-radius;
    background-color: var(--color-content-background);
  }
}

.deduplicationItemHeader {
  align-items: flex-start;

  > div { min-width: 0; }
  strong, small { display: block; }
  strong { margin-top: 6px; font-size: 14px; .mixin-ellipsis-1(); }
  small { margin-top: 3px; color: var(--color-font-label); }
}

.deduplicationType { display: inline-block; color: var(--color-font-label); font-size: 12px; }

.deduplicationIdentifier {
  margin-top: 10px;
  font-size: 12px;

  dt { color: var(--color-font-label); }
  dd {
    margin: 3px 0 0;
    overflow-wrap: anywhere;
    font-family: Consolas, 'Courier New', monospace;
  }
}

.deduplicationDecision {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;

  > div { min-width: 0; padding-left: 9px; border-left: 3px solid var(--color-button-background); }
  > div:first-child { border-left-color: var(--color-primary); }
  strong, span { display: block; }
  span { margin-top: 4px; line-height: 1.5; overflow-wrap: anywhere; }
}

.deduplicationLimitation { margin-top: 9px !important; color: var(--color-font-label); font-size: 12px; line-height: 1.5; }

.playlistTargets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;

  li { display: grid; gap: 4px; padding: 10px; border-radius: @form-radius; background-color: var(--color-button-background); }
  span, small { color: var(--color-font-label); }
  strong { .mixin-ellipsis-1(); }
}

.downloadTip { color: var(--color-font-label); }
.applyFailure h3, .applySuccess h3 { margin: 0 0 6px; }
.openActions { flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.applyActions {
  justify-content: flex-end;
  gap: 12px;
  margin-top: 14px;

  p { color: var(--color-font-label); }
}

.artistConfirm {
  box-sizing: border-box;
  width: min(620px, calc(100vw - 50px));
  padding: 20px;
  color: var(--color-font);

  h2, p { margin: 0; }
}

.confirmHelp { margin-top: 8px !important; color: var(--color-font-label); line-height: 1.5; }
.artistConfirmList {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 16px;

  li { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px; border-radius: @form-radius; background-color: var(--color-button-background); }
  img, .artistAvatarFallback { flex: none; width: 52px; height: 52px; border-radius: 50%; }
  img { object-fit: cover; }
  div:last-child { min-width: 0; }
  strong, span { display: block; .mixin-ellipsis-1(); }
  span { margin-top: 3px; color: var(--color-font-label); font-size: 12px; }
}

.artistAvatarFallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: var(--color-content-background);
  font-size: 22px;
}

.confirmActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

@media (max-width: 760px) {
  .heading { align-items: flex-start; flex-direction: column; }
  .sourceSelector { align-items: flex-start; flex-direction: column; }
  .sourceBadges { justify-content: flex-start; }
  .stats, .deduplicationDecision, .playlistTargets, .artistConfirmList, .progressList { grid-template-columns: 1fr; }
  .inputRow { align-items: stretch; flex-wrap: wrap; }
  .artistInput { flex-basis: 100%; }
}
</style>
