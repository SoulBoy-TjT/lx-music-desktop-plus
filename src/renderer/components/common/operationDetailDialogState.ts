export interface OperationDetailDialogContent {
  title: string
  lines: string[]
  confirmation: boolean
}

export interface OperationDetailDialogView {
  setContent: (content: OperationDetailDialogContent) => void
  setVisible: (visible: boolean) => void
}

export const createOperationDetailDialogController = (view: OperationDetailDialogView) => {
  let active = true
  let disposed = false
  let pending = false
  let resolver: ((confirmed: boolean) => void) | undefined

  const replace = (title: string, lines: string[], confirmation: boolean): void => {
    if (disposed) return
    const pendingResolver = resolver
    resolver = undefined
    pendingResolver?.(false)
    view.setContent({ title, lines, confirmation })
    pending = !active && !confirmation
    view.setVisible(active)
  }

  const show = (title: string, lines: string[]): void => { replace(title, lines, false) }
  const confirm = async(title: string, lines: string[]): Promise<boolean> => {
    if (!active || disposed) return false
    replace(title, lines, true)
    return new Promise(resolve => { resolver = resolve })
  }
  const resolve = (confirmed: boolean): void => {
    pending = false
    view.setVisible(false)
    const pendingResolver = resolver
    resolver = undefined
    pendingResolver?.(confirmed)
  }
  const activate = (): void => {
    if (disposed) return
    active = true
    if (!pending) return
    pending = false
    view.setVisible(true)
  }
  const deactivate = (): void => {
    active = false
    resolve(false)
  }
  const dispose = (): void => {
    disposed = true
    active = false
    resolve(false)
  }
  return { activate, confirm, deactivate, dispose, resolve, show }
}
