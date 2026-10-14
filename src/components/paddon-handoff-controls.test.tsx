import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '@/lib/api-types'
import type { PaddonSummary } from '@/lib/paddons'
import { ApiClient } from '@/lib/api'
import { useSession } from '@/lib/session'
import { choosePaddonOperation, clearPaddonOperation, nextPaddonOperation, paddonHandoffIntentLedger } from '@/lib/paddon-handoff'
import { HandoffPaddonChoices, HandoffRecovery, HandoffSelectionView, PaddonHandoffToolbar } from './paddon-handoff-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const active = { apparatus: 'apparatus:qa:cut-1', code: '00001' }, row: PaddonSummary = { id: 'qa-paddon-legacy', code: '00002', location: 'QA Rezka', note: '', created_by_ref: 'qa-admin', created_by_display_name: 'QA Admin', created_at_unix: 1_790_000_000, updated_at_unix: 1_790_000_000, item_count: 4, locked_at_unix: 1_790_000_001, total_gross_kg: null, total_net_kg: null }
let count = 0
function setup(capabilities = ['admin.access'], demo = false, scope = `handoff-ui-${++count}`) {
  const session: Session = { token: 'synthetic-token', profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), demo, endpoint: 'http://127.0.0.1:5199', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  return scope
}
afterEach(() => vi.clearAllMocks())
describe('server-owned paddon handoff presentation', () => {
  it('shows only the native active-capability entry and disables demo', () => {
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.manage']) { setup([capability]); expect(renderToStaticMarkup(<PaddonHandoffToolbar />)).toContain('Faol kesish paddoni') }
    setup(['apparatus.queue.read']); expect(renderToStaticMarkup(<PaddonHandoffToolbar />)).toBe('')
    setup(undefined, true); expect(renderToStaticMarkup(<PaddonHandoffToolbar />)).toContain('disabled=""')
  })
  it('retains uncertain active intent through same-scope toolbar remounts and isolates another account scope', () => {
    const scope = setup(), ledger = paddonHandoffIntentLedger(scope), operation = choosePaddonOperation(active, '00003'); ledger.begin(operation); ledger.unknown(operation)
    expect(renderToStaticMarkup(<PaddonHandoffToolbar />)).toContain('Tekshirish kerak')
    setup(undefined, false, scope); expect(renderToStaticMarkup(<PaddonHandoffToolbar apparatusId="apparatus:qa:another-cut" />)).toContain('Tekshirish kerak')
    setup(); expect(renderToStaticMarkup(<PaddonHandoffToolbar />)).not.toContain('Tekshirish kerak')
  })
  it('distinguishes a native null selection from the selected code without local preferences', () => {
    const selected = renderToStaticMarkup(<HandoffSelectionView active={active} />), empty = renderToStaticMarkup(<HandoffSelectionView active={{ ...active, code: null }} />)
    expect(selected).toContain('Faol paddon: 00001'); expect(selected).toContain('server joriy tanlovni qayta o‘qiydi')
    expect(empty).toContain('Faol paddon tanlanmagan.'); expect(empty).toContain('Tanlovsiz yangi rulon paddonga biriktirilmaydi')
  })
  it('preserves native choice identity and describes the bounded feed without fabricating totals', () => {
    const html = renderToStaticMarkup(<HandoffPaddonChoices list={{ items: [{ ...row, locked_at_unix: null }], bounded: true }} selectedCode={row.code} disabled={false} onSelect={vi.fn()} />)
    expect(html).toContain('00002 paddonini tanlash'); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('Bu barcha paddonlar soni emas'); expect(html).toContain('4 partiya')
    expect(renderToStaticMarkup(<HandoffPaddonChoices list={{ items: [], bounded: false }} selectedCode="00099" disabled={false} onSelect={vi.fn()} />)).toContain('Tanlash uchun ochiq paddonlar yo‘q')
  })
  it('never promotes active readback to a command receipt or repeats a successor action', () => {
    for (const operation of [choosePaddonOperation(active, '00003'), clearPaddonOperation(active), nextPaddonOperation(active, row)]) {
      const html = renderToStaticMarkup(<HandoffRecovery intent={{ operation, status: 'unknown', observation: { active, state: operation.kind === 'next' ? 'observed' : 'different' } }} checking={false} canCheck error={null} onCheck={vi.fn()} onReviewed={vi.fn()} />)
      for (const value of ['Avvalgi amal shu sessiya xotirasida saqlandi', 'Asl so‘rov qayta yuborilmaydi', 'Bu asl amal natijasini tasdiqlamaydi', 'boshqa qurilmadagi tanlovni almashtirishi mumkin', 'To‘liq yangilash yoki hisobdan chiqish', 'disabled=""']) expect(html).toContain(value)
      expect(html).not.toContain('Avvalgi tanlov saqlandi')
      expect(html).not.toContain('Keyingi paddon serverda tayinlandi.')
    }
  })
})
