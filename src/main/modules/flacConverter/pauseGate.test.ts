import { describe, expect, it } from 'vitest'
import { FlacConversionPauseGate } from './pauseGate'

describe('FLAC conversion pause gate', () => {
  it('waits at an item boundary until resume is requested', async() => {
    const gate = new FlacConversionPauseGate()
    gate.request(true)
    let passed = false
    const waiting = gate.waitIfPaused(() => {
      expect(gate.state()).toEqual({ pauseRequested: true, paused: true })
    }).then(() => { passed = true })

    await Promise.resolve()
    expect(passed).toBe(false)
    gate.request(false)
    await waiting

    expect(passed).toBe(true)
    expect(gate.state()).toEqual({ pauseRequested: false, paused: false })
  })

  it('reset releases a paused waiter', async() => {
    const gate = new FlacConversionPauseGate()
    gate.request(true)
    const waiting = gate.waitIfPaused(() => {})

    gate.reset()
    await waiting

    expect(gate.state()).toEqual({ pauseRequested: false, paused: false })
  })
})
