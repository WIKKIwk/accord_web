import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionSnapshot, Row, Session } from '@/lib/api-types'
import { productionAssignmentAttempts, productionAssignmentCommand } from '@/lib/production-assignment'
import { productionOperationLedger } from '@/lib/production-operation-ledger'

const app = 'apparatus:print:fixture', orderId = 'zakaz-assignment-ui', scope = 'fixture-assignment-scope'
const state = vi.hoisted(() => ({ connection: 'online', demo: false, role: 'admin', capabilities: ['admin.access'] }))
vi.mock('@/lib/session', () => ({ useSession: () => ({ scope: 'fixture-assignment-scope', session: { token: 'fixture-only-token', profile: { role: state.role, ref: 'fixture-worker', display_name: 'Fixture worker' }, capabilities: state.capabilities } as Session,
  client: {}, demo: state.demo, connection: state.connection, reconnect: vi.fn() }) }))
import { ProductionAssignmentControls } from './production-assignment-controls'

function fixture(operation = 'print', status = 'pending'): { snapshot: ProductionSnapshot; rows: Row[] } {
  const control: Row = { state: status, stage_node_id: 'work-1', allowed_actions: status === 'pending' ? ['start'] : ['pause', 'complete'], previous_stage_ready: true, complete_requires_full_report: false,
    work_activity: status === 'in_progress' ? { state: 'in_progress', worker_role: 'aparatchi', worker_ref: 'worker-1' } : undefined,
    interaction: { mode: status === 'pending' ? 'fresh_start' : 'in_progress', start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: false, material_intake_allowed: status !== 'pending', resume_input_required: false,
      previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required' } }
  return { snapshot: { ok: true, rev: 1, epoch: 'fixture', scope: 'admin', maps: [{ map: { id: orderId, title: 'Fixture film', order_number: 'F-123', product_code: 'film', nodes: [{ id: 'work-1', kind: 'apparatus', title: 'Fixture stage', apparatus_id: app, x: 0, y: 0 }], edges: [] }, program: {} }],
    order_statuses: { [orderId]: { lifecycle_status: status === 'pending' ? 'released' : 'in_progress', order_status: status === 'pending' ? 'ready' : status } }, order_customers: {}, sequences: {}, queue_states: { [app]: { [orderId]: status } }, stage_states: {}, order_controls: {}, queue_action_controls: { [app]: { [orderId]: control } } },
    rows: [{ runtime_projection: { apparatus_id: app, source_revision: 1, lifecycle: { state: 'active' }, display: { display_name: 'Fixture apparatus' }, execution_profile: { operation, technology: 'rotogravure', capability_compatible_reroute: true }, capabilities: { [operation]: 1 } } }] }
}
function render(snapshot: ProductionSnapshot, rows: Row[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData([scope, 'production-snapshot'], snapshot)
  client.setQueryData([scope, 'production-control-apparatus'], { items: rows, hasMore: false })
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ProductionAssignmentControls row={snapshot.maps[0].map} /></QueryClientProvider>)
  client.clear(); return html
}
beforeEach(() => {
  state.connection = 'online'; state.demo = false; state.role = 'admin'; state.capabilities = ['admin.access']
  productionAssignmentAttempts.activate('reset-fixture'); productionAssignmentAttempts.activate(scope)
})

describe('production assignment readable and permit-only controls', () => {
  it('offers real server-permitted start at the exact selected stage', () => {
    const value = fixture(), html = render(value.snapshot, value.rows)
    expect(html).toContain('Bosqichni tayyorlash va ishni boshlash')
    expect(html).toContain('F-123')
    expect(html).toContain('Fixture stage')
    expect(html).toContain('Fixture apparatus')
    expect(html).toContain('Ishni boshlash')
    expect(html).not.toContain('gradient')
  })
  it('shows native freeze state without offering start', () => {
    const value = fixture(); value.snapshot.order_controls = { [orderId]: { state: 'frozen' } }
    const html = render(value.snapshot, value.rows)
    expect(html).toContain('Buyurtma muzlatilgan')
    expect(html).not.toMatch(/>Ishni boshlash<\/button>/)
  })
  it('offers explicitly labelled lamination handoff for Aparatchi while leaving generic legacy pause absent', () => {
    state.role = 'aparatchi'
    const value = fixture('laminate', 'in_progress'), html = render(value.snapshot, value.rows)
    expect(html).toContain('Ishni topshirish')
    expect(html).not.toContain('To‘xtatish va hisobot')
  })
  it('keeps offline state visible and disables the native action button', () => {
    state.connection = 'offline'
    const value = fixture(), html = render(value.snapshot, value.rows)
    expect(html).toContain('Aloqa uzilgan')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Ishni boshlash<\/button>/)
  })
  it('restores a dispatched uncertain stage after detail remount and leaves fresh action buttons locked', () => {
    const value = fixture(), session = { profile: { role: 'admin', ref: 'fixture-worker' }, capabilities: ['admin.access'] } as Session
    const plan = productionAssignmentCommand(value.snapshot, orderId, session, value.rows, app, 'start', {}, 'fixture-key')
    const lease = productionAssignmentAttempts.begin(scope, plan, { summary: [], sessionId: '', batchId: '' })
    productionAssignmentAttempts.dispatched(lease); productionAssignmentAttempts.interrupt(lease)
    for (let reopened = 0; reopened < 2; reopened++) {
      const html = render(value.snapshot, value.rows)
      expect(html).toContain('Amal natijasi noaniq')
      expect(html).toContain('Holatni qayta tekshirish')
      expect(html).toContain('Oddiy yangilash yoki oynani yopish')
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Ishni boshlash<\/button>/)
    }
    expect(productionAssignmentAttempts.get(scope, orderId)?.plan.body).toEqual(plan.body)
  })
  it.each(['legacy-control', 'completion', 'material-intake'] as const)('locks an already available start when the same order is owned by %s', channel => {
    const value = fixture(), lease = productionOperationLedger.begin(scope, { channel, orderId, plan: { body: { order_id: orderId } }, proof: {} })
    const pending = render(value.snapshot, value.rows)
    expect(pending).toContain('boshqa ishlab chiqarish amali')
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Ishni boshlash<\/button>/)
    productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    const reopened = render(value.snapshot, value.rows)
    expect(reopened).toContain('avvalgi natija aniqlanguncha yopiq')
    expect(productionAssignmentAttempts.get(scope, orderId)).toBeNull()
  })
})
