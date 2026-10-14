import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { paddonLabelIntentLedger, preparePaddonLabelOperation } from '@/lib/paddon-label'
import type { PaddonLabelReport } from '@/lib/paddon-label'
import { PaddonLabelReportView, PaddonLabelToolbar, PaddonQrPreview } from './paddon-label-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const report: PaddonLabelReport = { paddon: { id: 'legacy-paddon-opaque-id', code: '00001', location: '', note: '', created_by_ref: 'qa-admin', created_by_display_name: 'QA Admin', created_at_unix: 1790000000, updated_at_unix: 1790000000, item_count: 0, locked_at_unix: null, total_gross_kg: 12, total_net_kg: null }, items: [], qr_payload: '00001', free_movement_enabled: false, can_manage_items: true, can_unlock: false }
let count = 0
function setup(capabilities = ['admin.access'], demo = false, scope = `label-ui-${++count}`) {
  const session: Session = { token: 'synthetic-token', profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), demo, endpoint: 'http://127.0.0.1:5199', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  return scope
}
afterEach(() => vi.clearAllMocks())
describe('native paddon label presentation', () => {
  it('retains the exact report capability guard and disables the demo entry', () => {
    for (const capability of ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']) { setup([capability]); expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={report.paddon} />)).toContain('QR va yorliq') }
    setup([]); expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={report.paddon} />)).toBe('')
    setup(undefined, true); expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={report.paddon} />)).toContain('disabled=""')
  })
  it('retains unknown preparation on remount and separates another identity scope', () => {
    const scope = setup(), ledger = paddonLabelIntentLedger(scope), operation = preparePaddonLabelOperation(report); ledger.begin(operation); ledger.unknown(operation)
    expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={report.paddon} />)).toContain('Javobni tekshirish')
    setup(undefined, false, scope); expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={{ ...report.paddon, code: '00002' }} />)).toContain('Javobni tekshirish')
    setup(); expect(renderToStaticMarkup(<PaddonLabelToolbar paddon={report.paddon} />)).not.toContain('Javobni tekshirish')
  })
  it('renders an accessible code with fixed white background and no physical-print assertion', () => {
    const html = renderToStaticMarkup(<PaddonQrPreview code="00001" />)
    expect(html).toContain('aria-label="Paddon 00001 QR"'); expect(html).toContain('fill="white"'); expect(html).toContain('fill="black"'); expect(html).toContain('00001')
    expect(html).not.toContain('Bosilgan'); expect(html).not.toContain('/qr/confirm')
  })
  it('uses server product weights and explicit unknowns rather than the1-dona preparation defaults', () => {
    const html = renderToStaticMarkup(<PaddonLabelReportView report={report} />)
    expect(html).toContain('Mahsulot brutto, kg'); expect(html).toContain('12'); expect(html).toContain('Mahsulot netto, kg'); expect(html).toContain('—')
    expect(html).toContain('Paddon tarkibi bo‘sh'); expect(html).not.toContain('1 dona'); expect(html).not.toContain('client_usb_pending')
  })
})
