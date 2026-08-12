<template>
  <material-modal
    :show="show"
    width="720px"
    max-width="88%"
    max-height="82%"
    @close="handleCancel"
  >
    <article :class="$style.main" role="dialog" aria-modal="true" :aria-label="title">
      <header :class="$style.heading">
        <h2>{{ title }}</h2>
      </header>
      <ul class="scroll select" :class="$style.lines">
        <li v-for="(line, index) in lines" :key="`${String(index)}:${String(line)}`">{{ line }}</li>
      </ul>
      <footer :class="$style.footer">
        <base-btn v-if="confirmation" min outline @click="handleCancel">{{ cancelButtonText }}</base-btn>
        <base-btn min @click="handleConfirm">{{ confirmation ? confirmButtonText : closeButtonText }}</base-btn>
      </footer>
    </article>
  </material-modal>
</template>

<script setup lang="ts">
defineProps<{
  show: boolean
  title: string
  lines: string[]
  confirmation: boolean
  confirmButtonText: string
  cancelButtonText: string
  closeButtonText: string
}>()

const emit = defineEmits<{
  (event: 'confirm'): void
  (event: 'cancel'): void
}>()

const handleConfirm = () => { emit('confirm') }
const handleCancel = () => { emit('cancel') }
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: calc(82vh - 18px);
}

.heading {
  flex: 0 0 auto;
  padding: 10px 18px 12px;
  border-bottom: var(--color-list-header-border-bottom);
}

.heading h2 { margin: 0; font-size: 16px; }

.lines {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-height: 96px;
  margin: 0;
  padding: 14px 24px 14px 38px;
  overflow: auto;
}

.lines li {
  line-height: 1.55;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.lines li + li { margin-top: 6px; }

.footer {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: var(--color-list-header-border-bottom);
}
</style>
