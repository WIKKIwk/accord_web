import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { ApparatusPlanningControls, OrderSchedulingControls } from './apparatus-planning-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const apparatus = { apparatus_id: 'apparatus:default:asset-001' }, order = { map: { id: 'order:001' } }
function actor(capabilities = ['admin.access'], demo = false, role = 'admin') {
  const session: Session = { token: 'test-token', profile: { role, ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo, scope: 'test-scope', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: 'test-token' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })
function render(value: ReactNode) { return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{value}</QueryClientProvider>) }

describe('apparatus planning entry point permissions and identities', () => {
  it('exposes supported apparatus and existing-order planning actions without issuing reads or writes on render', () => {
    actor(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(render(<ApparatusPlanningControls row={apparatus} />)).toContain('Quvvat, navbat va ish vaqti')
    expect(render(<OrderSchedulingControls row={order} />)).toContain('Apparat vaqtini rejalashtirish')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('permits configuration read for a queue reader while hiding order mutation controls', () => {
    actor(['apparatus.queue.read'], false, 'aparatchi')
    expect(renderToStaticMarkup(<ApparatusPlanningControls row={apparatus} />)).toContain('Quvvat, navbat va ish vaqti')
    expect(renderToStaticMarkup(<OrderSchedulingControls row={order} />)).toBe('')
  })

  it('uses capability guards rather than an admin role label', () => {
    actor([], false, 'admin')
    expect(renderToStaticMarkup(<ApparatusPlanningControls row={apparatus} />)).toBe('')
    expect(renderToStaticMarkup(<OrderSchedulingControls row={order} />)).toBe('')
    actor(['production.map.manage'], false, 'aparatchi')
    expect(render(<OrderSchedulingControls row={order} />)).toContain('Apparat vaqtini rejalashtirish')
  })

  it('disables every demo mutation entry and shows no fabricated reservation', () => {
    actor(['admin.access'], true); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render(<><ApparatusPlanningControls row={apparatus} /><OrderSchedulingControls row={order} /></>)
    expect((html.match(/<button/g) ?? []).length).toBe((html.match(/disabled=""/g) ?? []).length)
    expect(html).not.toContain('apparatus-reservation:')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides controls for malformed identities and uses the runtime projection identity', () => {
    actor()
    expect(renderToStaticMarkup(<ApparatusPlanningControls row={{ apparatus_id: 'Bosma' }} />)).toBe('')
    expect(renderToStaticMarkup(<OrderSchedulingControls row={{ order_number: '001' }} />)).toBe('')
    expect(renderToStaticMarkup(<ApparatusPlanningControls row={{ runtime_projection: apparatus }} />)).toContain('Quvvat, navbat va ish vaqti')
  })
})
