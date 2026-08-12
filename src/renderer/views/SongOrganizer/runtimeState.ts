import type { SongOrganizerRuntimeState } from '@common/songOrganizer'

export type SongOrganizerRuntimeDecision = 'preserve_operation' | 'wait_for_main' | 'attach' | 'adopt'

export const normalizeSongOrganizerRoot = (value: string): string => value
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLocaleLowerCase('en-US')

export const shouldApplySongOrganizerRuntimeState = (appliedRevision: number, state: SongOrganizerRuntimeState): boolean => state.revision > appliedRevision

export const latestSongOrganizerRuntimeState = (
  ...states: Array<SongOrganizerRuntimeState | undefined>
): SongOrganizerRuntimeState | undefined => states.reduce<SongOrganizerRuntimeState | undefined>((latest, state) => {
  if (!state || (latest && latest.revision >= state.revision)) return latest
  return state
}, undefined)

export const reconcileSongOrganizerRuntimeState = (
  currentRoot: string,
  state: SongOrganizerRuntimeState,
  operationActive = false,
): SongOrganizerRuntimeDecision => {
  const normalizedRoot = normalizeSongOrganizerRoot(currentRoot)
  const runtimeRoot = normalizeSongOrganizerRoot(state.root ?? state.snapshot?.root ?? '')
  if (state.status == 'idle') {
    if (operationActive && normalizedRoot && normalizedRoot == runtimeRoot) return 'preserve_operation'
    return 'wait_for_main'
  }
  if (!normalizedRoot || normalizedRoot != runtimeRoot) return 'wait_for_main'
  if (state.status == 'scanning') return 'attach'
  if (state.status == 'complete' && (!state.snapshot || normalizeSongOrganizerRoot(state.snapshot.root) != normalizedRoot)) return 'wait_for_main'
  return 'adopt'
}
