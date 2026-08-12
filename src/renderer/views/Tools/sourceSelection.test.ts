import { describe, expect, it } from 'vitest'
import type {
  ArtistDiscographySource,
  DiscographyBatchPlan,
  DiscographyPlan,
} from '@renderer/core/artistDiscography'
import {
  canGenerateDiscographyPlaylist,
  createDiscographyGenerateSelection,
  createDiscographySourceSelection,
  getSelectedDiscographySources,
} from './sourceSelection'

const makePlan = (
  source: ArtistDiscographySource,
  status: DiscographyPlan['status'] = 'complete',
  trackCount = 1,
): DiscographyPlan => ({
  source,
  status,
  artist: { source, id: `${source}-artist`, name: 'Artist', avatar: null, albumCount: 1 },
  expectedAlbumCount: 1,
  actualAlbumCount: 1,
  albums: [{
    album: {
      source,
      id: `${source}-album`,
      name: 'Album',
      artist: 'Artist',
      releaseDate: null,
      image: null,
      expectedTrackCount: trackCount,
    },
    status: 'complete',
    tracks: [],
    expectedCount: trackCount,
    actualCount: trackCount,
    issues: [],
  }],
  tracks: [],
  deduplications: [],
  rawTrackCount: trackCount,
  deduplicatedTrackCount: trackCount,
  canApply: status == 'complete' || status == 'partial',
  fetchedAt: 1,
  issues: [],
})

describe('discography source selection', () => {
  it('selects all four platforms by default and preserves canonical order', () => {
    const selection = createDiscographySourceSelection()

    expect(selection).toEqual({ kg: true, tx: true, wy: true, kw: true })
    expect(getSelectedDiscographySources(selection)).toEqual(['kg', 'tx', 'wy', 'kw'])
  })

  it('returns only selected sources that belong to the current batch', () => {
    const selection = createDiscographySourceSelection(['kg', 'wy', 'kw'])

    expect(getSelectedDiscographySources(selection, ['tx', 'wy'])).toEqual(['wy'])
  })

  it('defaults generation to every usable fetched source and excludes blocked results', () => {
    const plans: DiscographyBatchPlan['plans'] = {
      kg: makePlan('kg', 'complete'),
      tx: makePlan('tx', 'partial'),
      wy: makePlan('wy', 'failed'),
    }
    const batch: DiscographyBatchPlan = {
      batchId: 'batch-1',
      artistName: 'Artist',
      sources: ['kg', 'tx', 'wy'],
      plans,
      status: 'blocked',
      fetchedAt: 1,
      canApply: true,
    }

    expect(canGenerateDiscographyPlaylist(plans.kg)).toBe(true)
    expect(canGenerateDiscographyPlaylist(plans.wy)).toBe(false)
    expect(createDiscographyGenerateSelection(batch)).toEqual({ kg: true, tx: true, wy: false, kw: false })
  })
})
