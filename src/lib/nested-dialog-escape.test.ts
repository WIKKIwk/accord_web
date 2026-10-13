import { describe, expect, it, vi } from 'vitest'
import { captureNestedDialogEscape } from './nested-dialog-escape'

function key(value: string, composing = false) {
  const event = new Event('keydown', { cancelable: true })
  Object.assign(event, { key: value, isComposing: composing })
  return event
}
describe('nested dialog Escape capture lifecycle', () => {
  it('consumes only the child Escape before another dismissal listener', () => {
    const target = new EventTarget(), close = vi.fn(), parent = vi.fn()
    const release = captureNestedDialogEscape(target as unknown as Window, close)
    target.addEventListener('keydown', parent)
    const escape = key('Escape')
    expect(target.dispatchEvent(escape)).toBe(false)
    expect(close).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled()
    expect(escape.defaultPrevented).toBe(true)
    release(); target.dispatchEvent(key('Escape'))
    expect(parent).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })
  it('leaves normal keyboard input and IME cancellation intact', () => {
    const target = new EventTarget(), close = vi.fn(), next = vi.fn()
    const release = captureNestedDialogEscape(target as unknown as Window, close)
    target.addEventListener('keydown', next)
    for (const event of [key('Tab'), key('Enter'), key('a'), key('Escape', true)]) {
      expect(target.dispatchEvent(event)).toBe(true); expect(event.defaultPrevented).toBe(false)
    }
    expect(close).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(4); release()
  })
})
