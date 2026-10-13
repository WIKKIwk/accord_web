import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ApiClient, ApiError } from '@/lib/api'
import type { Page, ProductionSnapshot, Session } from '@/lib/api-types'
import { dashboardOrderCounts, dashboardOrders } from '@/lib/dashboard'
import { useSession } from '@/lib/session'
import { DashboardPage } from './DashboardPage'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const apparatus = 'apparatus:default:pechat'
let sequence = 0
function snapshot(): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'fixture', scope: 'admin', maps: ['running', 'paused', 'waiting', 'unknown'].map(id => ({
    map: { id, order_number: `QA-${id}`, title: `Fixture ${id}`, order_kg: 100, product_code: 'film', nodes: [{ id: 'print', kind: 'apparatus', title: 'QA Flexo', apparatus_id: apparatus }], edges: [] }, program: {},
  })), order_statuses: { running: { lifecycle_status: 'in_progress', order_status: 'in_progress' }, paused: { lifecycle_status: 'in_progress', order_status: 'paused' }, waiting: { lifecycle_status: 'in_progress', order_status: 'ready' } },
  order_controls: { running: { state: 'freeze_requested' } }, order_customers: {}, sequences: { [apparatus]: ['running', 'paused', 'waiting'] }, visible_order_ids: { [apparatus]: ['running', 'paused', 'waiting', 'unknown'] }, queue_states: { [apparatus]: { running: 'in_progress', paused: 'paused', waiting: 'pending' } }, stage_states: {}, queue_action_controls: {} }
}
function setup(capabilities = ['admin.access'], offline = false, noClient = false) {
  const scope = `home-view-${++sequence}`, session: Session = { token: 'fixture-token', profile: { role: 'admin', ref: 'fixture-admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  vi.mocked(useSession).mockReturnValue({ scope, session, client: noClient ? null : new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), endpoint: 'https://erp.example.test', demo: false, restoring: false, connection: offline ? 'offline' : 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } } })
  return { scope, queryClient, fetch }
}
function seed(queryClient: QueryClient, scope: string, production = snapshot()) {
  queryClient.setQueryData([scope, 'production-snapshot'], production)
  const pages: [string, string, Page][] = [
    ['completion', 'all', { items: [{ event_id: 'request-1', order_id: 'running', order_number: 'QA-running', order_title: 'Fixture running', apparatus_name: 'QA Flexo', worker_display_name: 'Operator' }], hasMore: false, bounded: true }],
    ['wip', 'waiting', { items: [{ batch_id: 'roll-1', produced_qty: 1000, uom: 'm', wip_status: 'waiting' }, { batch_id: 'roll-2', produced_qty: 10, uom: 'kg', wip_status: 'waiting' }, { batch_id: 'return', wip_status: 'waiting', payload_json: { origin: 'layer_remainder' } }], hasMore: false, bounded: true }],
    ['wip', 'in_use', { items: [{ batch_id: 'roll-3', produced_qty: 500, uom: 'm', wip_status: 'in_use' }], hasMore: false }],
    ['warehouses', 'all', { items: [{ warehouse: 'QA Warehouse' }], hasMore: false, bounded: true }],
  ]
  for (const [kind, status, page] of pages) queryClient.setQueryData([scope, 'dashboard', kind, status], page)
}
function render(queryClient: QueryClient) { return renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter><DashboardPage /></MemoryRouter></QueryClientProvider>) }
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('Home executive manufacturing view', () => {
  it('keeps overlapping KPI meanings while exclusive status segments sum to the loaded cohort and include unknown orders', () => {
    const { scope, queryClient, fetch } = setup(); const production = snapshot(); seed(queryClient, scope, production)
    expect(dashboardOrderCounts(dashboardOrders(production))).toMatchObject({ total: 4, running: 1, queued: 1, attention: 2, unknown: 1 })
    const html = render(queryClient), segments = [...html.matchAll(/data-status-segment="([^"]+)" data-order-count="(\d+)"/g)]
    expect(segments.map(match => match[1]).sort()).toEqual(['in_progress', 'paused', 'ready', 'unknown'])
    expect(segments.reduce((sum, match) => sum + Number(match[2]), 0)).toBe(4)
    expect(segments.every(match => match[2] === '1')).toBe(true)
    expect(html).toContain('bir buyurtmaga birga tegishli bo‘lishi mumkin')
    expect(html).toContain('1 ta buyurtma holati noma’lum')
    expect(html).toContain('Ish maydoni')
    expect(html.indexOf('Buyurtmalar taqsimoti')).toBeLessThan(html.indexOf('aria-label="Buyurtmalar holati va ishlab chiqarish bosqichlari"'))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('compares observed queue counts with explicit units and preserves exact native attention drilldowns', () => {
    const { scope, queryClient } = setup(); seed(queryClient, scope)
    const html = render(queryClient)
    expect(html).toContain('aria-label="QA Flexo: 4 ko‘rinadigan buyurtma"')
    expect(html).toContain('Navbat soni uskuna sig‘imi yoki kutish vaqtini bildirmaydi')
    expect(html).toContain('Muzlatish so‘rovi kutilmoqda')
    expect(html).toContain('/app/orders?selected=running')
    expect(html).toContain('/app/orders?selected=paused')
    expect(html).toContain('Jadvalda ko‘rish')
    expect(html).not.toContain('OEE')
    expect(html).not.toContain('gradient')
  })

  it('retains capped completion/WIP/warehouse bounds without summing incompatible quantities or returned material', () => {
    const { scope, queryClient } = setup(); seed(queryClient, scope)
    const html = render(queryClient)
    expect(html).toContain('Yuklangan qism · + kamida shuncha')
    expect(html).toContain('>2+</span>')
    expect(html).toContain('1+ ta ombor')
    expect(html).toContain('Partiyalar soni · keyingi bosqich yoki ombor kutilmoqda')
    expect(html).toContain('Yuklangan qism · + kamida shuncha · Partiyalar soni · keyingi bosqich yoki ombor kutilmoqda')
    expect(html).toContain('/app/completion?selected=request-1')
    expect(html).toContain('aria-label="Buyurtma yoki mijozni qidirish"')
    expect(html).toContain('aria-label="Buyurtmalar holati bo‘yicha filtr"')
    expect(html).not.toContain('1010')
  })

  it('keeps all KPI meanings and bounds in a native mobile disclosure and makes complete cells accessible links to their values', () => {
    const { scope, queryClient } = setup(); seed(queryClient, scope)
    const html = render(queryClient), disclosure = html.match(/<details[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(disclosure).toContain('<summary')
    expect(disclosure).toContain('Hisob qamrovi · + kamida, — noma’lum')
    for (const title of ['Jarayondagi buyurtmalar', 'Kutilayotgan buyurtmalar', 'E’tibor kerak', 'Yakunlash so‘rovlari', 'Kutilayotgan WIP', 'Ishdagi WIP']) expect(disclosure).toContain(title)
    expect(disclosure).toContain('Yuklangan qism · + kamida shuncha · Partiyalar soni')
    const valueDescriptions = [...html.matchAll(/aria-describedby="dashboard-value-(\d+)"/g)]
    expect(valueDescriptions.length).toBe(6)
    for (const match of valueDescriptions) expect(html).toContain(`id="dashboard-value-${match[1]}"`)
    expect(html).toContain('Kamida shuncha')
    expect(html).toContain('aria-label="Yuklangan buyurtmalar holati:')
  })

  it('uses the real dashboardcn card structure for KPI values while keeping the status legend a native legend', () => {
    const { scope, queryClient, fetch } = setup(); seed(queryClient, scope)
    const html = render(queryClient)
    expect((html.match(/data-slot="kpi-card"/g) ?? []).length).toBe(6)
    expect(html).toContain('data-slot="metric-value"')
    expect((html.match(/data-slot="card-header"/g) ?? []).length).toBe(6)
    expect((html.match(/data-slot="card-description"/g) ?? []).length).toBe(6)
    expect((html.match(/data-slot="card-title"/g) ?? []).length).toBe(6)
    expect((html.match(/data-slot="card-content"/g) ?? []).length).toBe(6)
    expect(html).not.toContain('data-slot="metric-list"')
    const legend = html.match(/<ul[^>]*aria-label="Yuklangan buyurtmalar holatlari"[\s\S]*?<\/ul>/)?.[0] ?? ''
    expect((legend.match(/<li /g) ?? []).length).toBe(4)
    expect(html).toContain('aria-label="Yuklangan buyurtmalar holatlari"')
    expect(html).toContain('grid grid-cols-3')
    expect(html).not.toContain('data-slot="sparkline"')
    expect(html).not.toContain('data-slot="delta-badge"')
    expect(html).not.toContain('recharts')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps role-gated sections and links hidden even when their data is already cached', () => {
    const { scope, queryClient } = setup(['apparatus.queue.read']); seed(queryClient, scope)
    const html = render(queryClient)
    expect(html).not.toContain('Uskunalar navbati taqqoslanishi')
    expect(html).not.toContain('Kutilayotgan WIP')
    expect(html).not.toContain('Yakunlash kutilmoqda')
    expect(html).not.toContain('Yakunlash so‘rovlari bo‘limini ochish')
    expect(html).not.toContain('/app/completion')
    expect(html).not.toContain('Foydalanuvchilar bo‘limini ochish')
  })

  it('discloses retained offline/error facts and never draws zero-valued status segments without a snapshot', () => {
    const retained = setup(['admin.access'], true); seed(retained.queryClient, retained.scope)
    const offline = render(retained.queryClient)
    expect(offline).toContain('Server bilan aloqa uzilgan')
    expect(offline).toContain('Oxirgi kuzatuv')
    expect(offline).toContain('Oxirgi yuklangan holat')
    const query = retained.queryClient.getQueryCache().find({ queryKey: [retained.scope, 'production-snapshot'] })!
    query.setState({ status: 'error', error: new ApiError(500, 'private_store_error', 'Holat yuklanmadi.'), fetchStatus: 'idle' })
    expect(render(retained.queryClient)).toContain('Oxirgi yuklangan ma’lumotlar ko‘rsatilmoqda')
    const missing = setup(['admin.access'], false, true)
    const unknown = render(missing.queryClient)
    expect(unknown).toContain('Holat ma’lumotlari kutilmoqda')
    expect(unknown).not.toContain('data-status-segment=')
    expect(unknown).not.toContain('ko‘rinadigan buyurtma"')
    expect(missing.fetch).not.toHaveBeenCalled()
  })
})
