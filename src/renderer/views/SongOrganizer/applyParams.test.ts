import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { createSongOrganizerApplyParams } from './applyParams'

describe('song organizer apply params', () => {
  it('copies reactive artist paths into a structured-cloneable array', () => {
    const artistPaths = ref(['C:/Music/Artist'])
    const params = createSongOrganizerApplyParams('task-id', artistPaths.value, 'C:/Music/Artist/song.mp3')

    expect(params.artistPaths).not.toBe(artistPaths.value)
    expect(() => structuredClone(params)).not.toThrow()
  })
})
