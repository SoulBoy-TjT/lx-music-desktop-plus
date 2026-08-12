export interface KgRetryOptions<T> {
  maxAttempts: number
  signal?: AbortSignal
  execute: (attempt: number) => Promise<T>
  shouldRetry: (error: unknown, attempt: number) => boolean
}

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

export const executeKgWithRetry = async<T>(options: KgRetryOptions<T>): Promise<T> => {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer.')
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    throwIfAborted(options.signal)
    try {
      const result = await options.execute(attempt)
      throwIfAborted(options.signal)
      return result
    } catch (error) {
      if (options.signal?.aborted == true || isAbortError(error)) throw createAbortError()
      if (attempt == options.maxAttempts || !options.shouldRetry(error, attempt)) throw error
    }
  }

  throw new Error('Unreachable retry state.')
}
