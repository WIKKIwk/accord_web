/** Intercept a child dialog's Escape before a parent's document capture handler. */
export function captureNestedDialogEscape(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, close: () => void) {
  const listener = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing) return
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }
  target.addEventListener('keydown', listener, { capture: true })
  return () => target.removeEventListener('keydown', listener, { capture: true })
}
