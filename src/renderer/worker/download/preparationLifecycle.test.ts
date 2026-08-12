import * as Comlink from 'comlink'
import { describe, expect, it } from 'vitest'
import { createDownloadPreparationLifecycleProxy } from '@renderer/store/download/downloadActionSeams'
import { proxyCallback } from '@renderer/worker/utils'

describe('download Worker preparation lifecycle transport', () => {
  it('sends the lifecycle through the real Comlink argument serialization boundary', async() => {
    const cloneAccepted = new Error('clone accepted')
    const endpoint = {
      addEventListener() {},
      removeEventListener() {},
      postMessage(message: unknown, transferables: Transferable[] = []) {
        const cloned = structuredClone(message, { transfer: transferables }) as {
          argumentList?: Array<{ type?: string, name?: string, value?: MessagePort }>
        }
        for (const argument of cloned.argumentList ?? []) argument.value?.close?.()
        throw cloneAccepted
      },
    }
    const worker = Comlink.wrap<{ startTask: (...args: unknown[]) => Promise<void> }>(endpoint)
    const lifecycle = createDownloadPreparationLifecycleProxy({
      beginTask: async() => ({ status: 'active' }),
      isTaskCancelled: async() => false,
      finishTask: async() => {},
    })

    await expect(worker.startTask(
      {},
      '',
      false,
      proxyCallback(async() => {}),
      undefined,
      proxyCallback(async() => ({ status: 'valid' })),
      lifecycle,
    )).rejects.toBe(cloneAccepted)
  })
})
