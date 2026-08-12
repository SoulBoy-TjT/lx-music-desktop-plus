<template>
  <material-modal :show="show" :bg-close="bgClose" :teleport="teleport" @close="handleClose">
    <main :class="$style.main">
      <h2>{{ $t('download__multiple_tip', { len: list.length }) }}<br>{{ $t('download__multiple_tip2') }}</h2>
      <base-btn
        v-for="option in qualityOptions" :key="option.quality" :class="$style.btn"
        :disabled="!option.state.available" @click="handleClick(option.quality)"
      >
        <span>{{ option.label }}</span>
        <small v-if="option.state.reason" :class="$style.reason">{{ getQualityHint(option.state.reason) }}</small>
      </base-btn>
    </main>
  </material-modal>
</template>

<script>
import { qualityList } from '@renderer/store'
import { createDownloadTasks } from '@renderer/store/download/action'
import { getBatchDownloadQualityState } from './downloadQuality'

export default {
  props: {
    show: {
      type: Boolean,
      default: false,
    },
    bgClose: {
      type: Boolean,
      default: true,
    },
    listId: {
      type: String,
      default: '',
    },
    list: {
      type: Array,
      default() {
        return []
      },
    },
    teleport: {
      type: String,
      default: '#root',
    },
  },
  emits: ['update:show', 'confirm'],
  setup() {
    return {
      qualityList,
    }
  },
  computed: {
    qualityOptions() {
      return [
        { quality: '128k', label: `${this.$t('download__normal')} - 128K` },
        { quality: '320k', label: `${this.$t('download__high_quality')} - 320K` },
        { quality: 'flac', label: `${this.$t('download__lossless')} - FLAC` },
        { quality: 'flac24bit', label: `${this.$t('download__lossless')} - FLAC Hires` },
      ].map(option => ({
        ...option,
        state: getBatchDownloadQualityState(this.list, option.quality, this.qualityList),
      }))
    },
  },
  methods: {
    handleClick(quality) {
      const option = this.qualityOptions.find(option => option.quality == quality)
      if (!option?.state.available) return
      void createDownloadTasks(this.list.filter(item => item.source != 'local'), quality, this.listId)
      this.handleClose()
      this.$emit('confirm')
    },
    handleClose() {
      this.$emit('update:show', false)
    },
    getQualityHint(reason) {
      switch (reason) {
        case 'no_online_tracks': return this.$t('download__multiple_no_online_tracks')
        case 'source_unsupported': return this.$t('download__multiple_source_unsupported')
        case 'track_unsupported': return this.$t('download__multiple_track_unsupported')
        case 'track_fallback': return this.$t('download__multiple_track_fallback')
      }
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 15px;
  max-width: 400px;
  min-width: 200px;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  h2 {
    font-size: 13px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
    margin-bottom: 15px;
  }
}

.btn {
  display: block;
  margin-bottom: 15px;
  .reason {
    display: block;
    margin-top: 3px;
    font-size: 11px;
    font-weight: normal;
  }
  &:last-child {
    margin-bottom: 0;
  }
}

</style>
