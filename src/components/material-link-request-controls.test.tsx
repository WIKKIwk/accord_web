import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { materialLinkAttempts, parseMaterialLinkRequest } from '@/lib/material-link-requests'
import type { MaterialLinkDecisionPlan, MaterialLinkRequest } from '@/lib/material-link-requests'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import { MaterialLinkRequestControls, MaterialLinkRequestDecisionControls, MaterialLinkRequestSummary } from './material-link-request-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const scope = 'material-link-ui-scope', orderId = 'zakaz-material-link-ui', machine = 'apparatus:default:printer-1', requestId = `material-link-${'1'.padStart(32, '0')}`
const request: MaterialLinkRequest = { request_id: requestId, status: 'pending', event_sequence: 1, order_id: orderId, order_number: 'LINK-001', order_title: 'Film', apparatus_id: machine, apparatus_name: 'Printer', requester_ref: 'actual-worker', requester_display_name: 'Worker', mover_ref: 'actual-mover', mover_display_name: 'Mover', candidates: [{ stock_id: 'actual-stock', barcode: 'NATIVE-RAW', item_name: 'Native PET', qty: 21, uom: 'kg', location_id: 'actual-state', location_name: 'Printer state', placement_version: 4, mover_ref: 'actual-mover', mover_display_name: 'Mover' }], selected_barcodes: [], decided_by_name: '', decided_by_role: '', decided_at_unix: 0, reason: '', requested_at_unix: 1791889000, expires_at_unix: 1791890800 }
const retained: MaterialLinkDecisionPlan = { action: 'approve', orderId, apparatusId: machine, actor: { role: 'admin', ref: 'actual-admin' }, authScope: scope, baseline: request, body: { action: 'approve', request_id: requestId, barcodes: ['NATIVE-RAW'] } }
function session(capabilities = ['admin.access', 'raw_material.assign'], activeScope = scope, demo = false): void {
  const actor: Session = { token: 'local-ui-fixture', profile: { role: 'admin', ref: 'actual-admin', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session: actor, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: actor.token }), scope: activeScope, endpoint: 'http://127.0.0.1:5199', demo, connection: 'online', restoring: false, login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  materialLinkAttempts.activate(activeScope)
}
function render(component: React.ReactNode) { return renderToStaticMarkup(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>{component}</QueryClientProvider>) }
afterEach(() => { materialLinkAttempts.activate('reset-link-ui'); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('material link UI entry and native receipt disclosure', () => {
  it('does not request native data before opening and preserves demo/identity/read gates', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    session([])
    expect(render(<MaterialLinkRequestControls row={{ id: orderId }} />)).toContain('so‘rovini o‘qish uchun')
    session()
    expect(render(<MaterialLinkRequestControls row={{ id: '' }} />)).toContain('haqiqiy identifikatori kerak')
    expect(render(<MaterialLinkRequestDecisionControls requestId="guessed-principal-id" />)).toContain('native homashyo so‘rovi identifikatori kerak')
    session(undefined, scope, true)
    const html = render(<MaterialLinkRequestControls row={{ id: orderId }} />)
    expect(html).toContain('Ko‘rish rejimida'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/)
    session(); render(<MaterialLinkRequestDecisionControls requestId={requestId} expectedOrderId={orderId} />)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('retains same-order unknown after remount, including request-only controls with no cached query data', () => {
    session()
    const lease = materialLinkAttempts.begin(scope, retained)
    productionOperationLedger.dispatched(lease); materialLinkAttempts.interrupt(lease)
    const orderHtml = render(<MaterialLinkRequestControls row={{ id: orderId }} />)
    expect(orderHtml).toContain('Avvalgi homashyo so‘rovi saqlangan'); expect(orderHtml).toContain('Yangi yuborish qulflangan')
    const cardHtml = render(<MaterialLinkRequestDecisionControls requestId={requestId} />)
    expect(cardHtml).toContain('Avvalgi homashyo so‘rovi saqlangan')
    expect(materialLinkAttempts.get(scope, orderId)?.plan.body).toEqual(retained.body)
    session(undefined, 'another-auth-scope')
    expect(render(<MaterialLinkRequestDecisionControls requestId={requestId} />)).not.toContain('Avvalgi homashyo so‘rovi saqlangan')
    expect(materialLinkAttempts.orderForRequest(scope, requestId)).toBeUndefined()
  })
  it('shows cross-panel order ownership and denies training request creation', () => {
    session()
    productionOperationLedger.begin(scope, { channel: 'completion', orderId, plan: { action: 'complete' }, proof: {} })
    expect(render(<MaterialLinkRequestControls row={{ id: orderId }} />)).toContain('avvalgi ishlab chiqarish amali bor')
    expect(render(<MaterialLinkRequestControls row={{ id: 'training-fixture' }} />)).toContain('homashyo ulash so‘roviga kirmaydi')
  })
  it('reports requested quantities as snapshots and renders actual saved selection, refusal, decider and reason', () => {
    const approved = parseMaterialLinkRequest({ ...request, status: 'approved', event_sequence: 2, selected_barcodes: ['NATIVE-RAW'], decided_by_name: 'Original manager', decided_by_role: 'material_taminotchi', decided_at_unix: 1791889010 })
    const html = renderToStaticMarkup(<MaterialLinkRequestSummary request={approved} />)
    expect(html).toContain('So‘rovdagi miqdor: 21 kg'); expect(html).toContain('Ulangan rulonlar: NATIVE-RAW'); expect(html).toContain('Saqlangan qaror: Original manager'); expect(html).toContain(requestId)
    const stale = parseMaterialLinkRequest({ ...request, status: 'stale', event_sequence: 2, decided_at_unix: 1791889010, reason: 'Order holati o‘zgardi.' })
    const staleHtml = renderToStaticMarkup(<MaterialLinkRequestSummary request={stale} />)
    expect(staleHtml).toContain('Order holati o‘zgardi.'); expect(staleHtml).toContain('so‘rov yopilgan'); expect(staleHtml).not.toContain('Ulangan rulonlar:')
  })
})
