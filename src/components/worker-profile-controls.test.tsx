import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ApiClient, ApiError } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { parseWorkerBatch, parseWorkerProfile } from '@/lib/worker-profile'
import type { WorkerProfile } from '@/lib/worker-profile'
import { WorkerProfileControls, WorkerProfileSummary, WorkerRecordDetail } from './worker-profile-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const apparatus = 'apparatus:default:pechat'
const person = { id: 'worker_1', name: 'Ali', phone: '+998900000001', level: 'Master', code: 'SECRET-LOGIN-CODE', avatar_url: '/profile?token=SECRET-TOKEN' }
const run = { session_id: 'session-1', apparatus, order_id: 'zakaz-0042', status: 'paused', worker_role: 'aparatchi', worker_ref: person.id, worker_display_name: person.name, started_at_unix: 100, updated_at_unix: 200, payload_json: { token: 'SECRET-TOKEN' } }
const batch = { batch_id: 'batch-1', revision: 2, session_id: 'session-1', apparatus, order_id: 'zakaz-0042', action: 'complete', status: 'completed', produced_qty: 100, uom: 'm', started_at_unix: 100, completed_at_unix: 200, worker_role: 'aparatchi', worker_ref: person.id, worker_display_name: person.name, executor_name: person.name, label_item_code: 'SKU-1', label_item_name: 'Plyonka', wip_status: 'waiting', finished_goods_kg: 0, finished_goods_meter: 100, description: 'Native note' }
const event = { event_id: 'event-1', apparatus, order_id: 'zakaz-0042', action: 'complete', from_state: 'in_progress', to_state: 'completed', actor_role: 'aparatchi', actor_ref: person.id, actor_display_name: person.name, created_at_unix: 200, completed_with_issue: true, issue_note: 'Tekshirish kerak' }
const profile = parseWorkerProfile({ worker: person, assigned_apparatus: [apparatus], assigned_groups: [], active_sessions: [run], recent_batches: [batch], recent_logs: [event] }, person.id)
let sequence = 0
function setup(capabilities = ['admin.access', 'role.capability.read'], demo = false) {
  const scope = `worker-test-${++sequence}`
  const session: Session = { token: 'fixture-session', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), demo, endpoint: 'https://erp.example.test', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  return { scope, queryClient: new QueryClient() }
}
function seed(queryClient: QueryClient, scope: string, value: WorkerProfile) {
  queryClient.setQueryData(['worker-profile', scope, value.worker.id], value)
  queryClient.setQueryData(['worker-profile-apparatus', scope], { labels: { [apparatus]: 'Bosma 1' }, bounded: false })
  queryClient.setQueryData(['worker-profile-role', scope, value.worker.id], { role_id: 'quality', role: { id: 'quality', label: 'Sifat nazorati', capability_count: 2 }, assigned_apparatus: [apparatus], assigned_item_groups: ['Plyonka'] })
}
function render(children: ReactNode, queryClient = new QueryClient()) { return renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>) }
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('native worker profile read-only presentation', () => {
  it('renders the native profile, canonical assignments, bounded record counts, and record detail action', () => {
    const { scope, queryClient } = setup(); seed(queryClient, scope, profile)
    const html = render(<WorkerProfileControls row={person} />, queryClient)
    for (const text of ['Ishchi faoliyati', 'Yuklangan qaydlar', 'ko‘pi bilan 50', '100 hodisa', 'So‘nggi partiyalar', 'So‘nggi hodisalar', 'Sifat nazorati', '2 ta ruxsat', 'Bosma 1', 'Rol va biriktirishlar', 'Biriktirilgan uskunalar', 'To‘xtatilgan', 'Ishchi guruhlari', 'Guruh biriktirilmagan.', 'Ko‘rish']) expect(html).toContain(text)
    expect(html).toContain('№0042 ish tafsiloti')
    expect(html).not.toContain('SECRET-')
    expect(html).not.toContain('Uskuna nomi mavjud emas')
    expect(html).not.toContain('regenerate')
  })

  it('shows meaningful empty profile activity without substituting fake productive totals', () => {
    const { scope, queryClient } = setup(), empty = { ...profile, assigned_apparatus: [], active_sessions: [], recent_batches: [], recent_logs: [] }; seed(queryClient, scope, empty)
    const html = render(<WorkerProfileControls row={person} />, queryClient)
    expect(html).toContain('Ochiq ishlar yo‘q.')
    expect(html).toContain('Uskuna biriktirilmagan.')
    expect(html).toContain('0 ta')
    expect(html).not.toContain('Samaradorlik')
    expect(html).not.toContain('KPI')
  })

  it('does not expose role assignment data without its separate read capability', () => {
    const { scope, queryClient } = setup(['admin.access']); seed(queryClient, scope, profile)
    const html = render(<WorkerProfileControls row={person} />, queryClient)
    expect(html).toContain('Rol tafsilotlarini ko‘rish uchun ruxsat yetarli emas.')
    expect(html).not.toContain('Sifat nazorati')
    expect(html).not.toContain('2 ta ruxsat')
    expect(html).toContain('Bosma 1')
  })

  it('shows explicit source permissions and demo connection requirements without reading or writing', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    setup(['production.map.manage'])
    expect(render(<WorkerProfileControls row={person} />)).toContain('Ishchi profilini ko‘rish uchun ruxsat yetarli emas.')
    setup(['admin.access'], true)
    expect(render(<WorkerProfileControls row={person} />)).toContain('ERP serveriga ulaning')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renders loading and recoverable native profile errors without leaking internal error codes', () => {
    const { scope, queryClient } = setup()
    expect(render(<WorkerProfileControls row={person} />, queryClient)).toContain('Ishchi profili yuklanmoqda')
    queryClient.setDefaultOptions({ queries: { retryOnMount: false } })
    const query = queryClient.getQueryCache().build(queryClient, { queryKey: ['worker-profile', scope, person.id] })
    query.setState({ status: 'error', error: new ApiError(403, 'private_worker_guard'), fetchStatus: 'idle' })
    const html = render(<WorkerProfileControls row={person} />, queryClient)
    expect(html).toContain('ruxsat yetarli emas')
    expect(html).toContain('Qayta yuklash')
    expect(html).not.toContain('private_worker_guard')
  })

  it('isolates workers and sessions through query identity rather than carrying previous profile data', () => {
    const { scope, queryClient } = setup(); seed(queryClient, scope, profile)
    const other = { ...profile, worker: { ...profile.worker, id: 'worker_2', name: 'Vali' }, assigned_apparatus: [], active_sessions: [], recent_batches: [], recent_logs: [] }; seed(queryClient, scope, other)
    const first = render(<WorkerProfileControls row={{ id: 'worker:worker_1', entity_ref: person.id, principal_role: 'aparatchi' }} />, queryClient)
    const second = render(<WorkerProfileControls row={{ id: 'worker:worker_2', entity_ref: 'worker_2', principal_role: 'aparatchi' }} />, queryClient)
    expect(first).toContain('Ali'); expect(second).toContain('Vali'); expect(second).not.toContain('№0042'); expect(second).toContain('Ochiq ishlar yo‘q.')
    const newer = setup()
    expect(render(<WorkerProfileControls row={person} />, newer.queryClient)).toContain('Ishchi profili yuklanmoqda')
    expect(render(<WorkerProfileControls row={{ id: person.id, principal_role: 'qolipchi' }} />, newer.queryClient)).toBe('')
  })

  it('shows native recorded quantities including zero and excludes missing measurements in batch drilldown', () => {
    const html = render(<WorkerRecordDetail record={parseWorkerBatch(batch)} kind="batch" apparatusLabel="Bosma 1" />)
    expect(html).toContain('100 m')
    expect(html).toContain('Tayyor mahsulot og‘irligi')
    expect(html).toContain('0 kg')
    expect(html).toContain('Tayyor mahsulot uzunligi')
    expect(html).toContain('Native note')
    expect(html).not.toContain('Jami chiqindi qaydi')
    expect(html).not.toContain('Samaradorlik')
  })

  it('keeps exact native session status and issue event history available in drilldown', () => {
    const sessionHtml = render(<WorkerRecordDetail record={profile.active_sessions[0]} kind="session" apparatusLabel="Bosma 1" />)
    expect(sessionHtml).toContain('To‘xtatilgan'); expect(sessionHtml).toContain('session-1'); expect(sessionHtml).not.toContain('SECRET-')
    const eventHtml = render(<WorkerRecordDetail record={profile.recent_logs[0]} kind="event" apparatusLabel="Bosma 1" />)
    expect(eventHtml).toContain('Muammo bilan tugallangan'); expect(eventHtml).toContain('Tekshirish kerak'); expect(eventHtml).toContain('Avvalgi holat'); expect(eventHtml).toContain('Keyingi holat')
  })

  it('describes bounded reads instead of presenting session durations as hours worked', () => {
    const html = render(<WorkerProfileSummary profile={profile} />)
    expect(html).toContain('Yuklangan qaydlar')
    expect(html).toContain('Profil ko‘pi bilan 50')
    expect(html).not.toContain('Ish soati')
    expect(html).not.toContain('Unumdorlik')
    expect(html).not.toContain('100 m')
  })
})
