import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient, ApiError } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { WipAdminControls, WipAdminToolbar, OrderWipAdminControls } from './wip-admin-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const orderId = 'zakaz-wip-1', source = 'apparatus:test:print-1', target = 'apparatus:test:laminate-1', scope = 'wip-scope-one'
const openingBatch = { batch_id: 'opening-roll-1', intake_id: 'native-intake', order_id: orderId, sequence_no: 1, qr_payload: 'progress:opening-roll-1', quantity_basis: 'measured', quantity: 100, uom: 'm', finished_goods_meter: 100, finished_goods_kg: 25, bobina_kg: 1, diameter: null, wip_status: 'waiting', used_by_session_id: '', used_by_apparatus: '', processed_by_session_id: '', processed_by_apparatus: '', updated_at_unix: 1791885600 }
const intake = { intake_id: 'native-intake', idempotency_key: 'native-key', order_id: orderId, entry_apparatus: source, source_apparatus: source, source_operation: 'print', resume_stage_node_id: 'print', resume_apparatus: '', current_location: '', status: 'confirmed', updated_at_unix: 1791885600 }
const progressBatch = { batch_id: 'progress-roll-1', order_id: orderId, qr_payload: 'progress:progress-roll-1', wip_status: 'waiting', finished_goods_meter: 100, finished_goods_kg: 25, bobina_kg: 1, current_location: 'Native printer placement', next_apparatus: 'historical-destination' }
const map = { id: orderId, title: 'Native order', nodes: [{ id: 'start', kind: 'start' }, { id: 'print', kind: 'apparatus', apparatus_id: source, title: 'Native printer' }, { id: 'laminate', kind: 'apparatus', apparatus_id: target, title: 'Native laminator' }, { id: 'end', kind: 'end' }], edges: [{ from: 'start', to: 'print' }, { from: 'print', to: 'laminate' }, { from: 'laminate', to: 'end' }] }

function actor(capabilities = ['admin.access', 'production.map.manage'], role = 'admin', demo = false, currentScope = scope) {
  const session: Session = { token: 'local-test', profile: { role, display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, scope: currentScope, demo, endpoint: 'http://127.0.0.1:5199', client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
function cache(options: { batch?: Row; frozen?: boolean; routeError?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  queryClient.setQueryData(['wip-admin', scope, 'opening-detail', orderId, openingBatch.batch_id], { intake, batch: options.batch ?? openingBatch })
  queryClient.setQueryData(['wip-admin', scope, 'batch-detail', orderId, progressBatch.batch_id], progressBatch)
  queryClient.setQueryData([scope, 'production-snapshot'], { ok: true, rev: 1, epoch: 'fixture', scope: 'all', maps: [{ map, program: { map_id: orderId, operations: [] } }], order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'not_started' } }, stage_states: { [orderId]: { print: 'pending', laminate: 'pending' } }, order_controls: options.frozen ? { [orderId]: { state: 'frozen' } } : {}, queue_states: {}, queue_action_controls: {}, sequences: {}, order_customers: {} })
  queryClient.setQueryData(['wip-admin', scope, 'route', orderId, progressBatch.batch_id], { batch: progressBatch, route: options.routeError ? null : { source_stage_node_id: 'print', stage_node_id: 'laminate', consumer_apparatus_ids: [target], map_fingerprint: 'native-fingerprint', remapped: true }, routeError: options.routeError ?? '', activeOrderValidated: true })
  queryClient.setQueryData(['wip-admin', scope, 'opening-records', orderId], [{ intake, batches: [openingBatch] }])
  return queryClient
}
const render = (client: QueryClient, element: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('WIP maintenance entry points and retained server facts', () => {
  it('offers read-only WIP to queue readers and hides creation/cancellation they cannot authorize', () => {
    actor(['apparatus.queue.read'], 'aparatchi')
    const html = render(cache(), <><WipAdminToolbar /><WipAdminControls kind="opening-wip" row={openingBatch} /></>)
    expect(html).toContain('Boshlang‘ich WIP yaratish uchun ruxsat berilmagan')
    expect(html).toContain('100 m · 25 kg')
    expect(html).not.toContain('Rulonni bekor qilish')
    expect(html).not.toContain('Kirish mosligini tekshirish')
  })

  it('does not grant actual-admin cancellation to a worker holding admin.access', () => {
    actor(['admin.access'], 'aparatchi')
    const html = render(cache(), <WipAdminControls row={{ ...openingBatch, intake }} />)
    expect(html).toContain('Bekor qilish haqiqiy admin hisobiga ruxsat etiladi')
    expect(html).not.toContain('Rulonni bekor qilish')
  })

  it('retains native placement and current route facts while exposing no unsupported move/undo action', () => {
    actor()
    const html = render(cache(), <WipAdminControls kind="wip" row={progressBatch} />)
    expect(html).toContain('Native printer placement')
    expect(html).toContain('Server kirish bosqichi: laminate')
    expect(html).toContain('Joriy xaritaga qayta bog‘langan')
    expect(html).not.toContain('historical-destination')
    expect(html).toContain('Kirish mosligini tekshirish')
    expect(html).toContain('ko‘chirish yoki ishlovni ortga qaytarish amali mavjud emas')
  })

  it('locks intake preview when the server route is ambiguous or the order is frozen', () => {
    actor()
    const ambiguous = render(cache({ routeError: 'wip_route_ambiguous' }), <WipAdminControls kind="wip" row={progressBatch} />)
    expect(ambiguous).toContain('Kirish yo‘li tasdiqlanmagan: wip_route_ambiguous')
    expect(ambiguous).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Kirish mosligini tekshirish/)
    const frozen = render(cache({ frozen: true }), <WipAdminControls kind="opening-wip" row={openingBatch} />)
    expect(frozen).toContain('Muzlatilgan yoki muzlatish kutilayotgan buyurtmaga WIP kiritilmaydi')
    expect(frozen).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Kirish mosligini tekshirish/)
  })

  it('shows used-roll locks without offering an optimistic cancellation', () => {
    actor()
    const html = render(cache({ batch: { ...openingBatch, used_by_session_id: 'native-session' } }), <WipAdminControls kind="opening-wip" row={openingBatch} />)
    expect(html).toContain('Faqat foydalanilmagan kutayotgan rulon bekor qilinadi')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Rulonni bekor qilish/)
  })

  it('blocks a retained batch after a denied refresh and shows a recoverable error', () => {
    actor()
    const queryClient = cache()
    queryClient.getQueryCache().find({ queryKey: ['wip-admin', scope, 'opening-detail', orderId, openingBatch.batch_id] })!.setState({ status: 'error', error: new ApiError(403, 'forbidden') })
    const html = render(queryClient, <WipAdminControls kind="opening-wip" row={openingBatch} />)
    expect(html).toContain('Bu amal uchun ruxsat berilmagan')
    expect(html).toContain('Qayta yuklash')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Rulonni bekor qilish/)
  })

  it('keeps old-account batches and cached summaries out of a changed session or denied scope', () => {
    const queryClient = cache()
    actor(['admin.access'], 'admin', false, 'wip-scope-two')
    expect(render(queryClient, <WipAdminControls kind="opening-wip" row={openingBatch} />)).not.toContain('100 m · 25 kg')
    actor([], 'aparatchi')
    const html = render(queryClient, <OrderWipAdminControls row={map} />)
    expect(html).toContain('WIP holatini o‘qish uchun ruxsat berilmagan')
    expect(html).not.toContain('native-intake')
  })

  it('keeps writes disabled while live batch state is loading and makes no demo requests', () => {
    actor()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const loading = render(queryClient, <WipAdminControls kind="opening-wip" row={openingBatch} />)
    expect(loading).toContain('data-slot="skeleton"')
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Rulonni bekor qilish/)
    actor(['admin.access'], 'admin', true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const demo = render(cache(), <><WipAdminToolbar /><WipAdminControls kind="opening-wip" row={openingBatch} /></>)
    expect(demo).toContain('Ko‘rish rejimida')
    expect(demo).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Boshlang‘ich WIP qabul qilish/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
