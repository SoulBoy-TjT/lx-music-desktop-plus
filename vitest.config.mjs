import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolvePath = target => fileURLToPath(new URL(target, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@common': resolvePath('src/common'),
      '@renderer': resolvePath('src/renderer'),
      '@root': resolvePath('src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/renderer/core/artistDiscography/**/*.test.ts',
      'src/renderer/views/Tools/**/*.test.ts',
      'src/renderer/components/common/downloadQuality.test.ts',
      'src/renderer/utils/musicSdk/{kg,kw,tx,wy}/**/*.test.ts',
      'src/common/utils/downloadTarget/**/*.test.ts',
      'src/common/utils/migrateSetting.test.ts',
      'src/renderer/worker/download/**/*.test.ts',
      'src/main/modules/flacConverter/**/*.test.ts',
      'src/main/modules/songOrganizer/**/*.test.ts',
      'src/renderer/views/SongOrganizer/**/*.test.ts',
      'src/renderer/views/FlacConverter/**/*.test.ts',
    ],
  },
})
