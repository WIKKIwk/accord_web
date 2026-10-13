import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import { buildManufacturingTimeline } from '@/lib/manufacturing-time'
import { ManufacturingTimeOverview } from './manufacturing-time-overview'
import { ManufacturingTimeTimeline } from './manufacturing-time-timeline'

const orderId = 'zakaz-time-ui-fixture', apparatus = 'apparatus:print:fixture', now = 1_800_000_000
function snapshot(): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'fixture', scope: 'admin', maps: [{ map: { id: orderId, title: 'Fixture live order', product_code: 'film',
    nodes: [{ id: 'print-stage', kind: 'apparatus', title: 'Bosma', apparatus_id: apparatus }], edges: [] }, program: {} }], order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {} }
}
function log(event: string, at: number, action: string, from: string, to: string): Row {
  return { event_id: event, order_id: orderId, apparatus, stage_node_id: 'print-stage', action, from_state: from, to_state: to, created_at_unix: now + at }
}
const logs = () => [log('start', 0, 'start', 'pending', 'in_progress'), log('end', 300, 'complete', 'in_progress', 'completed')]

describe('manufacturing time evidence in accessible views', () => {
  it('keeps current in-progress status visible while elapsed time remains unavailable', () => {
    const live = snapshot()
    live.stage_states = { [orderId]: { 'print-stage': 'in_progress' } }
    const timeline = buildManufacturingTimeline({ orderId, snapshot: live, asOfUnix: now + 600, fresh: false })
    const html = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={timeline} timeZone="UTC" />)
    expect(html).toContain('Oxirgi kuzatuv: Jarayonda')
    expect(html).toContain('Davomiylik baholanmagan')
    expect(html).toContain('qayd etilgan jarayon —')
    expect(html).toContain('Oxirgi olingan ma’lumot')
    expect(html).toContain('UTC vaqti')
    expect(html).not.toContain('0 son')
  })
  it('shows a global frozen hold without inventing frozen physical work in every stage', () => {
    const live = snapshot()
    live.stage_states = { [orderId]: { 'print-stage': 'in_progress' } }
    live.order_controls = { [orderId]: { order_id: orderId, state: 'frozen' } }
    const timeline = buildManufacturingTimeline({ orderId, snapshot: live, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={timeline} timeZone="UTC" />)
    expect(html).toContain('Buyurtma muzlatilgan.')
    expect(html).toContain('umumiy cheklovi alohida amal qiladi')
    expect(timeline.stages[0].currentState).toBe('in_progress')
    expect(timeline.stages[0].inProgressSeconds).toBeNull()
  })

  it('offers keyboard event navigation and honest measured span labels for closed logs', () => {
    const timeline = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Fixture closed order', logs: logs(), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={timeline} timeZone="UTC" />)
    expect(html).toContain('aria-label="Vaqt bo‘yicha hodisani tanlash"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Vaqt chizig‘ini yaqinlashtirish"')
    expect(html).toContain('aria-label="Tanlangan hodisa"')
    expect(html).toContain('5 daq 0 son')
    expect(html).toContain('Qayd etilgan jarayon')
    expect(html).toContain('Bosma')
    expect(html).not.toContain('gradient')
  })

  it('shows complete lineage as a scoped source without presenting state durations', () => {
    const timeline = buildManufacturingTimeline({ orderId, report: { ok: true, history_scope: 'batch_lineage', lineage_complete: true,
      scanned_batch: { order_id: orderId }, logs: logs(), order: snapshot().maps[0].map }, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={timeline} timeZone="UTC" />)
    expect(html).toContain('Partiya zanjiri')
    expect(html).toContain('Buyurtmaning to‘liq holat tarixi olinmagani')
    expect(html).toContain('qayd etilgan jarayon —')
    expect(html).toContain('Davomiylik baholanmagan')
  })

  it('makes bounded cohort eligibility and unknown current status visible in the executive overview', () => {
    const measured = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Measured fixture', order_number: 'F-100', logs: logs(), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const missing = buildManufacturingTimeline({ orderId: 'zakaz-missing', closedOrder: { order_id: 'zakaz-missing', title: 'Missing fixture', logs: [], completed_at_unix: now + 300 }, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingTimeOverview timelines={[measured, missing]} snapshot={snapshot()} onSelectOrder={() => {}} />)
    expect(html).toContain('eng so‘nggi 200 tagacha')
    expect(html).toContain('1 buyurtmada hisoblashga yetarli qayd yo‘q')
    expect(html).toContain('1 holat noma’lum')
    expect(html).toContain('— buyurtma navbatda')
    expect(html).toContain('Bosma')
    expect(html).toContain('5 daq 0 son')
    expect(html).toContain('Joriy navbat qamrovi olinmagan')
    expect(html).not.toContain('gradient')
  })
})
