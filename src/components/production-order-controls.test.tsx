import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionSnapshot, Session } from '@/lib/api-types'
import { productionOrderCommand, productionReorderCommand } from '@/lib/production-controls'
import { productionOperationLedger } from '@/lib/production-operation-ledger'

const orderId = 'zakaz-control-ui', otherId = 'zakaz-control-other', apparatus = 'apparatus:print:fixture', scope = 'fixture-control-scope'
const state = vi.hoisted(() => ({ connection: 'online', demo: false }))
const session = { token: 'fixture-token', profile: { role: 'admin', ref: 'fixture-admin', display_name: 'Fixture admin' }, capabilities: ['admin.access'] } as Session
vi.mock('@/lib/session', () => ({ useSession: () => ({ session: { token: 'fixture-token', profile: { role: 'admin', ref: 'fixture-admin', display_name: 'Fixture admin' }, capabilities: ['admin.access'] },
  scope: 'fixture-control-scope', client: {}, demo: state.demo, connection: state.connection, reconnect: vi.fn() }) }))
import { ProductionOrderControls } from './production-order-controls'

function snapshot(pending = false): ProductionSnapshot {
  const queueState = pending ? 'pending' : 'in_progress'
  return { ok: true, epoch: 'fixture-epoch', scope: '', rev: 1,
    maps: [orderId, otherId].map(id => ({ map: { id, order_number: 'CONTROL-123', title: 'Fixture order', nodes: [{ id: 'print', kind: 'apparatus', title: 'Fixture print', apparatus_id: apparatus }], edges: [] }, program: {} })),
    order_statuses: { [orderId]: { lifecycle_status: pending ? 'released' : 'in_progress', order_status: pending ? 'ready' : 'in_progress' }, [otherId]: { lifecycle_status: 'released', order_status: 'ready' } }, order_customers: {}, order_controls: {}, stage_states: {},
    sequences: { [apparatus]: [orderId, otherId] }, sequence_versions: { [apparatus]: 'a'.repeat(64) }, sequence_revisions: { [apparatus]: 1 }, visible_order_ids: { [apparatus]: [orderId, otherId] },
    queue_states: { [apparatus]: { [orderId]: queueState, [otherId]: 'pending' } }, queue_action_controls: { [apparatus]: { [orderId]: { state: queueState, stage_node_id: 'print', allowed_actions: pending ? ['start'] : ['pause'], previous_stage_ready: true, complete_requires_full_report: false,
      interaction: { mode: pending ? 'fresh_start' : 'in_progress', start_materials_mode: 'hidden', material_scan_required: false, assigned_materials_display_only: true, material_intake_allowed: false,
        previous_wip_mode: 'not_required', opening_wip_mode: 'not_required', qolip_mode: 'not_required', resume_input_required: false } } } } }
}
function render(value = snapshot()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData([scope, 'production-snapshot'], value)
  client.setQueryData([scope, 'production-control-apparatus'], { items: [{ apparatus_id: apparatus, source_revision: 1, display: { display_name: 'Fixture press' }, execution_profile: { operation: 'print' }, lifecycle: { state: 'active' } }], hasMore: false })
  const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><ProductionOrderControls row={value.maps[0].map} /></QueryClientProvider></MemoryRouter>)
  client.clear(); return html
}
function disabled(html: string, label: string) {
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes(label))
  expect(button, `Expected button ${label}`).toBeDefined()
  return button![1].includes('disabled=""')
}
beforeEach(() => { state.demo = false; state.connection = 'online'; productionOperationLedger.activate('reset'); productionOperationLedger.activate(scope) })

describe('legacy production controls share order ownership and retain uncertainty', () => {
  it('offers permitted controls when the selected order is unowned', () => {
    const html = render()
    expect(disabled(html, 'Muzlatish')).toBe(false)
    expect(html).toContain('CONTROL-123')
  })
  it.each(['assignment', 'completion', 'material-intake'] as const)('disables current legacy controls while %s owns the same order', channel => {
    const lease = productionOperationLedger.begin(scope, { channel, orderId, plan: { body: { order_id: orderId } }, proof: {} })
    expect(disabled(render(), 'Muzlatish')).toBe(true)
    productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    const reopened = render()
    expect(disabled(reopened, 'Muzlatish')).toBe(true)
    expect(reopened).toContain('boshqa ishlab chiqarish amali')
  })
  it('retains unkeyed command uncertainty across detail remount and a newer current-state read', () => {
    const value = snapshot(), plan = productionOrderCommand(value, orderId, session, 'freeze')
    const lease = productionOperationLedger.begin(scope, { channel: 'legacy-control', orderId, plan, proof: { actor: { role: 'admin', ref: 'fixture-admin' } } })
    productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    value.rev = 2; value.order_controls = { [orderId]: { order_id: orderId, state: 'frozen' } }
    for (let reopened = 0; reopened < 2; reopened++) {
      const html = render(value)
      expect(html).toContain('Amal natijasi noaniq')
      expect(html).toContain('Joriy holatni o‘qish')
      expect(html).toContain('aniq hisobotini tasdiqlamaydi')
      expect(html).not.toContain('Navbat buyrug‘i natijasini qayta tekshirish')
      expect(disabled(html, 'Muzlatishni olib tashlash')).toBe(true)
    }
    expect(productionOperationLedger.get(scope, orderId)?.plan).toEqual(plan)
  })
  it('offers only original-key reorder recovery while retaining the saved body after remount', () => {
    const value = snapshot(true), plan = productionReorderCommand(value, orderId, session, apparatus, 'move_down', 'native-original-key')
    const lease = productionOperationLedger.begin(scope, { channel: 'legacy-control', orderId, plan, proof: { actor: { role: 'admin', ref: 'fixture-admin' } } })
    productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    const html = render(value)
    expect(html).toContain('Navbat buyrug‘i natijasini qayta tekshirish')
    expect(productionOperationLedger.get<typeof plan>(scope, orderId)?.plan.body.idempotency_key).toBe('native-original-key')
  })
  it('does not hold another order because an unrelated completion is pending', () => {
    productionOperationLedger.begin(scope, { channel: 'completion', orderId: otherId, plan: { body: { order_id: otherId } }, proof: {} })
    expect(disabled(render(), 'Muzlatish')).toBe(false)
  })
})
