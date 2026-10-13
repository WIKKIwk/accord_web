import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionSnapshot, Row, Session } from '@/lib/api-types'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import { emptyProductionCompletionDraft, productionCompletionAttempts, productionCompletionCommand } from '@/lib/production-completion'

const orderId = 'zakaz-completion-ui', app = 'apparatus:print:completion', scope = 'completion-ui-scope'
const state = vi.hoisted(() => ({ connection: 'online', demo: false, capabilities: ['admin.access'] }))
vi.mock('@/lib/session', () => ({ useSession: () => ({ scope: 'completion-ui-scope', client: {}, session: { token: 'fixture-only-token', profile: { role: 'admin', ref: 'actor-1', display_name: 'Fixture admin' }, capabilities: state.capabilities } as Session,
  connection: state.connection, demo: state.demo, reconnect: vi.fn() }) }))
import { ProductionCompletionControls, ProductionCompletionResultView } from './production-completion-controls'

function fixture(): { snapshot: ProductionSnapshot; rows: Row[] } {
  return { snapshot: { ok: true, epoch: 'fixture', scope: '', rev: 1, maps: [{ map: { id: orderId, order_number: 'C-123', title: 'Film fixture', product_code: 'film', nodes: [{ id: 'stage-1', kind: 'apparatus', apparatus_id: app, title: 'Bosma fixture', x: 0, y: 0 }], edges: [] }, program: {} }],
    order_statuses: { [orderId]: { lifecycle_status: 'in_progress', order_status: 'in_progress' } }, order_controls: {}, order_customers: {}, sequences: {}, queue_states: { [app]: { [orderId]: 'in_progress' } }, stage_states: {},
    queue_action_controls: { [app]: { [orderId]: { state: 'in_progress', stage_node_id: 'stage-1', allowed_actions: ['complete'], complete_requires_full_report: true, complete_requires_rezka_total_waste_only: false, work_activity: { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'worker-1' } } } } },
    rows: [{ runtime_projection: { apparatus_id: app, source_revision: 1, lifecycle: { state: 'active' }, display: { display_name: 'Fixture printer' }, execution_profile: { operation: 'print' } } }] }
}
function render(value: ReturnType<typeof fixture>, denied = false, row: Row = value.snapshot.maps[0].map) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  query.setQueryData([scope, 'production-snapshot'], value.snapshot); query.setQueryData([scope, 'production-control-apparatus'], { items: value.rows, hasMore: false })
  if (denied) query.getQueryCache().find({ queryKey: [scope, 'production-snapshot'] })!.setState({ status: 'error', error: new Error('Fresh snapshot denied') })
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><ProductionCompletionControls row={row} /></QueryClientProvider>)
  query.clear(); return html
}
let sequence = 0
beforeEach(() => { state.connection = 'online'; state.demo = false; state.capabilities = ['admin.access']; productionCompletionAttempts.activate(`reset-ui-${++sequence}`); productionCompletionAttempts.activate(scope) })

describe('native completion readable controls', () => {
  it('shows the actual order, occurrence and machine with only a permitted report action', () => {
    const html = render(fixture())
    expect(html).toContain('Bosqichni tugatish hisoboti'); expect(html).toContain('C-123'); expect(html).toContain('Bosma fixture'); expect(html).toContain('Fixture printer'); expect(html).toContain('Tugatish hisobotini kiritish')
    expect(html).not.toContain('gradient')
  })
  it('keeps offline and native freeze visible and closes the report action', () => {
    const value = fixture(); state.connection = 'offline'
    expect(render(value)).toContain('Aloqa uzilgan')
    expect(render(value)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/)
    state.connection = 'online'; value.snapshot.order_controls = { [orderId]: { state: 'frozen' } }
    expect(render(value)).toContain('Buyurtma muzlatilgan')
  })
  it('restores a dispatched unknown completion on repeated detail remounts without an unkeyed replay control', () => {
    const value = fixture(), draft = { ...emptyProductionCompletionDraft(), metres: '100', grossKg: '10', tareKg: '1', waste: '1',
      paint: (['rasxot', 'astatka'] as const).flatMap(usage => [1, 2, 3].map(index => ({ usage, category: 'colors' as const, name: `Paint ${index}`, label: 'kg', value: '1' }))) }
    const session = { profile: { role: 'admin', ref: 'actor-1' }, capabilities: ['admin.access'] } as Session
    const plan = productionCompletionCommand(value.snapshot, orderId, session, value.rows, app, scope, { session: null, sources: [], cut: null }, draft)
    const lease = productionCompletionAttempts.begin(scope, plan); productionCompletionAttempts.dispatched(lease); productionCompletionAttempts.interrupt(lease)
    for (let reopened = 0; reopened < 2; reopened++) {
      const html = render(value)
      expect(html).toContain('Tugatish hisoboti natijasi noaniq'); expect(html).toContain('Oddiy yangilash yoki oynani yopish'); expect(html).not.toContain('Aynan shu hisobotni tiklash')
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/)
    }
  })
  it('honors another panel’s order reservation while keeping unrelated orders available', () => {
    const value = fixture(), lease = productionOperationLedger.begin(scope, { channel: 'assignment', orderId, plan: {}, proof: {} })
    expect(render(value)).toContain('boshqa ishlab chiqarish amali tekshirilmoqda')
    productionOperationLedger.interrupt(lease)
    const elsewhere = productionOperationLedger.begin(scope, { channel: 'legacy-control', orderId: 'another-order', plan: {}, proof: {} })
    const html = render(value); expect(html).not.toContain('boshqa ishlab chiqarish amali tekshirilmoqda')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/)
    productionOperationLedger.interrupt(elsewhere)
  })
  it('hides denied sessions and invalid identities even when privileged query data remains cached', () => {
    const value = fixture(); state.capabilities = []
    expect(render(value)).toBe('')
    state.capabilities = ['admin.access']; expect(render(value, false, { order_number: 'Title only' })).toBe('')
    expect(render(value, false, { id: 'wrong', map: value.snapshot.maps[0].map })).toBe('')
  })
  it('blocks checking, demo and denied fresh reads without issuing writes on render', () => {
    const value = fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const connection of ['checking', 'offline']) { state.connection = connection; expect(render(value)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/) }
    state.connection = 'online'; state.demo = true
    expect(render(value)).toContain('Namuna rejimida tugatish hisoboti yuborilmaydi')
    expect(render(value)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/)
    state.demo = false; expect(render(value, true)).toContain('Fresh snapshot denied'); expect(render(value, true)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Tugatish hisobotini kiritish<\/button>/)
    expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals()
  })
  it('retains immutable keyed laminate recovery through repeated remounts without changing its sources or body', () => {
    const value = fixture(), machine = value.rows[0].runtime_projection as Row; (machine.execution_profile as Row).operation = 'laminate'
    value.snapshot.queue_action_controls[app][orderId].work_activity = { state: 'in_progress', worker_role: 'admin', worker_ref: 'actor-1' }
    const session = { token: 'fixture-only', profile: { role: 'admin', ref: 'actor-1' }, capabilities: ['admin.access'] } as Session
    const ctx = { session: { session_id: 'active-lam-run', apparatus: app, order_id: orderId, stage_node_id: 'stage-1', worker_role: 'admin', worker_ref: 'actor-1', status: 'active', payload_json: {} }, sources: [{ source_kind: 'raw_material', source_id: 'RAW-1', session_id: 'active-lam-run', revision: 8, source_net_kg: 20 }], cut: null }
    const draft = { ...emptyProductionCompletionDraft(), metres: '100', grossKg: '10', tareKg: '1', waste: '0', layers: { 'raw_material:RAW-1': '2' } }
    const plan = productionCompletionCommand(value.snapshot, orderId, session, value.rows, app, scope, ctx, draft, 'keyed-ui-completion')
    const lease = productionCompletionAttempts.begin(scope, plan); productionCompletionAttempts.dispatched(lease); productionCompletionAttempts.interrupt(lease)
    for (let reopened = 0; reopened < 3; reopened++) { const html = render(value); expect(html).toContain('Aynan shu hisobotni tiklash'); expect(html).toContain('Tugatish hisoboti natijasi noaniq'); expect(productionCompletionAttempts.get(scope, orderId)?.plan.body).toEqual(plan.body) }
    expect(productionCompletionAttempts.get(scope, orderId)?.plan.body.layer_remainders).toEqual([{ source_kind: 'raw_material', source_id: 'RAW-1', expected_revision: 8, remaining_net_kg: 2 }])
  })
  it('separates zero approval, saved output and USB pending or failed labels in the result UI', () => {
    const approval = renderToStaticMarkup(<ProductionCompletionResultView result={{ kind: 'approval_requested', message: 'Native approval required', batches: [], remainders: [], prints: [] }} />)
    expect(approval).toContain('Tasdiqlash kutilmoqda'); expect(approval).not.toContain('Bosqich hisoboti saqlandi'); expect(approval).not.toContain('WIP ·')
    const confirmed = renderToStaticMarkup(<ProductionCompletionResultView result={{ kind: 'completed', message: 'Native business receipt', batches: [{ batch_id: 'saved-output', qr_payload: 'SAVED-OUTPUT-QR', finished_goods_meter: 100, finished_goods_kg: 10 }], remainders: [{ operation_id: 'native-remaining', source_kind: 'raw_material', source_id: 'RAW-1', remaining_net_kg: 2, qr_payload: 'SAVED-REMAINDER-QR' }], prints: [{ ok: false, status: 'failed' }] }} />)
    expect(confirmed).toContain('Bosqich hisoboti saqlandi'); expect(confirmed).toContain('SAVED-OUTPUT-QR'); expect(confirmed).toContain('SAVED-REMAINDER-QR'); expect(confirmed).toContain('Hisobot qayta yuborilmaydi')
    const prepared = renderToStaticMarkup(<ProductionCompletionResultView result={{ kind: 'partial', message: 'Current roll only', batches: [{ batch_id: 'saved-output', qr_payload: 'SAVED-OUTPUT-QR' }], remainders: [], prints: [{ ok: true, status: 'prepared', printer_status: 'client_usb_pending' }] }} />)
    expect(prepared).toContain('Joriy rulon qayd etildi'); expect(prepared).toContain('fizik bosma tasdig‘i emas'); expect(prepared).not.toContain('Bosqich hisoboti saqlandi')
  })
})
