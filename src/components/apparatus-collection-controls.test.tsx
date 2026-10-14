import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { createCollectionOperation, deleteCollectionOperation, collectionIntentLedger } from '@/lib/apparatus-collections'
import type { ApparatusCollection } from '@/lib/apparatus-collections'
import { useSession } from '@/lib/session'
import { ApparatusCollectionToolbar, CollectionList, CollectionMembers, CollectionChoices, CollectionDelete, CollectionRecovery, CollectionObservationView } from './apparatus-collection-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const app = { id: 'apparatus:qa:print-1', name: 'QA Flexo 1', active: true }
const row: ApparatusCollection = { id: 'apparatus-collection:' + '1'.padStart(32, '0'), name: 'QA Bosma liniyasi', apparatus_ids: [app.id], revision: 1 }
const names = new Map([[app.id, app.name]])
let sequence = 0
function setup(capabilities = ['admin.access', 'production.map.manage'], demo = false, scope = `collection-ui-${++sequence}`) {
  const session: Session = { token: 'synthetic-token', profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Administrator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), demo, endpoint: 'http://127.0.0.1:5199', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  return scope
}
function render(children: ReactNode) { return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>) }
afterEach(() => vi.clearAllMocks())
beforeEach(() => setup())

describe('native apparatus collection presentation', () => {
  it('shows read-authorized toolbar, disables demo and hides unauthorized access', () => {
    setup(['admin.access']); expect(render(<ApparatusCollectionToolbar />)).toContain('Apparat guruhlari')
    setup(['catalog.item.read']); expect(render(<ApparatusCollectionToolbar />)).toContain('Apparat guruhlari')
    setup(['production.map.read']); expect(render(<ApparatusCollectionToolbar />)).toBe('')
    setup(['admin.access'], true); expect(render(<ApparatusCollectionToolbar />)).toContain('disabled=""')
  })
  it('retains unknown intent after a toolbar remount only in its original live scope', () => {
    const scope = setup(), operation = createCollectionOperation(row), ledger = collectionIntentLedger(scope)
    ledger.begin(operation); ledger.unknown(operation)
    expect(render(<ApparatusCollectionToolbar />)).toContain('Tekshirish kerak')
    setup(undefined, false, scope); expect(render(<ApparatusCollectionToolbar />)).toContain('Tekshirish kerak')
    setup(); expect(render(<ApparatusCollectionToolbar />)).not.toContain('Tekshirish kerak')
  })
  it('displays native members and separates empty data from nonmatching search', () => {
    const props = { names, search: '', manage: true, disabled: false, onEdit: vi.fn(), onDelete: vi.fn() }
    const html = render(<CollectionList collections={[row]} {...props} />)
    for (const value of [row.name, app.id, app.name, '1 apparat', 'guruhini tahrirlash', 'guruhini o‘chirish']) expect(html).toContain(value)
    expect(render(<CollectionList collections={[]} {...props} />)).toContain('hali yo‘q')
    expect(render(<CollectionList collections={[row]} {...props} search="absent" />)).toContain('Qidiruvga mos apparat guruhi topilmadi')
    expect(render(<CollectionMembers ids={[]} />)).toContain('apparat qo‘shilmagan')
  })
  it('searches recorded IDs without names and hides write actions for read-only access', () => {
    const html = render(<CollectionList collections={[row]} names={new Map()} search={app.id.toUpperCase()} manage={false} disabled={false} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(html).toContain(row.name); expect(html).toContain(app.id); expect(html).toContain('nomi joriy ro‘yxatda yo‘q')
    expect(html).not.toContain('Tahrirlash'); expect(html).not.toContain('O‘chirish')
  })
  it('keeps selected choices and honest bounded/empty messages', () => {
    const html = render(<CollectionChoices catalog={{ items: [app], bounded: true }} selected={[app.id]} disabled={false} onChange={vi.fn()} />)
    expect(html).toContain('data-state="checked"'); expect(html).toContain('Ko‘pi bilan 500 ta apparat')
    expect(render(<CollectionChoices catalog={{ items: [], bounded: false }} selected={[app.id]} disabled={false} onChange={vi.fn()} />)).toContain('Qidiruvga mos faol apparat topilmadi')
  })
  it('describes group-only deletion and disables pending confirmation', () => {
    const html = render(<CollectionDelete row={row} names={names} pending online error={null} onBack={vi.fn()} onDelete={vi.fn()} onRestart={vi.fn()} />)
    expect(html).toContain(row.name); expect(html).toContain('Apparatlar va ularning sozlamalari saqlanib qoladi')
    expect(html).toContain('disabled=""'); expect(html).toContain('yakuni kutilmoqda')
  })
  it('keeps unknown create/update/delete immutable and requires explicit GET review', () => {
    for (const operation of [createCollectionOperation(row), createCollectionOperation({ ...row, name: 'QA Renamed' }, row), deleteCollectionOperation(row)]) {
      const html = render(<CollectionRecovery intent={{ operation, status: 'unknown', observation: { collections: [row], target: row, state: 'matches' } }} names={names} checking={false} online error={null} onCheck={vi.fn()} onReviewed={vi.fn()} />)
      for (const value of ['Asl so‘rov qayta yuborilmaydi', 'asl so‘rov natijasini tasdiqlamaydi', 'shu sessiya xotirasida', 'to‘liq yangilash yoki hisobdan chiqish', 'Guruh tekshiruvini yakunlash', 'disabled=""']) expect(html).toContain(value)
      expect(html).not.toContain('Apparat guruhi saqlandi.'); expect(html).not.toContain('Apparat guruhi o‘chirildi.')
    }
  })
  it('does not label a missing or changed record as original command proof', () => {
    expect(render(<CollectionObservationView observation={{ collections: [], state: 'missing' }} names={names} />)).toContain('asl so‘rov natijasini tasdiqlamaydi')
    expect(render(<CollectionObservationView observation={{ collections: [row], target: row, state: 'different' }} names={names} />)).toContain('farq qiladi')
  })
})
