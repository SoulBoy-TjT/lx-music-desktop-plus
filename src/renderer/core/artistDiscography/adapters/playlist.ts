import {
  addListMusics,
  createUserList,
  removeUserList,
} from '@renderer/store/list/action'
import type { PlaylistPort } from '../types'

export const createLocalPlaylistAdapter = (): PlaylistPort => ({
  async create(id, name) {
    await createUserList({ id, name })
  },
  async add(id, tracks) {
    await addListMusics(id, tracks)
  },
  async remove(id) {
    await removeUserList([id])
  },
})

export default createLocalPlaylistAdapter
