import { describe, expect, it } from 'vitest'
import { AppExitCoordinator } from '../appExitCoordinator'

describe('application exit coordination', () => {
  it('cancels one active FLAC conversion and resumes one of concurrent close requests', async() => {
    let conversionBusy = true
    let cancelCount = 0
    let continueCount = 0
    let resolveCancellation!: () => void
    let resolveContinued!: () => void
    const cancellationMayFinish = new Promise<void>(resolve => { resolveCancellation = resolve })
    const continued = new Promise<void>(resolve => { resolveContinued = resolve })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => conversionBusy,
      cancelFlacConversion: async() => {
        cancelCount++
        await cancellationMayFinish
        conversionBusy = false
      },
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => {
      continueCount++
      resolveContinued()
    })).toBe(false)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(cancelCount).toBe(1)
    expect(continueCount).toBe(0)

    resolveCancellation()
    await continued

    expect(continueCount).toBe(1)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(true)
    expect(continueCount).toBe(1)
  })

  it('keeps cleanup or rename protected and shows only one warning for concurrent close requests', async() => {
    let organizerBusy = true
    let warningCount = 0
    let flacCancelCount = 0
    let continueCount = 0
    let resolveContinued!: () => void
    const continued = new Promise<void>(resolve => { resolveContinued = resolve })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => organizerBusy,
      isFlacConversionRunning: () => true,
      cancelFlacConversion: async() => { flacCancelCount++ },
      showOrganizerBusyWarning: async() => {
        warningCount++
        await Promise.resolve()
      },
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    await Promise.resolve()

    expect(warningCount).toBe(1)
    expect(flacCancelCount).toBe(0)
    expect(continueCount).toBe(0)

    organizerBusy = false
    expect(coordinator.requestExit(() => {
      continueCount++
      resolveContinued()
    })).toBe(false)
    await continued
    expect(flacCancelCount).toBe(1)
    expect(continueCount).toBe(1)
  })

  it('blocks exit for quick scan or check without cancelling the organizer read task', async() => {
    let readBusy = true
    let continueCount = 0
    let warningCount = 0
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => readBusy,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => false,
      cancelFlacConversion: async() => {},
      showOrganizerBusyWarning: async() => { warningCount++ },
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    await Promise.resolve()

    expect(continueCount).toBe(0)
    expect(warningCount).toBe(1)

    readBusy = false
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(true)
    expect(continueCount).toBe(0)
  })

  it('rechecks organizer read protection after cancellable work settles', async() => {
    let organizerReadBusy = false
    let conversionBusy = true
    let warningCount = 0
    let continueCount = 0
    let resolveConversionCancellation!: () => void
    let resolveWarningShown!: () => void
    const cancellationMayFinish = new Promise<void>(resolve => { resolveConversionCancellation = resolve })
    const warningShown = new Promise<void>(resolve => { resolveWarningShown = resolve })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => organizerReadBusy,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => conversionBusy,
      cancelFlacConversion: async() => {
        await cancellationMayFinish
        conversionBusy = false
      },
      showOrganizerBusyWarning: async() => {
        warningCount++
        resolveWarningShown()
      },
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    organizerReadBusy = true
    resolveConversionCancellation()
    await warningShown

    expect(continueCount).toBe(0)
    expect(warningCount).toBe(1)
    organizerReadBusy = false
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(true)
  })

  it('keeps exit blocked after process termination cannot be confirmed', async() => {
    let conversionBusy = true
    let continueCount = 0
    let failureWarningCount = 0
    let resolveReported!: () => void
    const reported = new Promise<void>(resolve => { resolveReported = resolve })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => conversionBusy,
      cancelFlacConversion: async() => {
        conversionBusy = false
        throw new Error('无法确认 FFmpeg 已退出。')
      },
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => {
        failureWarningCount++
      },
      reportError: () => { resolveReported() },
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    await reported

    expect(continueCount).toBe(0)
    expect(failureWarningCount).toBe(1)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(continueCount).toBe(0)
  })

  it('keeps a prior exit failure sticky when later cancellable work can stop successfully', async() => {
    let conversionBusy = true
    let cancellationShouldFail = true
    let cancelCount = 0
    let continueCount = 0
    let failureWarningCount = 0
    let resolveFirstFailure!: () => void
    const firstFailure = new Promise<void>(resolve => { resolveFirstFailure = resolve })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => conversionBusy,
      cancelFlacConversion: async() => {
        cancelCount++
        conversionBusy = false
        if (cancellationShouldFail) throw new Error('FFmpeg still running')
      },
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => {
        failureWarningCount++
      },
      reportError: () => { resolveFirstFailure() },
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    await firstFailure
    cancellationShouldFail = false
    conversionBusy = true

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(cancelCount).toBe(1)
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })

    expect(continueCount).toBe(0)
    expect(failureWarningCount).toBeGreaterThanOrEqual(1)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    expect(continueCount).toBe(0)
  })

  it('blocks a later exit when a completed service retains an unconfirmed termination failure', async() => {
    const terminationFailure = new Error('previous FFmpeg termination was not confirmed')
    let continueCount = 0
    let failureWarningCount = 0
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => terminationFailure,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => false,
      cancelFlacConversion: async() => {},
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => { failureWarningCount++ },
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
    await Promise.resolve()

    expect(continueCount).toBe(0)
    expect(failureWarningCount).toBe(1)
    expect(coordinator.requestExit(() => { continueCount++ })).toBe(false)
  })
})
