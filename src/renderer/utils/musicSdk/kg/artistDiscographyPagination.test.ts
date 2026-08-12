import { describe, expect, it } from 'vitest'
import {
  collectKgPaginated,
  type KgPaginationPage,
} from './artistDiscographyPagination'

interface FixtureItem {
  id: string
}

const page = (
  ids: string[],
  reportedTotal: number | null,
): KgPaginationPage<FixtureItem> => ({
  items: ids.map(id => ({ id })),
  reportedTotal,
  rawItemCount: ids.length,
  pageKeys: ids,
  validResponse: true,
  issues: [],
})

const collect = async(
  fetchPage: (pageNumber: number) => Promise<KgPaginationPage<FixtureItem>>,
  signal?: AbortSignal,
) => await collectKgPaginated({
  stage: 'albums',
  artistId: '3060',
  limit: 100,
  maxPages: 10,
  signal,
  fetchPage,
  mapPage: raw => raw as KgPaginationPage<FixtureItem>,
  getItemId: item => item.id,
  duplicateCode: 'duplicate_album',
})

describe('KuGou pagination', () => {
  it('continues short provider-capped pages until raw progress reaches total', async() => {
    const pages = [page(['1', '2'], 5), page(['3', '4'], 5), page(['5'], 5)]
    const requested: number[] = []

    const result = await collect(async pageNumber => {
      requested.push(pageNumber)
      return pages[pageNumber - 1]
    })

    expect(requested).toEqual([1, 2, 3])
    expect(result.items.map(item => item.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(result).toMatchObject({ reportedTotal: 5, complete: true, issues: [] })
  })

  it('marks changing totals partial while retaining collected items', async() => {
    const pages = [page(['1', '2'], 5), page(['3', '4'], 6), page(['5'], 6)]
    let requests = 0

    const result = await collect(async pageNumber => {
      requests++
      return pages[pageNumber - 1]
    })

    expect(requests).toBe(3)
    expect(result.items).toHaveLength(5)
    expect(result.complete).toBe(false)
    expect(result.issues.some(issue => issue.code == 'pagination_inconsistent')).toBe(true)
  })

  it('stops partial on an empty page before total is reached', async() => {
    const pages = [page(['1', '2'], 5), page([], 5)]
    let requests = 0

    const result = await collect(async pageNumber => {
      requests++
      return pages[pageNumber - 1]
    })

    expect(requests).toBe(2)
    expect(result.items.map(item => item.id)).toEqual(['1', '2'])
    expect(result.complete).toBe(false)
    expect(result.issues.some(issue => issue.message.includes('empty page'))).toBe(true)
  })

  it('stops partial when the provider repeats a page', async() => {
    const repeated = page(['1', '2'], 5)
    let requests = 0

    const result = await collect(async() => {
      requests++
      return repeated
    })

    expect(requests).toBe(2)
    expect(result.items.map(item => item.id)).toEqual(['1', '2'])
    expect(result.complete).toBe(false)
    expect(result.issues.some(issue => issue.message.includes('same catalog page'))).toBe(true)
  })

  it('returns the collected prefix as partial when a page request fails', async() => {
    let requests = 0

    const result = await collect(async pageNumber => {
      requests++
      if (pageNumber == 2) throw new Error('fixture failure')
      return page(['1', '2'], 5)
    })

    expect(requests).toBe(2)
    expect(result.items.map(item => item.id)).toEqual(['1', '2'])
    expect(result.complete).toBe(false)
    expect(result.issues.some(issue => issue.code == 'provider_unavailable')).toBe(true)
  })

  it('does not request another page after cancellation', async() => {
    const controller = new AbortController()
    let requests = 0

    const task = collect(async() => {
      requests++
      controller.abort()
      return page(['1', '2'], 5)
    }, controller.signal)

    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(1)
  })
})
