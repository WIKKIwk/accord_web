import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionSnapshot, Session } from '@/lib/api-types'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import { productionSequenceMove } from '@/lib/production-sequence'

const state = vi.hoisted(() => ({ demo: false, connection: 'online' as string, capabilities: ['admin.access'] }))
const app = 'apparatus:queue:fixture', scope = 'synthetic-sequence-ui', a = 'order-a', b = 'order-b', active = 'order-running', frozen = 'order-frozen'
const actor = { role: 'admin', ref: 'synthetic-admin', display_name: 'QA' }
const session = { token: 'synthetic', profile: actor, capabilities: ['admin.access'] } as Session
vi.mock('@/lib/session', () => ({ useSession: () => ({ client: {}, session: { profile: { role: 'admin', ref: 'synthetic-admin', display_name: 'QA' }, capabilities: state.capabilities }, scope: 'synthetic-sequence-ui', demo: state.demo, connection: state.connection, reconnect: vi.fn() }) }))
import { ProductionSequenceQueue } from './production-sequence-queue'
function snapshot(): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'synthetic-epoch', scope: '', maps: [a, b, active, frozen].map(id => ({ map: { id, order_number: id, title: 'DEMO Product', nodes: [], edges: [] }, program: {} })),
    order_statuses: {}, order_controls: { [frozen]: { state: 'frozen' } }, order_customers: {}, queue_action_controls: {}, stage_states: {},
    queue_states: { [app]: { [active]: 'in_progress', [a]: 'pending', [b]: 'pending', [frozen]: 'frozen' } }, sequences: { [app]: [active, a, b] }, visible_order_ids: { [app]: [active, a, b, frozen] }, sequence_versions: { [app]: 'a'.repeat(64) } }
}
function render(value = snapshot()) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  query.setQueryData([scope, 'production-snapshot'], value); query.setQueryData([scope, 'production-control-apparatus'], { items: [], hasMore: false })
  const markup = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={query}><ProductionSequenceQueue apparatusId={app} onApparatusChange={vi.fn()} /></QueryClientProvider></MemoryRouter>)
  query.clear(); return markup
}
function isDisabled(markup: string, label: string) {
  const match = [...markup.matchAll(/<button\b([^>]*)>/g)].find(item => item[1].includes(`aria-label="${label}"`))
  expect(match, label).toBeDefined(); return match![1].includes('disabled=""')
}
beforeEach(() => { state.demo = false; state.connection = 'online'; state.capabilities = ['admin.access']; productionOperationLedger.activate('reset'); productionOperationLedger.activate(scope) })
describe('apparatus sortable queue accessibility and write ownership', () => {
  it('renders semantic rows, named drag handles, keyboard instructions and button alternatives', () => {
    const markup = render()
    expect(markup).toContain('<table'); expect(markup).toContain('<tbody '); expect(markup).toContain('Escape: bekor qilish')
    expect(isDisabled(markup, `Navbatni surish: ${b}`)).toBe(false); expect(isDisabled(markup, `${b}: navbatda oldinga`)).toBe(false)
    expect(isDisabled(markup, `Navbatni surish: ${active}`)).toBe(true); expect(isDisabled(markup, `Navbatni surish: ${frozen}`)).toBe(true)
    expect(isDisabled(markup, `${a}: navbatda oldinga`)).toBe(true)
  })
  it.each(['assignment', 'completion', 'material-intake', 'material-link', 'legacy-control'] as const)('blocks the order while %s owns its production operation', channel => {
    const lease = productionOperationLedger.begin(scope, { channel, orderId: b, plan: {}, proof: {} }); productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    const markup = render(); expect(isDisabled(markup, `Navbatni surish: ${b}`)).toBe(true); expect(isDisabled(markup, `Navbatni surish: ${a}`)).toBe(false)
    expect(markup).toContain('avvalgi ishlab chiqarish amali')
  })
  it('blocks the entire apparatus while a legacy sequence writer on another order is unresolved', () => {
    const lease = productionOperationLedger.begin(scope, { channel: 'legacy-control', orderId: 'hidden-other-order', apparatusId: app, plan: {}, proof: {} }); productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    const markup = render(); expect(isDisabled(markup, `Navbatni surish: ${a}`)).toBe(true); expect(markup).toContain('boshqa navbat buyrug‘i'); expect(markup).toContain('hidden-other-order')
  })
  it('keeps original-key recovery available after the moved row disappears from visible membership', () => {
    const value = snapshot(), plan = productionSequenceMove(value, app, b, 1, session, 'original-key')!
    const lease = productionOperationLedger.begin(scope, { channel: 'sequence-reorder', orderId: b, apparatusId: app, plan, proof: { actor: plan.actor } }); productionOperationLedger.dispatched(lease); productionOperationLedger.interrupt(lease)
    value.visible_order_ids = { [app]: [active, a, frozen] }; value.epoch = 'new-server-epoch'; value.sequence_versions = {}
    const markup = render(value)
    expect(markup).toContain('Navbat buyrug‘i natijasi noaniq'); expect(markup).toContain('Asl navbat buyrug‘i natijasini tekshirish'); expect(markup).toContain('Buyurtma № order-b')
    expect(isDisabled(markup, `Navbatni surish: ${a}`)).toBe(true); expect(productionOperationLedger.get<typeof plan>(scope, b)?.plan.body.idempotency_key).toBe('original-key')
  })
  it.each(['demo', 'offline', 'queue-only'] as const)('shows readable queue with disabled writes for %s', mode => {
    if (mode === 'demo') state.demo = true; if (mode === 'offline') state.connection = 'offline'; if (mode === 'queue-only') state.capabilities = ['apparatus.queue.read', 'apparatus.queue.manage']
    const markup = render(); expect(markup).toContain('DEMO Product'); expect(isDisabled(markup, `Navbatni surish: ${b}`)).toBe(true)
  })
})
