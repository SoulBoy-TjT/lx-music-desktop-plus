import { describe, expect, it, vi } from 'vitest'
import { createOperationDetailDialogController } from '@renderer/components/common/operationDetailDialogState'

const createFixture = () => {
  const setContent = vi.fn()
  const setVisible = vi.fn()
  const controller = createOperationDetailDialogController({ setContent, setVisible })
  return { controller, setContent, setVisible }
}

describe('song organizer detail dialog state', () => {
  it('resolves an active confirmation and closes the dialog', async() => {
    const { controller, setContent, setVisible } = createFixture()
    const confirmation = controller.confirm('清理', ['待清理文件'])

    expect(setContent).toHaveBeenCalledWith({ title: '清理', lines: ['待清理文件'], confirmation: true })
    expect(setVisible).toHaveBeenLastCalledWith(true)

    controller.resolve(true)

    await expect(confirmation).resolves.toBe(true)
    expect(setVisible).toHaveBeenLastCalledWith(false)
  })

  it('cancels confirmation when the page is deactivated', async() => {
    const { controller, setVisible } = createFixture()
    const confirmation = controller.confirm('清理', ['待清理文件'])

    controller.deactivate()

    await expect(confirmation).resolves.toBe(false)
    expect(setVisible).toHaveBeenLastCalledWith(false)
    await expect(controller.confirm('清理', ['不会展示'])).resolves.toBe(false)
  })

  it('shows an operation result only after returning to the page', () => {
    const { controller, setContent, setVisible } = createFixture()
    controller.deactivate()
    setVisible.mockClear()

    controller.show('最近详情', ['重命名成功'])

    expect(setContent).toHaveBeenCalledWith({ title: '最近详情', lines: ['重命名成功'], confirmation: false })
    expect(setVisible).toHaveBeenLastCalledWith(false)

    controller.activate()

    expect(setVisible).toHaveBeenLastCalledWith(true)
  })

  it('cancels a pending confirmation before replacing its content', async() => {
    const { controller, setContent } = createFixture()
    const confirmation = controller.confirm('清理', ['旧内容'])

    controller.show('最近详情', ['新内容'])

    await expect(confirmation).resolves.toBe(false)
    expect(setContent).toHaveBeenLastCalledWith({ title: '最近详情', lines: ['新内容'], confirmation: false })
  })
})
