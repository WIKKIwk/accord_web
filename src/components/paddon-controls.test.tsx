import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PaddonBatch, PaddonSnapshot } from '@/lib/paddons'
import { createPaddonOperation, deletePaddonOperation, paddonItemsOperation, unlockPaddonOperation } from '@/lib/paddons'
import { PaddonDestructiveReview, PaddonItems, PaddonList, PaddonObservationView, PaddonRecovery, PaddonSummaryView, paddonWeight } from './paddon-controls'

const batch: PaddonBatch = { batch_id: 'qa-wip-1', order_id: 'QA Order', apparatus: 'QA Rezka', qr_payload: 'qa-wip-qr', label_item_code: 'QA-ROLL', label_item_name: 'QA Rulon', produced_qty: 500, uom: 'm', wip_status: 'waiting', finished_goods_kg: 99, bobina_kg: 1, finished_goods_meter: 500, finished_goods_stock_id: '', received_warehouse: '' }
const snapshot: PaddonSnapshot = { paddon: { id: 'opaque-legacy-id', code: '00001', location: 'QA Sex', note: 'QA Izoh', created_by_ref: 'qa-admin', created_by_display_name: 'QA Administrator', created_at_unix: 1_790_000_000, updated_at_unix: 1_790_000_000, item_count: 1, locked_at_unix: null, total_gross_kg: 12.125, total_net_kg: null }, items: [batch], available_items: [], free_movement_enabled: false, can_manage_items: true, can_unlock: false }
const noop = vi.fn()
describe('native paddon presentation boundaries', () => {
  it('displays native product totals rather than deriving weight from quantity or current batch weight', () => {
    const html = renderToStaticMarkup(<PaddonSummaryView snapshot={snapshot} />)
    expect(html).toContain(paddonWeight(12.125)); expect(html).toContain('—'); expect(html).not.toContain('99 kg'); expect(html).not.toContain('500 kg')
    expect(paddonWeight(0)).toBe('0 kg'); expect(paddonWeight(null)).toBe('—')
    expect(html).toContain('paddonning o‘z vazni kiritilmagan')
  })
  it('searches loaded native codes, location and actor without claiming a whole factory count', () => {
    const render = (search: string, rows = [snapshot.paddon]) => renderToStaticMarkup(<PaddonList rows={rows} search={search} disabled={false} onOpen={noop} />)
    for (const search of ['00001', 'sex', 'QA-ADMIN']) expect(render(search)).toContain('00001 paddonini ochish')
    expect(render('missing')).toContain('Eski paddonni kodi bilan oching')
    expect(render('', [])).toContain('Paddonlar hali yo‘q')
  })
  it('shows the native printed/free movement combination without inferring a receipt state', () => {
    const html = renderToStaticMarkup(<PaddonSummaryView snapshot={{ ...snapshot, free_movement_enabled: true, paddon: { ...snapshot.paddon, locked_at_unix: snapshot.paddon.updated_at_unix } }} />)
    expect(html).toContain('Bosilgan paddon'); expect(html).toContain('Server erkin harakat sababli'); expect(html).not.toContain('server tomonidan yopilgan')
    expect(renderToStaticMarkup(<PaddonSummaryView snapshot={{ ...snapshot, can_manage_items: false }} />)).toContain('server tomonidan yopilgan')
  })
  it('disables returned available batches that native add would reject', () => {
    for (const ineligible of [{ ...batch, wip_status: 'in_use' as const }, { ...batch, finished_goods_stock_id: 'qa-stock' }, { ...batch, received_warehouse: 'QA Ombor' }]) {
      const html = renderToStaticMarkup(<PaddonItems rows={[ineligible]} selected={[]} selectable disabled={false} adding onSelection={noop} />)
      expect(html).toContain('disabled=""'); expect(html).toContain('Qo‘shish mumkin emas')
    }
    const html = renderToStaticMarkup(<PaddonItems rows={[batch]} selected={[batch.batch_id]} selectable disabled={false} adding onSelection={noop} />)
    expect(html).toContain('data-state="checked"'); expect(html).toContain('1 partiya tanlangan')
  })
  it('requires explicit product confirmation and fresh can_unlock before destructive operations', () => {
    for (const kind of ['delete', 'unlock'] as const) {
      const html = renderToStaticMarkup(<PaddonDestructiveReview snapshot={snapshot} kind={kind} pending={false} online error={null} onSubmit={noop} onBack={noop} />)
      expect(html).toContain('disabled=""'); expect(html).toContain('00001')
      expect(html).toContain(kind === 'delete' ? 'Bo‘sh tarkib avval foydalanilmaganini isbotlamaydi' : 'Qabul qilingan paddonni ochish mumkin emas')
    }
  })
  it('applies free-movement removal eligibility without narrowing ordinary removal', () => {
    const row = { ...batch, wip_status: 'in_use' as const }
    const ordinary = renderToStaticMarkup(<PaddonItems rows={[row]} selected={[]} selectable disabled={false} onSelection={noop} />)
    expect(ordinary).not.toContain('Erkin harakatda olish'); expect(ordinary.match(/<button[^>]*role="checkbox"[^>]*>/)?.[0]).not.toContain('disabled=""')
    const free = renderToStaticMarkup(<PaddonItems rows={[row]} selected={[]} selectable disabled={false} movableOnly onSelection={noop} />)
    expect(free).toContain('Erkin harakatda olish'); expect(free).toContain('disabled=""')
  })
  it('keeps every uncertain native operation read-only until explicit observation and acknowledgment', () => {
    const unlocked = { ...snapshot, can_manage_items: false, can_unlock: true, paddon: { ...snapshot.paddon, locked_at_unix: 1_790_000_000 } }
    for (const operation of [createPaddonOperation({ location: 'QA Sex', note: 'QA Izoh' }), paddonItemsOperation('add', snapshot, [batch.batch_id]), paddonItemsOperation('remove', snapshot, [batch.batch_id]), deletePaddonOperation(snapshot.paddon), unlockPaddonOperation(unlocked)]) {
      const html = renderToStaticMarkup(<PaddonRecovery intent={{ operation, status: 'unknown', observation: { paddons: [snapshot.paddon], bounded: false, snapshot, state: 'matches' } }} checking={false} online error={null} onCheck={noop} onReviewed={noop} />)
      for (const text of ['Asl so‘rov qayta yuborilmaydi', 'asl so‘rov natijasini tasdiqlamaydi', 'shu sessiya xotirasida', 'Paddon tekshiruvini yakunlash', 'disabled=""']) expect(html).toContain(text)
      expect(html).not.toContain('Paddon yaratildi.'); expect(html).not.toContain('Paddon o‘chirildi.')
    }
  })
  it('does not resolve unknown create by a similar note or absence in a bounded list', () => {
    const html = renderToStaticMarkup(<PaddonObservationView observation={{ paddons: [snapshot.paddon], bounded: true, state: 'listed' }} />)
    expect(html).toContain('izoh yoki joylashuv mosligi asl amalni aniqlamaydi'); expect(html).toContain('ro‘yxatdan yo‘qlik amal bajarilmaganini isbotlamaydi')
    expect(renderToStaticMarkup(<PaddonObservationView observation={{ paddons: [], bounded: false, state: 'missing' }} />)).toContain('asl so‘rov natijasini tasdiqlamaydi')
  })
})
