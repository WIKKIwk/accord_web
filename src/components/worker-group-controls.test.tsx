import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { createWorkerGroupOperation, parseWorkerGroup, workerGroupIntentLedger } from '@/lib/worker-groups'
import { useSession } from '@/lib/session'
import { WorkerGroupList, WorkerGroupObservationView, WorkerGroupRecoveryView, WorkerGroupSummary, WorkerGroupToolbar, WorkerGroupWorkerChoices } from './worker-group-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const worker = { id: 'qa-worker-1', name: 'QA Brigadir', phone: '+998900000021', level: 'Brigader' }
const group = parseWorkerGroup({ apparatus_id: 'apparatus:qa:print-1', apparatus: 'QA Flexo 1', group_code: 'QA GURUH', shift: 'tun', start_time: '20:00', end_time: '08:00', work_days_per_week: 5, start_day: 'tuesday', accounting_enabled: true, worker_ids: [worker.id], workers: [{ ...worker, code: 'SECRET', avatar_url: '/avatar?token=SECRET' }] })
let sequence = 0
function setup(capabilities = ['admin.access'], demo = false, scope = `worker-groups-ui-${++sequence}`) {
  const session: Session = { token: 'synthetic-token', profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), demo, endpoint: 'http://127.0.0.1:5199', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  return scope
}
function render(children: ReactNode) { return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>) }
afterEach(() => vi.clearAllMocks())

describe('worker group admin presentation', () => {
  it('exposes the real worker-page toolbar only with native admin.access', () => {
    setup(); expect(render(<WorkerGroupToolbar />)).toContain('Ishchi guruhlari')
    setup(['production.map.manage', 'role.capability.manage']); expect(render(<WorkerGroupToolbar />)).toBe('')
    setup(['admin.access'], true); const demo = render(<WorkerGroupToolbar />)
    expect(demo).toContain('disabled=""'); expect(demo).toContain('Ko‘rish rejimida')
  })
  it('surfaces unresolved RAM intent after toolbar remount while keeping another scope isolated', () => {
    const scope = setup(), ledger = workerGroupIntentLedger(scope), operation = createWorkerGroupOperation(group)
    ledger.begin(operation); ledger.unknown(operation)
    expect(render(<WorkerGroupToolbar />)).toContain('Tekshirish kerak')
    setup(['admin.access'], false, scope); expect(render(<WorkerGroupToolbar />)).toContain('Tekshirish kerak')
    setup(); expect(render(<WorkerGroupToolbar />)).not.toContain('Tekshirish kerak')
    ledger.finish(operation)
  })
  it('shows apparatus identity, overnight schedule, accounting and actual members without credentials', () => {
    const html = render(<WorkerGroupList groups={[group]} search="" onEdit={vi.fn()} />)
    for (const label of ['QA GURUH', 'QA Flexo 1', group.apparatus_id, 'tun', '20:00', '08:00', 'Haftada 5 kun', 'Seshanbadan', 'Yoqilgan', 'QA Brigadir', 'Brigader', 'QA GURUH guruhini tahrirlash']) expect(html).toContain(label)
    expect(html).not.toContain('SECRET'); expect(html).not.toContain('gradient'); expect(html).not.toContain('O‘chirish')
  })
  it('separates the empty directory, nonmatching search, no members and absent member enrichment', () => {
    expect(render(<WorkerGroupList groups={[]} search="" onEdit={vi.fn()} />)).toContain('hali yo‘q')
    expect(render(<WorkerGroupList groups={[group]} search="absent" onEdit={vi.fn()} />)).toContain('Qidiruvga mos guruh topilmadi')
    expect(render(<WorkerGroupList groups={[{ ...group, worker_ids: [], workers: [] }]} search="" onEdit={vi.fn()} />)).toContain('Guruhga ishchi biriktirilmagan')
    const missing = render(<WorkerGroupList groups={[{ ...group, workers: [] }]} search="" onEdit={vi.fn()} />)
    expect(missing).toContain('ishchi tafsiloti mavjud emas'); expect(missing).toContain(worker.id)
  })
  it('searches the actual group/worker names and preserves membership bound messaging', () => {
    expect(render(<WorkerGroupList groups={[group]} search="brigadir" onEdit={vi.fn()} />)).toContain('QA GURUH')
    const html = render(<WorkerGroupWorkerChoices catalog={{ items: [worker], bounded: true }} selected={[]} assigned={new Map([[worker.id, group]])} disabled={false} onChange={vi.fn()} />)
    expect(html).toContain('QA GURUH / QA Flexo 1 guruhiga biriktirilgan'); expect(html).toContain('disabled=""')
    expect(html).toContain('Ko‘pi bilan 500 ta natija'); expect(html).not.toContain('QA Administrator')
  })
  it('requires explicit review after a GET observation and never labels a match as a saved request', () => {
    const operation = createWorkerGroupOperation(group), html = render(<WorkerGroupRecoveryView intent={{ operation, status: 'unknown', observation: { groups: [group], target: group, state: 'matches' } }} error={null} checking={false} online onCheck={vi.fn()} onReviewed={vi.fn()} />)
    for (const label of ['Avval yuborilgan tanlov: QA GURUH', 'qayta yuborilmaydi', 'Avvalgi so‘rov natijasi hali tasdiqlanmagan', 'Avvalgi tanlov va joriy holatni ko‘rdim', 'Tekshiruvni yakunlash', 'disabled=""']) expect(html).toContain(label)
    expect(html).not.toContain('Guruhni saqlash'); expect(html).not.toContain('Ishchi guruhi saqlandi')
  })
  it('keeps changed/missing identity observations candid, including a surviving old name', () => {
    const different = render(<WorkerGroupObservationView observation={{ groups: [group], target: group, state: 'different' }} />)
    expect(different).toContain('farq qiladi')
    const missing = render(<WorkerGroupObservationView observation={{ groups: [group], previous: group, state: 'missing' }} />)
    expect(missing).toContain('so‘rov bajarilmaganini isbotlamaydi'); expect(missing).toContain('Avvalgi guruh nomi bilan yozuv')
  })
  it('does not convert an off accounting flag into a deleted group or measured productivity', () => {
    const html = render(<WorkerGroupSummary group={{ ...group, accounting_enabled: false }} />)
    expect(html).toContain('O‘chirilgan'); expect(html).toContain('1 ta ishchi')
    expect(html).not.toContain('o‘chirildi'); expect(html).not.toContain('Ish soati'); expect(html).not.toContain('Unumdorlik')
  })
})
