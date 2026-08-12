import { describe, expect, it } from 'vitest'
import { executeKgWithRetry } from './artistDiscographyRetry'

describe('KuGou retry executor', () => {
  it('returns the third result after two retryable failures', async() => {
    let attempts = 0

    const result = await executeKgWithRetry({
      maxAttempts: 3,
      execute: async() => {
        attempts++
        if (attempts < 3) throw new Error('retryable fixture failure')
        return 'ok'
      },
      shouldRetry: () => true,
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry a non-retryable failure', async() => {
    const failure = new Error('non-retryable fixture failure')
    let attempts = 0

    const task = executeKgWithRetry({
      maxAttempts: 3,
      execute: async() => {
        attempts++
        throw failure
      },
      shouldRetry: () => false,
    })

    await expect(task).rejects.toBe(failure)
    expect(attempts).toBe(1)
  })

  it('does not retry after AbortSignal is aborted', async() => {
    const controller = new AbortController()
    let attempts = 0

    const task = executeKgWithRetry({
      maxAttempts: 3,
      signal: controller.signal,
      execute: async() => {
        attempts++
        controller.abort()
        throw new Error('cancelled fixture failure')
      },
      shouldRetry: () => true,
    })

    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(attempts).toBe(1)
  })
})
