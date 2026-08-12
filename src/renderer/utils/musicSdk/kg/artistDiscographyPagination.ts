import type {
  CatalogCollection,
  DiscographyIssue,
  DiscographyIssueStage,
} from '@renderer/core/artistDiscography/types'

export interface KgPaginationPage<T> {
  items: T[]
  reportedTotal: number | null
  rawItemCount: number
  pageKeys: string[]
  validResponse: boolean
  issues: DiscographyIssue[]
}

export interface KgPaginationOptions<T> {
  stage: DiscographyIssueStage
  artistId?: string
  albumId?: string
  limit: number
  maxPages?: number
  signal?: AbortSignal
  fetchPage: (page: number) => Promise<unknown>
  mapPage: (raw: unknown) => Promise<KgPaginationPage<T>> | KgPaginationPage<T>
  getItemId: (item: T) => string
  duplicateCode: 'duplicate_album' | 'duplicate_track'
  normalizePageError?: (error: unknown) => DiscographyIssue
}

const DEFAULT_MAX_PAGES = 1000

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssueStage,
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity'>> = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: 'error',
  ...details,
})

const createAbortError = () => {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw createAbortError()
}

const isAbortError = (error: unknown) => {
  return error instanceof Error && error.name == 'AbortError'
}

const defaultPageError = (
  stage: DiscographyIssueStage,
  artistId?: string,
  albumId?: string,
) => createIssue(
  'provider_unavailable',
  stage,
  'KuGou is temporarily unavailable while collecting the catalog.',
  { artistId, albumId, retryable: true },
)

export const collectKgPaginated = async<T>(
  options: KgPaginationOptions<T>,
): Promise<CatalogCollection<T>> => {
  const items: T[] = []
  const issues: DiscographyIssue[] = []
  const seenItemIds = new Set<string>()
  const seenPageSignatures = new Set<string>()
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  let reportedTotal: number | null = null
  let rawProgress = 0
  let complete = true
  let stopped = false

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    throwIfAborted(options.signal)
    let mappedPage: KgPaginationPage<T>
    try {
      mappedPage = await options.mapPage(await options.fetchPage(pageNumber))
      throwIfAborted(options.signal)
    } catch (error) {
      if (options.signal?.aborted == true || isAbortError(error)) throw createAbortError()
      complete = false
      issues.push(options.normalizePageError?.(error) ?? defaultPageError(
        options.stage,
        options.artistId,
        options.albumId,
      ))
      stopped = true
      break
    }

    issues.push(...mappedPage.issues)
    if (mappedPage.issues.some(issue => issue.severity == 'error')) complete = false
    if (!mappedPage.validResponse) {
      complete = false
      stopped = true
      break
    }

    if (mappedPage.reportedTotal != null) {
      if (reportedTotal == null) reportedTotal = mappedPage.reportedTotal
      else if (reportedTotal != mappedPage.reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          options.stage,
          'KuGou changed the reported total while paging the catalog.',
          {
            artistId: options.artistId,
            albumId: options.albumId,
            expected: reportedTotal,
            actual: mappedPage.reportedTotal,
            retryable: true,
          },
        ))
      }
    }

    const pageSignature = `${mappedPage.rawItemCount}:${mappedPage.pageKeys.join('|')}`
    if (mappedPage.rawItemCount > 0 && seenPageSignatures.has(pageSignature)) {
      complete = false
      issues.push(createIssue(
        'pagination_inconsistent',
        options.stage,
        'KuGou returned the same catalog page more than once.',
        { artistId: options.artistId, albumId: options.albumId, retryable: true },
      ))
      stopped = true
      break
    }
    if (mappedPage.rawItemCount > 0) seenPageSignatures.add(pageSignature)

    rawProgress += mappedPage.rawItemCount
    for (const item of mappedPage.items) {
      const itemId = options.getItemId(item)
      if (seenItemIds.has(itemId)) {
        complete = false
        issues.push(createIssue(
          options.duplicateCode,
          options.stage,
          'KuGou returned the same stable ID more than once while paging.',
          {
            artistId: options.artistId,
            albumId: options.albumId ?? (options.duplicateCode == 'duplicate_album' ? itemId : undefined),
            trackId: options.duplicateCode == 'duplicate_track' ? itemId : undefined,
          },
        ))
        continue
      }
      seenItemIds.add(itemId)
      items.push(item)
    }

    if (mappedPage.rawItemCount == 0) {
      if (reportedTotal != null && rawProgress < reportedTotal) {
        complete = false
        issues.push(createIssue(
          'pagination_inconsistent',
          options.stage,
          'KuGou returned an empty page before the reported total was reached.',
          {
            artistId: options.artistId,
            albumId: options.albumId,
            expected: reportedTotal,
            actual: rawProgress,
            retryable: true,
          },
        ))
      }
      stopped = true
      break
    }

    if (reportedTotal != null) {
      if (rawProgress >= reportedTotal) {
        if (rawProgress > reportedTotal) {
          complete = false
          issues.push(createIssue(
            'pagination_inconsistent',
            options.stage,
            'KuGou returned more raw items than its reported total.',
            {
              artistId: options.artistId,
              albumId: options.albumId,
              expected: reportedTotal,
              actual: rawProgress,
              retryable: true,
            },
          ))
        }
        stopped = true
        break
      }
      continue
    }

    if (mappedPage.rawItemCount < options.limit) {
      stopped = true
      break
    }
  }

  if (!stopped) {
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      options.stage,
      'KuGou pagination exceeded the safety limit.',
      { artistId: options.artistId, albumId: options.albumId, retryable: true },
    ))
  }
  if (reportedTotal != null && items.length != reportedTotal) {
    complete = false
    if (!issues.some(issue =>
      issue.code == 'pagination_inconsistent' &&
      issue.expected == reportedTotal &&
      issue.actual == items.length,
    )) {
      issues.push(createIssue(
        'pagination_inconsistent',
        options.stage,
        'KuGou reported total does not match the unique collected item count.',
        {
          artistId: options.artistId,
          albumId: options.albumId,
          expected: reportedTotal,
          actual: items.length,
          retryable: true,
        },
      ))
    }
  }

  return { items, reportedTotal, complete, issues }
}
