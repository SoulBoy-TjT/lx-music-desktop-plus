<template lang="pug">
dt#version {{ $t('setting__version') }}
dd
  .gap-top
    .p.small(@click="handleOpenDevTools") {{ $t('setting__version_current_label') }}{{ version }}
    .p.small(v-if="commit_id")
      | {{ $t('setting__version_commit_id') }}
      span.select {{ commit_id }}
    .p.small(v-if="commit_date") {{ $t('setting__version_commit_date') }}{{ commit_date }}
</template>

<script>
import { dateFormat } from '@common/utils/common'
import { openDevTools } from '@renderer/utils/ipc'

export default {
  name: 'SettingUpdate',
  setup() {
    let lastClickTime = 0
    let clickNum = 0
    const commit_id = COMMIT_ID
    const commit_date = dateFormat(COMMIT_DATE)

    const handleOpenDevTools = () => {
      if (window.performance.now() - lastClickTime > 1000) {
        if (clickNum > 0) clickNum = 0
      } else {
        if (clickNum > 4) {
          openDevTools()
          clickNum = 0
          return
        }
      }
      clickNum++
      lastClickTime = window.performance.now()
    }

    return { version: process.versions.app, handleOpenDevTools, commit_id, commit_date }
  },
}
</script>
