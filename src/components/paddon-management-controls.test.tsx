import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiClient, ApiError } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { freeMovementOperation, paddonManagementIntentLedger, paddonManagementPath } from '@/lib/paddon-management'
import type { PaddonManagementIntent, PaddonManagementSettings } from '@/lib/paddon-management'
import { PaddonFreeMovementReview, PaddonManagementDialog, PaddonManagementReadState, PaddonManagementRecovery, PaddonManagementStateView, PaddonManagementToolbar } from './paddon-management-controls'

type ButtonProps = ComponentProps<typeof import('./ui/button').Button>
const ui = vi.hoisted(() => ({ buttons: [] as ButtonProps[], draftSeeds: [] as unknown[] }))
// Controlled SSR drafts exercise the actual component handlers without installing a DOM runtime.
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useEffect: vi.fn(actual.useEffect), useState: vi.fn((initial: unknown) => {
    const seeded = ui.draftSeeds.shift(); return actual.useState(seeded === undefined ? initial : seeded)
  }) }
})
vi.mock('@tanstack/react-query', async original => ({ ...await original<typeof import('@tanstack/react-query')>(), useQuery: vi.fn() }))
vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./ui/button', async original => {
  const actual = await original<typeof import('./ui/button')>()
  return { ...actual, Button: (props: ButtonProps) => { ui.buttons.push(props); return <actual.Button {...props} /> } }
})
vi.mock('./ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, className, 'aria-busy': busy }: { children: ReactNode; className?: string; 'aria-busy'?: boolean }) => <section role="dialog" className={className} aria-busy={busy}>{children}</section>,
  DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) => <header className={className}>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children, className, 'data-paddon-management-footer': footer }: { children: ReactNode; className?: string; 'data-paddon-management-footer'?: boolean }) => <footer className={className} data-paddon-management-footer={footer}>{children}</footer>,
}))

const initial: PaddonManagementSettings = { free_movement_enabled: false, worker_visibility_enabled: true }
let serial = 0
function setup({ capabilities = ['admin.access'], role = 'admin', ref = 'qa-admin', demo = false, scope = `management-ui-${++serial}`, connection = 'online' }:
  { capabilities?: string[]; role?: string; ref?: string; demo?: boolean; scope?: string; connection?: ReturnType<typeof useSession>['connection'] } = {}) {
  const session: Session = { token: 'SYNTHETIC-SESSION', profile: { role, ref, display_name: 'QA Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, scope, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), demo, endpoint: 'http://127.0.0.1:5199', restoring: false, connection, login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  readResult(); return scope
}
function readResult({ settings = initial, error = null, loading = false, fresh = true, fetching = false }:
  { settings?: PaddonManagementSettings | null; error?: unknown; loading?: boolean; fresh?: boolean; fetching?: boolean } = {}) {
  vi.mocked(useQuery).mockReturnValue({ data: settings ?? undefined, error, isPending: loading, isFetching: fetching, isFetchedAfterMount: fresh, refetch: vi.fn(async () => ({ data: settings, error })) } as unknown as ReturnType<typeof useQuery>)
}
function render(children: ReactNode) { const cache = new QueryClient(); return { html: renderToStaticMarkup(<QueryClientProvider client={cache}>{children}</QueryClientProvider>), cache } }
const dialog = () => render(<PaddonManagementDialog onClose={vi.fn()} onReturnFocus={vi.fn()} />)
function button(label: string) {
  const found = ui.buttons.findLast(props => String(props.children).includes(label)); if (!found) throw new Error(`Missing UI button: ${label}`); return found
}
function click(label: string) { const props = button(label); expect(props.disabled).not.toBe(true); props.onClick?.({} as MouseEvent<HTMLButtonElement>) }
function cleanupDialog(scope: string) {
  const ledger = paddonManagementIntentLedger(scope), effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === ledger && deps?.[1] instanceof MutationScope)?.[0]
  if (!effect) throw new Error('Missing scoped cleanup effect')
  const cleanup = effect(); if (typeof cleanup !== 'function') throw new Error('Missing scoped cleanup'); return cleanup
}
type WireOptions = { method: string; body?: string; signal: AbortSignal }
function wire({ settings = initial, delayed, failure }: { settings?: PaddonManagementSettings; delayed?: () => Promise<void>; failure?: Error } = {}) {
  let current = { ...settings }
  const fetch = vi.fn(async (url: URL, options: WireOptions) => {
    expect(url.pathname).toBe(paddonManagementPath)
    if (options.method === 'PUT') {
      const input = JSON.parse(options.body!); expect(Object.keys(input)).toEqual(['free_movement_enabled'])
      current = { ...current, free_movement_enabled: input.free_movement_enabled }
      await delayed?.(); if (failure) throw failure
    }
    return new Response(JSON.stringify({ ok: true, settings: current }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch); return { fetch, current: () => current }
}
const writes = (fetch: ReturnType<typeof wire>['fetch']) => fetch.mock.calls.filter(([, options]) => options.method === 'PUT')
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); ui.buttons.length = 0; ui.draftSeeds.length = 0 })

describe('scoped S08 toolbar and fixed dialog presentation', () => {
  it('uses native read OR for the entry without requesting data before opening, and disables demo', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) {
      setup({ capabilities: [capability], role: 'aparatchi' }); expect(render(<PaddonManagementToolbar />).html).toContain('Paddon sozlamalari')
    }
    setup({ capabilities: ['admin.settings.read'] }); expect(render(<PaddonManagementToolbar />).html).toBe('')
    setup({ demo: true }); const demo = render(<PaddonManagementToolbar />).html; expect(demo).toContain('disabled=""'); expect(demo).toContain('Ko‘rish rejimida')
    expect(fetch).not.toHaveBeenCalled(); expect(useQuery).not.toHaveBeenCalled()
  })
  it('handles a signed-out empty scope without constructing a ledger or an API request', () => {
    setup({ scope: '', capabilities: [] }); expect(render(<PaddonManagementToolbar />).html).toBe('')
  })
  it('retains unknown badges through same-scope remounts and isolates another actor/session', () => {
    const scope = setup(), ledger = paddonManagementIntentLedger(scope), operation = freeMovementOperation(initial, true)
    ledger.begin(operation); ledger.dispatched(operation); ledger.unknown(operation)
    expect(render(<PaddonManagementToolbar />).html).toContain('Tekshirish kerak')
    setup({ scope }); expect(render(<PaddonManagementToolbar />).html).toContain('Tekshirish kerak')
    setup(); expect(render(<PaddonManagementToolbar />).html).not.toContain('Tekshirish kerak')
  })
  it('warns on full unload for dispatched retained intent, with scoped cleanup', () => {
    const scope = setup(), ledger = paddonManagementIntentLedger(scope), operation = freeMovementOperation(initial, true)
    ledger.begin(operation); ledger.dispatched(operation); ledger.unknown(operation)
    const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() }; vi.stubGlobal('window', window)
    render(<PaddonManagementToolbar />)
    const effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[1] === scope && deps?.[0] === true)?.[0]
    expect(effect).toBeDefined(); const cleanup = effect!()
    expect(window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    const unloadEvent = { preventDefault: vi.fn(), returnValue: 'unchanged' }, handler = window.addEventListener.mock.calls[0]![1] as (event: typeof unloadEvent) => void
    handler(unloadEvent); expect(unloadEvent.preventDefault).toHaveBeenCalled(); expect(unloadEvent.returnValue).toBe('')
    if (typeof cleanup === 'function') cleanup()
    expect(window.removeEventListener).toHaveBeenCalledWith('beforeunload', handler)
  })
  it('renders current false flags as a real state with no visibility write input', () => {
    const html = render(<PaddonManagementStateView settings={{ free_movement_enabled: false, worker_visibility_enabled: false }} />).html
    expect(html).toContain('Serverdagi joriy holat'); expect(html.match(/O‘chirilgan/g)).toHaveLength(2)
    expect(html).toContain('faqat ma’lumot'); expect(html).not.toContain('<input'); expect(html).not.toContain('role="checkbox"')
    expect(html).not.toContain('sozlamalari kelmadi')
  })
  it('keeps the scroll body inside a compact dialog and the actions in a separate fixed footer', () => {
    setup(); const html = dialog().html
    expect(html).toContain('sm:max-w-lg'); expect(html).toContain('max-h-[90svh]'); expect(html).toContain('overflow-hidden')
    const body = html.indexOf('data-paddon-management-scroll'), footer = html.indexOf('data-paddon-management-footer')
    expect(body).toBeGreaterThan(0); expect(footer).toBeGreaterThan(body)
    expect(html.slice(body - 100, footer)).toContain('overflow-y-auto'); expect(html.slice(footer - 150, footer)).toContain('shrink-0')
    expect(html).toContain('Yopish'); expect(html).toContain('O‘zgarishni saqlash')
    expect(button('O‘zgarishni saqlash').disabled).toBe(true)
  })
  it.each([
    { capabilities: ['admin.access'], role: 'aparatchi' },
    { capabilities: ['production.map.manage'], role: 'admin' },
    { capabilities: ['apparatus.queue.read'], role: 'admin' },
    { capabilities: ['admin.access'], role: 'admin', ref: '\u2003 ' },
  ])('renders an actual-role/capability/ref mismatch as read-only: %j', changes => {
    setup(changes); const html = dialog().html
    expect(html).toContain('faqat ko‘rish mumkin'); expect(html).not.toContain('O‘zgarishni saqlash'); expect(html).not.toContain('Erkin harakatni yoqish')
    expect(html).not.toContain('role="checkbox"'); expect(html).toContain('Ishchi ko‘rinishi (faqat ma’lumot)')
  })
  it('does not enable edits from a cached stale display, an offline write, or a refreshing read', () => {
    for (const state of ['cached', 'offline', 'refreshing'] as const) {
      setup({ connection: state === 'offline' ? 'offline' : 'online' }); readResult({ fresh: state !== 'cached', fetching: state === 'refreshing' })
      ui.draftSeeds.push(true, true); dialog()
      expect(button('O‘zgarishni saqlash').disabled).toBe(true)
      ui.buttons.length = 0
    }
  })
})

describe('read states and explicit movement impact', () => {
  it('distinguishes loading, absent singleton response, malformed response, and permission refusal', () => {
    const props = { error: null, loading: false, canRetry: true, refreshing: false, onRetry: vi.fn() }
    expect(render(<PaddonManagementReadState {...props} loading />).html).toContain('role="status"')
    const empty = render(<PaddonManagementReadState {...props} />).html; expect(empty).toContain('sozlamalari kelmadi'); expect(empty).toContain('qayta yuklash')
    const malformed = render(<PaddonManagementReadState {...props} error={new ApiError(502, 'invalid_response', 'Paddon sozlamalari to‘liq tasdiqlanmadi.')} />).html
    expect(malformed).toContain('role="alert"'); expect(malformed).toContain('qayta yuklash')
    for (const status of [401, 403]) expect(render(<PaddonManagementReadState {...props} error={new ApiError(status, 'forbidden')} />).html).not.toContain('qayta yuklash')
  })
  it.each([true, false])('requires a separate impact review for changing to %s without promising visibility changes', desired => {
    const html = render(<PaddonFreeMovementReview settings={{ ...initial, free_movement_enabled: !desired }} editable desired={desired} reviewed={false} disabled={false} onDesired={vi.fn()} onReviewed={vi.fn()} />).html
    for (const phrase of ['mavjud ko‘rinish doirasida', 'qabul qilinmagan', 'ko‘chirishga yaroqli rulonlarni', 'qabul qilingan mahsulotlar ko‘chirilmaydi', 'Ko‘chirish, tahrirlash va qulfni ochish ta’sirini ko‘rdim']) expect(html).toContain(phrase)
    if (desired) for (const phrase of ['mavjud ko‘rinish va yozish ruxsatlari doirasida', 'qabul qilinmagan bosilgan paddonlarni tahrirlash', 'qulf egasi bo‘lmasdan ochish']) expect(html).toContain(phrase)
    else for (const phrase of ['erkin tahrirlashni to‘xtatadi', 'odatiy administrator yoki qulf egasi qoidalariga qaytadi']) expect(html).toContain(phrase)
    expect(html.match(/role="checkbox"/g)).toHaveLength(2)
    expect(html).toContain(desired ? 'yoqishni' : 'o‘chirishni'); expect(html).not.toContain('barcha ishchi'); expect(html).not.toContain('worker_visibility_enabled')
  })
  it('does not show an impact approval when the desired value is unchanged', () => {
    const html = render(<PaddonFreeMovementReview settings={initial} editable desired={false} reviewed={false} disabled={false} onDesired={vi.fn()} onReviewed={vi.fn()} />).html
    expect(html.match(/role="checkbox"/g)).toHaveLength(1); expect(html).not.toContain('qulfni ochish ta’sirini ko‘rdim')
  })
  it('keeps unknown matches and differences candid and prevents review after a failed fresh check', () => {
    const operation = freeMovementOperation(initial, true)
    for (const state of ['matches', 'different'] as const) {
      const intent: PaddonManagementIntent = { operation, status: 'unknown', dispatched: true, observation: { settings: { ...initial, free_movement_enabled: state === 'matches' }, state } }
      const html = render(<PaddonManagementRecovery intent={intent} checking={false} canCheck error={null} reviewed={false} onReviewed={vi.fn()} onCheck={vi.fn()} />).html
      for (const phrase of ['Asl so‘rov qayta yuborilmaydi', 'shu sessiya xotirasida', 'to‘liq yangilash yoki hisobdan chiqish', 'uni kim bajarganini tasdiqlamaydi', 'Asl javob tasdiqlanmaganini']) expect(html).toContain(phrase)
      expect(html).not.toContain('sozlamasi saqlandi'); expect(html).not.toContain('O‘zgarishni saqlash')
      const failure = render(<PaddonManagementRecovery intent={intent} checking={false} canCheck error={new ApiError(0, 'network')} reviewed={false} onReviewed={vi.fn()} onCheck={vi.fn()} />).html
      expect(failure.match(/<button[^>]*role="checkbox"[^>]*>/)?.[0]).toContain('disabled=""')
    }
  })
})

describe('component dispatch, interruption and read-only recovery handlers', () => {
  it('requires the explicit review checkbox before the component can dispatch', () => {
    setup(); ui.draftSeeds.push(true, false); wire(); dialog()
    expect(button('O‘zgarishni saqlash').disabled).toBe(true)
  })
  it('dispatches the reviewed partial change once even when the same UI action is invoked twice', async () => {
    const scope = setup(), server = wire(); ui.draftSeeds.push(true, true); const { cache } = dialog()
    click('O‘zgarishni saqlash'); click('O‘zgarishni saqlash')
    await vi.waitFor(() => expect(paddonManagementIntentLedger(scope).snapshot()).toBeNull())
    expect(server.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT'])
    expect(writes(server.fetch)).toHaveLength(1); expect(toast.success).toHaveBeenCalledTimes(1)
    expect(cache.getQueryData(['paddon-management', scope])).toEqual({ free_movement_enabled: true, worker_visibility_enabled: true })
  })
  it('blocks a concurrent native baseline change before PUT and keeps a new read available', async () => {
    const scope = setup(), server = wire({ settings: { ...initial, free_movement_enabled: true } }); ui.draftSeeds.push(true, true); const { cache } = dialog()
    click('O‘zgarishni saqlash')
    await vi.waitFor(() => expect(paddonManagementIntentLedger(scope).snapshot()).toBeNull())
    expect(writes(server.fetch)).toHaveLength(0); expect(toast.success).not.toHaveBeenCalled()
    expect(cache.getQueryData(['paddon-management', scope])).toEqual(server.current())
  })
  it('closing during preflight cancels without retaining an unknown intent or dispatching a write', async () => {
    const scope = setup(), fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, settings: initial }), { status: 200 })); vi.stubGlobal('fetch', fetch)
    ui.draftSeeds.push(true, true); dialog(); const cleanup = cleanupDialog(scope)
    click('O‘zgarishni saqlash'); cleanup()
    await vi.waitFor(() => expect(paddonManagementIntentLedger(scope).snapshot()).toBeNull())
    expect(fetch).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled()
  })
  it('retains a sent interrupted change across remount, permits offline GET, and resolves only by explicit review', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), scope = setup(), server = wire({ delayed: () => waiting }), ledger = paddonManagementIntentLedger(scope)
    ui.draftSeeds.push(true, true); dialog(); const cleanup = cleanupDialog(scope)
    click('O‘zgarishni saqlash')
    await vi.waitFor(() => expect(writes(server.fetch)).toHaveLength(1))
    cleanup(); release()
    await vi.waitFor(() => expect(ledger.snapshot()?.status).toBe('unknown'))
    expect(toast.success).not.toHaveBeenCalled()
    setup({ scope, connection: 'offline' }); ui.buttons.length = 0; const unknown = dialog().html
    expect(unknown).toContain('natijasini tekshirish'); expect(unknown).not.toContain('O‘zgarishni saqlash')
    expect(button('Serverdagi joriy holatni tekshirish').disabled).toBe(false)
    expect(button('Tekshiruvni yakunlash').disabled).toBe(true)
    click('Serverdagi joriy holatni tekshirish')
    await vi.waitFor(() => expect(ledger.snapshot()?.observation?.state).toBe('matches'))
    expect(ledger.snapshot()?.status).toBe('unknown'); expect(writes(server.fetch)).toHaveLength(1)
    ui.buttons.length = 0; dialog(); expect(button('Tekshiruvni yakunlash').disabled).toBe(true)
    ui.buttons.length = 0; ui.draftSeeds.push(undefined, undefined, true); dialog(); click('Tekshiruvni yakunlash')
    expect(ledger.snapshot()).toBeNull(); expect(writes(server.fetch)).toHaveLength(1)
    expect(server.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT', 'GET'])
  })
  it('lost replies retain an unknown toolbar badge rather than a success notice or automatic replay', async () => {
    const scope = setup(), server = wire({ failure: new TypeError('reply lost') }); ui.draftSeeds.push(true, true); dialog(); click('O‘zgarishni saqlash')
    await vi.waitFor(() => expect(paddonManagementIntentLedger(scope).snapshot()?.status).toBe('unknown'))
    expect(render(<PaddonManagementToolbar />).html).toContain('Tekshirish kerak')
    expect(writes(server.fetch)).toHaveLength(1); expect(toast.success).not.toHaveBeenCalled()
  })
})
