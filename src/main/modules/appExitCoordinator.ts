export interface AppExitCoordinatorDependencies {
  isReadOperationRunning: () => boolean
  getTerminationFailure: () => unknown | undefined
  isOrganizerMutationRunning: () => boolean
  isFlacConversionRunning: () => boolean
  cancelFlacConversion: () => Promise<void>
  beginDownloadValidationShutdown?: () => void
  endDownloadValidationShutdown?: () => void
  isDownloadValidationRunning?: () => boolean
  cancelDownloadValidation?: () => Promise<void>
  showOrganizerBusyWarning: () => Promise<void>
  showExitFailureWarning: (error: unknown) => Promise<void>
  reportError: (error: unknown) => void
}

export class AppExitCoordinator {
  private pendingExit?: Promise<void>
  private warningPending?: Promise<void>
  private failureWarningPending?: Promise<void>
  private exitFailure?: unknown
  private continueExit?: () => void

  constructor(private readonly dependencies: AppExitCoordinatorDependencies) {}

  requestExit(continueExit: () => void): boolean {
    if (this.isOrganizerRunning()) {
      this.showOrganizerBusyWarning()
      return false
    }
    this.exitFailure ??= this.dependencies.getTerminationFailure()
    if (this.exitFailure) {
      this.showExitFailureWarning(this.exitFailure)
      return false
    }
    this.dependencies.beginDownloadValidationShutdown?.()
    const readOperationRunning = this.dependencies.isReadOperationRunning()
    const flacConversionRunning = this.dependencies.isFlacConversionRunning()
    const downloadValidationRunning = this.dependencies.isDownloadValidationRunning?.() ?? false
    if (!readOperationRunning && !flacConversionRunning && !downloadValidationRunning && !this.pendingExit) return true
    if (!this.pendingExit) {
      this.continueExit = continueExit
      this.pendingExit = this.cancelAndContinue()
    }
    return false
  }

  private showOrganizerBusyWarning(): void {
    if (this.warningPending) return
    this.warningPending = this.dependencies.showOrganizerBusyWarning()
      .catch(error => { this.dependencies.reportError(error) })
      .finally(() => { this.warningPending = undefined })
  }

  private showExitFailureWarning(error: unknown): void {
    if (this.failureWarningPending) return
    this.failureWarningPending = this.dependencies.showExitFailureWarning(error)
      .catch(warningError => { this.dependencies.reportError(warningError) })
      .finally(() => { this.failureWarningPending = undefined })
  }

  private async cancelAndContinue(): Promise<void> {
    try {
      await Promise.all([
        this.dependencies.cancelFlacConversion(),
        this.dependencies.cancelDownloadValidation?.() ?? Promise.resolve(),
      ])
      const continueExit = this.continueExit
      this.continueExit = undefined
      this.pendingExit = undefined
      if (this.isOrganizerRunning()) {
        this.dependencies.endDownloadValidationShutdown?.()
        this.showOrganizerBusyWarning()
        return
      }
      continueExit?.()
    } catch (error) {
      this.exitFailure = error
      this.dependencies.reportError(error)
      this.showExitFailureWarning(error)
      this.continueExit = undefined
      this.pendingExit = undefined
    }
  }

  private isOrganizerRunning(): boolean {
    return this.dependencies.isReadOperationRunning() || this.dependencies.isOrganizerMutationRunning()
  }
}
