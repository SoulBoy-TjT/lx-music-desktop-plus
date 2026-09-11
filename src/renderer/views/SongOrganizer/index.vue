<template>
  <main :class="$style.main">
    <section v-if="!capabilityReady" :class="[$style.panel, $style.centerState]">
      <p>{{ $t('loading') }}</p>
    </section>

    <section v-else-if="!supported" :class="[$style.panel, $style.centerState]">
      <h1>{{ $t('song_organizer') }}</h1>
      <p :class="$style.error">
        {{ $t('song_organizer__unsupported') }}
      </p>
    </section>

    <template v-else>
      <section v-if="recovery" :class="[$style.panel, $style.recovery]">
        <div>
          <h2>{{ $t('song_organizer__recovery_title') }}</h2>
          <p>{{ $t('song_organizer__recovery_message', { type: visibleRecovery.type, count: visibleRecovery.steps.length }) }}</p>
        </div>
        <div :class="$style.actions">
          <base-btn v-if="visibleRecovery.type == 'rename'" min :disabled="operating" @click="rollbackRecovery">
            {{ $t('song_organizer__try_rollback') }}
          </base-btn>
          <base-btn min outline :disabled="operating" @click="dismissRecovery">
            {{ $t('song_organizer__dismiss_recovery') }}
          </base-btn>
        </div>
      </section>

      <section :class="[$style.panel, $style.workspace]">
        <header :class="$style.heading">
          <h1>{{ $t('song_organizer') }}</h1>
          <p>{{ $t('song_organizer__description') }}</p>
        </header>

        <div :class="$style.rootRow">
          <span :class="$style.rootLabel">{{ $t('song_organizer__scan_root') }}</span>
          <span :class="$style.path" :title="root">{{ root }}</span>
          <div :class="$style.rootActions">
            <base-btn min :disabled="scanning || operating" @click="chooseSpecifiedRoot">
              {{ $t('song_organizer__choose_specified_root') }}
            </base-btn>
            <base-btn min outline :disabled="scanning || operating" @click="useDownloadRoot">
              {{ $t('song_organizer__use_download_root') }}
            </base-btn>
            <base-btn
              min
              outline
              :disabled="reloadControl.disabled"
              @click="reload"
            >
              {{ $t('song_organizer__rescan') }}
            </base-btn>
          </div>
        </div>

        <div v-if="operationProgressLabel" :class="$style.operationProgress" aria-live="polite">
          <strong>{{ operationProgressLabel }}</strong>
          <span
            v-if="operationProgressTarget"
            :class="$style.operationTarget"
            :title="operationProgressTarget"
          >
            {{ $t('song_organizer__operation_current_target', { target: operationProgressTarget }) }}
          </span>
        </div>

        <div :class="$style.tableWrap">
          <table :class="$style.table">
            <colgroup>
              <col :class="$style.artistCol">
              <col :class="$style.countCol">
              <col :class="$style.targetCol">
              <col :class="$style.statusCol">
              <col :class="$style.operationCol">
            </colgroup>
            <thead>
              <tr>
                <th>{{ $t('song_organizer__artist_folder') }}</th>
                <th>{{ $t('song_organizer__song_count') }}</th>
                <th>{{ $t('song_organizer__target_name') }}</th>
                <th>{{ $t('song_organizer__status_column') }}</th>
                <th>{{ $t('song_organizer__operation') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in artistRows" :key="row.artist.path">
                <td>
                  <span :class="$style.artistName" :title="row.artist.path">{{ row.artist.name }}</span>
                </td>
                <td :class="$style.countCell">{{ row.artist.audioCount }}</td>
                <td>
                  <span :class="$style.targetName" :title="row.artist.targetName">{{ row.artist.targetName }}</span>
                </td>
                <td>
                  <div :class="$style.statusTags">
                    <span
                      v-for="status in row.statuses"
                      :key="status"
                      :class="[$style.statusTag, $style[status]]"
                    >
                      {{ $t(`song_organizer__status_${String(status)}`) }}
                    </span>
                    <span v-if="!row.statuses.length" :class="$style.readyTag">{{ $t('song_organizer__status_ready') }}</span>
                  </div>
                  <p v-if="row.blockedReasons.length" :class="$style.blockReason" :title="row.blockedReasons.join('；')">
                    {{ row.blockedReasons.join('；') }}
                  </p>
                </td>
                <td>
                  <div :class="$style.rowActions">
                    <base-btn
                      min
                      :disabled="scanning || operating || Boolean(row.organizeDisabledReason)"
                      :title="actionDisabledText(row.organizeDisabledReason, row, 'organize')"
                      @click="organize(row)"
                    >
                      {{ $t('song_organizer__organize') }}
                    </base-btn>
                    <base-btn min outline @click="showDetails(row)">{{ $t('song_organizer__view_details') }}</base-btn>
                    <base-btn min outline @click="openDirInExplorer(row.artist.path)">{{ $t('song_organizer__open_folder') }}</base-btn>
                  </div>
                </td>
              </tr>
              <tr v-if="!artistRows.length">
                <td colspan="5" :class="$style.emptyTable">
                  {{ snapshot ? $t('song_organizer__no_artists') : $t('song_organizer__scan_hint') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <detail-modal
        :show="detailDialogVisible"
        :title="detailDialogTitle"
        :lines="detailLines"
        :confirmation="detailDialogConfirmation"
        :confirm-button-text="$t('confirm_button_text')"
        :cancel-button-text="$t('cancel_button_text')"
        :close-button-text="$t('close')"
        @confirm="resolveDetailDialog(true)"
        @cancel="resolveDetailDialog(false)"
      />
    </template>
  </main>
</template>

<script setup lang="ts">
import DetailModal from '@renderer/components/common/OperationDetailModal.vue'
import { useSongOrganizer } from './useSongOrganizer'

const {
  actionDisabledText,
  artistRows,
  capabilityReady,
  chooseSpecifiedRoot,
  detailDialogConfirmation,
  detailDialogTitle,
  detailDialogVisible,
  detailLines,
  dismissRecovery,
  openDirInExplorer,
  operationProgressLabel,
  operationProgressTarget,
  operating,
  organize,
  recovery,
  reload,
  reloadControl,
  resolveDetailDialog,
  rollbackRecovery,
  root,
  scanning,
  showDetails,
  snapshot,
  supported,
  useDownloadRoot,
  visibleRecovery,
} = useSongOrganizer()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px;
  overflow: hidden;
}

.panel {
  box-sizing: border-box;
  border-radius: @radius-border;
  background: var(--color-content-background);
}

.centerState {
  margin: auto;
  padding: 24px;
  text-align: center;
}

.centerState h1,
.heading h1,
.recovery h2 {
  margin: 0;
}

.centerState p,
.heading p,
.recovery p {
  margin: 6px 0 0;
}

.recovery {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--color-yellow);
}

.workspace {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.actions,
.rootActions,
.rowActions {
  display: flex;
  align-items: center;
}

.heading {
  flex: 0 0 auto;
  padding: 16px 18px 14px;
}

.heading p {
  opacity: .68;
}

.actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.rootRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  flex: 0 0 auto;
  column-gap: 12px;
  padding: 10px 18px;
  border-top: var(--color-list-header-border-bottom);
  border-bottom: var(--color-list-header-border-bottom);
}

.rootLabel {
  flex: 0 0 auto;
  font-weight: 600;
}

.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .76;
}

.rootActions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.operationProgress {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 12px;
  min-height: 36px;
  padding: 7px 18px;
  overflow: hidden;
  color: var(--color-primary);
  border-bottom: var(--color-list-header-border-bottom);
  background: var(--color-primary-background-hover);
  font-variant-numeric: tabular-nums;
}

.operationTarget {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-font);
}

.tableWrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.table th,
.table td {
  box-sizing: border-box;
  padding: 10px 12px;
  border-bottom: var(--color-list-header-border-bottom);
  text-align: left;
  vertical-align: middle;
}

.table th {
  position: sticky;
  z-index: 2;
  top: 0;
  font-weight: 600;
  background: var(--color-content-background);
  border-bottom: var(--color-list-header-border-bottom);
}

.table tbody tr:hover {
  background: var(--color-primary-background-hover);
}

.artistCol { width: 18%; }
.countCol { width: 8%; }
.targetCol { width: 20%; }
.statusCol { width: 24%; }
.operationCol { width: 30%; }

.artistName,
.targetName {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artistName {
  font-weight: 600;
}

.countCell {
  font-variant-numeric: tabular-nums;
}

.statusTags,
.rowActions {
  flex-wrap: wrap;
  gap: 5px;
}

.statusTag,
.readyTag {
  display: inline-flex;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.45;
  white-space: nowrap;
  background: var(--color-button-background);
}

.pending_cleanup,
.pending_rename {
  color: var(--color-primary);
  border-color: currentColor;
  background: transparent;
}

.checked {
  color: var(--color-green);
  border-color: currentColor;
  background: transparent;
}

.unchecked {
  opacity: .62;
}

.audio_anomaly {
  color: var(--color-yellow);
  border-color: currentColor;
  background: transparent;
}

.cleanup_blocked,
.rename_blocked,
.blocked,
.error {
  color: var(--color-red);
}

.cleanup_blocked,
.rename_blocked,
.blocked {
  border-color: currentColor;
  background: transparent;
}

.blockReason {
  margin: 5px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-red);
  font-size: 12px;
}

.readyTag {
  opacity: .62;
}

.emptyTable {
  height: 120px;
  text-align: center !important;
  opacity: .6;
}

@media (max-width: 980px) {
  .recovery {
    align-items: stretch;
    flex-direction: column;
  }

  .actions {
    justify-content: flex-start;
  }

  .rootRow {
    grid-template-columns: 1fr;
    row-gap: 7px;
  }

  .rootActions {
    justify-content: flex-start;
  }

  .table {
    min-width: 900px;
  }
}

</style>
