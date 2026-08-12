import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitProviderSettlement } from '@renderer/store/download/providerDeadline'

afterEach(() => {
  vi.useRealTimers()
})

describe('download provider deadline', () => {
  it('rejects a hanging provider at the deadline without waiting for it to settle', async() => {
    vi.useFakeTimers()
    let resolveProvider!: (value: string) => void
    const provider = new Promise<string>(resolve => {
      resolveProvider = resolve
    })
    const result = awaitProviderSettlement(provider, 20, 'lyrics')
    let settled = false
    void result.then(() => {
      settled = true
    }, () => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(21)
    expect(settled).toBe(true)
    await expect(result).rejects.toThrow('lyrics exceeded 20 ms')
    resolveProvider('late result')
    await vi.runAllTimersAsync()
  })

  it('returns a provider result that settles within the deadline', async() => {
    await expect(awaitProviderSettlement(Promise.resolve('ok'), 20, 'lyrics')).resolves.toBe('ok')
  })
})
