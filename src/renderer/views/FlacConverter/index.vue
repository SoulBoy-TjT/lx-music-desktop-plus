<template>
  <main :class="$style.main">
    <section v-if="!capabilityReady" :class="[$style.panel, $style.centerState]">
      <p>{{ $t('loading') }}</p>
    </section>

    <section v-else-if="!supported || !ffmpegAvailable" :class="[$style.panel, $style.centerState]">
      <h1>{{ $t('flac_conversion') }}</h1>
      <p :class="$style.error">
        {{ !supported ? $t('flac_conversion__unsupported') : $t('flac_conversion__ffmpeg_unavailable') }}
      </p>
    </section>

    <section v-else :class="[$style.panel, $style.workspace]">
      <header :class="$style.heading">
        <h1>{{ $t('flac_conversion') }}</h1>
        <p>{{ $t('flac_conversion__description') }}</p>
      </header>

      <div :class="$style.directoryRow">
        <span :class="$style.directoryLabel">{{ $t('flac_conversion__download_directory') }}</span>
        <span :class="$style.path" :title="rootDirectory">{{ rootDirectory }}</span>
        <div :class="$style.directoryActions">
          <base-btn v-if="isCustomRootDirectory" min outline :disabled="scanning || operating" @click="useDownloadDirectory">
            {{ $t('flac_conversion__use_download_directory') }}
          </base-btn>
          <base-btn min outline :disabled="scanning || operating" @click="selectRootDirectory">
            {{ $t('flac_conversion__choose_source') }}
          </base-btn>
          <base-btn min :disabled="scanning || operating" @click="scanArtists">
            {{ scanning ? $t('flac_conversion__scanning') : $t('flac_conversion__scan_download') }}
          </base-btn>
        </div>
      </div>

      <div :class="$style.directoryRow">
        <span :class="$style.directoryLabel">{{ $t('flac_conversion__output_parent') }}</span>
        <span :class="$style.path" :title="outputParentDirectory">
          {{ outputParentDirectory || $t('flac_conversion__default_output') }}
        </span>
        <div :class="$style.directoryActions">
          <base-btn v-if="outputParentDirectory" min outline :disabled="scanning || operating" @click="useDefaultOutput">
            {{ $t('flac_conversion__use_default_output') }}
          </base-btn>
          <base-btn min :disabled="scanning || operating" @click="selectOutput">
            {{ $t('flac_conversion__choose_output') }}
          </base-btn>
        </div>
      </div>

      <p v-if="errorMessage" :class="$style.pageError">{{ errorMessage }}</p>

      <div :class="$style.tableWrap">
        <table :class="$style.table">
          <colgroup>
            <col :class="$style.artistCol">
            <col :class="$style.countCol">
            <col :class="$style.outputCol">
            <col :class="$style.statusCol">
            <col :class="$style.operationCol">
          </colgroup>
          <thead>
            <tr>
              <th>{{ $t('flac_conversion__artist_folder') }}</th>
              <th>{{ $t('flac_conversion__source_count') }}</th>
              <th>{{ $t('flac_conversion__output_directory') }}</th>
              <th>{{ $t('flac_conversion__status') }}</th>
              <th>{{ $t('flac_conversion__operation') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in artistRows" :key="row.artist.path">
              <tr>
                <td>
                  <strong :class="$style.artistName" :title="row.artist.path">{{ row.artist.name }}</strong>
                </td>
                <td :class="$style.countCell">
                  <span>{{ row.artist.songCount }}</span>
                  <small>FLAC {{ row.artist.flacCount }} / MP3 {{ row.artist.mp3Count }}</small>
                </td>
                <td>
                  <span :class="$style.outputPath" :title="row.artist.outputDirectory">{{ row.artist.outputDirectory }}</span>
                </td>
                <td>
                  <div :class="[$style.statusText, $style[row.state.status]]">{{ statusText(row.state) }}</div>
                  <div
                    v-if="['preparing', 'running', 'pausing', 'paused'].includes(row.state.status)"
                    :class="$style.progressTrack"
                  >
                    <span :style="{ transform: `scaleX(${progressRatio(row.state)})` }" />
                  </div>
                  <p v-if="row.state.progress?.currentPath" :class="$style.currentPath" :title="row.state.progress.currentPath">
                    {{ row.state.progress.currentPath }}
                  </p>
                </td>
                <td>
                  <div :class="$style.rowActions">
                    <base-btn
                      min
                      :disabled="scanning || operating || !row.artist.songCount"
                      @click="convertArtist(row.artist)"
                    >
                      {{ $t('flac_conversion__convert') }}
                    </base-btn>
                    <base-btn
                      v-if="activeSourceDirectory == row.artist.path && ['running', 'pausing', 'paused'].includes(row.state.status)"
                      min
                      outline
                      @click="togglePause(row.artist)"
                    >
                      {{ ['pausing', 'paused'].includes(row.state.status) ? $t('flac_conversion__resume') : $t('flac_conversion__pause') }}
                    </base-btn>
                  </div>
                </td>
              </tr>
              <tr v-if="row.state.anomalies.length" :class="$style.anomalyRow">
                <td colspan="5">
                  <div :class="$style.anomalyActions">
                    <strong>{{ $t('flac_conversion__anomalies') }}</strong>
                    <base-btn min outline :disabled="scanning || operating || !row.state.retrySourcePaths.length" @click="retryArtistAnomalies(row.artist)">
                      {{ $t('flac_conversion__retry_anomalies') }}
                    </base-btn>
                    <span>{{ $t('flac_conversion__retry_hint') }}</span>
                  </div>
                  <ul class="select">
                    <li v-for="(line, index) in row.state.anomalies" :key="`${row.artist.path}:${String(index)}`">
                      <span>{{ line.message }}</span>
                      <base-btn v-if="line.sourcePath" min outline :title="line.sourcePath" @click="openAnomaly(line)">
                        {{ $t('flac_conversion__open') }}
                      </base-btn>
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
            <tr v-if="!artistRows.length">
              <td colspan="5" :class="$style.emptyTable">
                {{ scanning ? $t('flac_conversion__scanning') : $t('flac_conversion__no_artists') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { useFlacConverter } from './useFlacConverter'

const {
  activeSourceDirectory,
  artistRows,
  capabilityReady,
  convertArtist,
  errorMessage,
  ffmpegAvailable,
  isCustomRootDirectory,
  operating,
  openAnomaly,
  outputParentDirectory,
  progressRatio,
  rootDirectory,
  retryArtistAnomalies,
  scanArtists,
  scanning,
  selectRootDirectory,
  selectOutput,
  statusText,
  supported,
  togglePause,
  useDownloadDirectory,
  useDefaultOutput,
} = useFlacConverter()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 16px;
}

.panel {
  box-sizing: border-box;
  border-radius: @radius-border;
  background: var(--color-content-background);
}

.centerState {
  max-width: 560px;
  margin: 64px auto;
  padding: 24px;
  text-align: center;
}

.centerState h1,
.heading h1 { margin: 0; }

.centerState p,
.heading p { margin: 6px 0 0; }

.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.heading {
  flex: 0 0 auto;
  padding: 18px 20px;
  border-bottom: var(--color-list-header-border-bottom);
}

.heading p { opacity: .68; }

.directoryRow {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  min-height: 34px;
  padding: 8px 20px;
  border-bottom: var(--color-list-header-border-bottom);
}

.directoryLabel {
  flex: 0 0 auto;
  font-weight: 600;
}

.path,
.outputPath,
.artistName,
.currentPath {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path { flex: 1 1 auto; opacity: .72; }

.directoryActions,
.rowActions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.pageError {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 20px;
  color: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 8%, transparent);
}

.tableWrap {
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
  padding: 11px 12px;
  border-bottom: var(--color-list-header-border-bottom);
  text-align: left;
  vertical-align: top;
}

.table th {
  position: sticky;
  z-index: 1;
  top: 0;
  background: var(--color-content-background);
}

.artistCol { width: 18%; }
.countCol { width: 11%; }
.outputCol { width: 27%; }
.statusCol { width: 29%; }
.operationCol { width: 15%; }

.countCell span,
.countCell small { display: block; }
.countCell small { margin-top: 3px; opacity: .62; }

.statusText { font-weight: 600; }
.idle { opacity: .62; }
.preparing,
.running,
.pausing { color: var(--color-theme); }
.paused { color: var(--color-yellow); }
.completed { color: var(--color-green); }
.anomaly,
.failed,
.error { color: var(--color-red); }

.progressTrack {
  height: 4px;
  margin-top: 7px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--color-primary-background-hover);
}

.progressTrack span {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  transition: transform .2s ease;
  background: var(--color-theme);
}

.currentPath {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: .68;
}

.anomalyRow td {
  padding: 10px 18px 14px;
  color: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 6%, transparent);
}

.anomalyRow ul {
  max-height: 180px;
  margin: 8px 0 0;
  padding-left: 22px;
  overflow: auto;
}

.anomalyActions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.anomalyRow li {
  padding-bottom: 6px;

  button { margin-left: 8px; }
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.emptyTable {
  padding: 36px 12px !important;
  text-align: center !important;
  opacity: .62;
}

@media (max-width: 900px) {
  .directoryRow,
  .directoryActions,
  .rowActions {
    align-items: stretch;
    flex-direction: column;
  }

  .table { min-width: 920px; }
}
</style>
