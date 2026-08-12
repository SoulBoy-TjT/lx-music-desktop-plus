export interface PauseGateState {
  pauseRequested: boolean
  paused: boolean
}

export class FlacConversionPauseGate {
  private pauseRequested = false
  private paused = false
  private resume?: () => void

  state(): PauseGateState {
    return { pauseRequested: this.pauseRequested, paused: this.paused }
  }

  request(paused: boolean): PauseGateState {
    this.pauseRequested = paused
    if (!paused) {
      const resume = this.resume
      this.resume = undefined
      resume?.()
    }
    return this.state()
  }

  async waitIfPaused(onPaused: () => void): Promise<void> {
    if (!this.pauseRequested) return
    this.paused = true
    onPaused()
    await new Promise<void>(resolve => { this.resume = resolve })
    this.paused = false
  }

  reset(): void {
    this.pauseRequested = false
    this.paused = false
    const resume = this.resume
    this.resume = undefined
    resume?.()
  }
}
