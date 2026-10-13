import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { parseProgressPassport, parseOpeningPassport } from '@/lib/progress-passport'
import { ProgressPassportControls, ProgressPassportDetails, ProgressPassportResultNotice } from './progress-passport-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const batch = { batch_id: 'batch:001', order_id: 'order:001', qr_payload: 'saved-QR', revision: 2, session_id: 'session:001', apparatus: 'apparatus:default:asset-001', worker_ref: 'worker:001', worker_role: 'aparatchi', worker_display_name: 'Worker', executor_name: 'Worker', label_item_code: 'PRODUCT', label_item_name: 'Saved product', produced_qty: 100, uom: 'm', status: 'completed', action: 'roll_complete', wip_status: 'waiting', started_at_unix: 1790000000, completed_at_unix: 1790000100, finished_goods_meter: 100, finished_goods_kg: 25, bobina_kg: 1, payload_json: {} }
const opening = { ...batch, batch_id: 'opening:001', intake_id: 'intake:001', sequence_no: 1, quantity_basis: 'measured', quantity: 100 }
const identity = { kind: 'wip' as const, batchId: batch.batch_id, orderId: batch.order_id, qr: batch.qr_payload }
function actor(capabilities = ['admin.access'], demo = false) {
  const session: Session = { token: 'fixture-token', profile: { role: 'admin', ref: 'worker:001', display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo, scope: 'passport-fixture', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
const render = (value: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{value}</QueryClientProvider>)
const progress = (extra: Record<string, unknown> = {}) => parseProgressPassport({ ok: true, scanned_batch: batch, current_batch: batch, current_batches: [batch], progress_batches: [batch], history_scope: 'batch_lineage', lineage_complete: false, lineage_edges: [], is_stale: false, stale_reason: '', session_resources: [], run_sessions: [], active_sessions: [], corrections: [], logs: [], order: { id: batch.order_id }, order_status: { lifecycle_status: 'released' }, ...extra }, identity)
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('passport entry, real lineage and print separation', () => {
  it('offers explicit passport reads without requests, automatic edits or printer calls on render', () => {
    actor(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render(<ProgressPassportControls row={batch} />)
    expect(html).toContain('Rulon pasportini ochish'); expect(html).toContain('Progress WIP')
    expect(html).not.toContain('Correctionni ko‘rib chiqish'); expect(html).not.toContain('Yorliq amalini ko‘rib chiqish')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides unpermitted or malformed identities and prevents treating opening rows as progress', () => {
    actor([]); expect(render(<ProgressPassportControls row={batch} />)).toBe('')
    actor(['apparatus.queue.read']); expect(render(<ProgressPassportControls row={batch} />)).toContain('Rulon pasportini ochish')
    expect(render(<ProgressPassportControls row={{ batch_id: 'title' }} />)).toBe('')
    expect(render(<ProgressPassportControls row={opening} kind="wip" />)).toBe('')
    expect(render(<ProgressPassportControls row={opening} kind="opening-wip" />)).toContain('Boshlang‘ich WIP')
  })

  it('blocks every demo passport request and offers no fabricated printed outcome', () => {
    actor(undefined, true); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render(<ProgressPassportControls row={batch} />)
    expect(html).toMatch(/<button[^>]*disabled=""/); expect(html).toContain('haqiqiy passport yoki printer so‘rovi yuborilmaydi')
    expect(html).not.toContain('Server printer bosmasini tasdiqladi'); expect(fetch).not.toHaveBeenCalled()
  })

  it('shows native batch quantities, partial lineage and empty audit/resources without fabricated durations', () => {
    const html = renderToStaticMarkup(<ProgressPassportDetails passport={progress()} />)
    expect(html).toContain('saved-QR'); expect(html).toContain('Saved product'); expect(html).toContain('100 m')
    expect(html).toContain('Lineage qisman'); expect(html).toContain('Correction yozuvi yo‘q'.toLowerCase())
    expect(html).toContain('Ish sessiyasi qayd etilmagan'); expect(html).toContain('bu rulonga sarf yoki vaqt davomiyligi sifatida talqin qilinmaydi')
    expect(html).not.toContain('Bosilgan'); expect(html).not.toContain('O‘chirish')
  })

  it('keeps the scanned stale QR separate from current lineage tips', () => {
    const html = renderToStaticMarkup(<ProgressPassportDetails passport={progress({ is_stale: true, stale_reason: 'processed_by_next_stage', lineage_complete: true })} />)
    expect(html).toContain('Skan qilingan QR keyingi bosqichda ishlatilgan'); expect(html).toContain('Joriy lineage uchida')
    expect(html).toContain('Native lineage to‘liq'); expect(html).toContain('Faqat shu rulon lineage tarixi')
  })

  it('presents opening WIP as its separate saved intake without correction or undo claims', () => {
    const passport = parseOpeningPassport({ ok: true, record: { intake: { intake_id: 'intake:001', idempotency_key: 'saved-key', order_id: batch.order_id, entry_apparatus: batch.apparatus, source_apparatus: batch.apparatus, source_operation: 'print', resume_stage_node_id: 'print', current_location: '', resume_apparatus: '', status: 'confirmed' }, batches: [opening] } }, { kind: 'opening-wip', batchId: opening.batch_id, orderId: opening.order_id, qr: opening.qr_payload })
    const html = renderToStaticMarkup(<ProgressPassportDetails passport={passport} />)
    expect(html).toContain('intake:001'); expect(html).toContain('confirmed'); expect(html).toContain('Progress correction va umumiy undo amali mavjud emas')
    expect(html).not.toContain('Revision 2'); expect(html).not.toContain('Correction auditi')
  })

  it('labels native offline preparation as pending physical print and retains actual printer result metadata', () => {
    const passport = progress(), print = { status: 'prepared', printer_status: 'client_usb_pending', printer: 'godex', print_mode: 'label', print_count: 2, item_code: 'PRODUCT', item_name: 'Native label', qty: 100, progress_unit: 'm', gross_qty: 25, unit: 'kg', tare_kg: 1 }
    const prepared = renderToStaticMarkup(<ProgressPassportResultNotice result={{ kind: 'print', passport, print, outcome: 'prepared' }} />)
    expect(prepared).toContain('Fizik bosma hali tasdiqlanmagan'); expect(prepared).toContain('client_usb_pending'); expect(prepared).toContain('2 nusxa'); expect(prepared).toContain('Native label')
    expect(prepared).not.toContain('Server printer bosmasini tasdiqladi')
    const confirmed = renderToStaticMarkup(<ProgressPassportResultNotice result={{ kind: 'print', passport, print: { ...print, status: 'printed', printer_status: 'Printer OK' }, outcome: 'printed' }} />)
    expect(confirmed).toContain('Server printer bosmasini tasdiqladi'); expect(confirmed).toContain('Printer OK')
  })
})
