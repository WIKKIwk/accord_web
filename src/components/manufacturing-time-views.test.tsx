import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import { buildManufacturingTimeline } from '@/lib/manufacturing-time'
import { ManufacturingTimeOverview } from './manufacturing-time-overview'
import { ManufacturingEventRail, ManufacturingTimeTimeline } from './manufacturing-time-timeline'

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
    expect(html).toMatch(/style="left:50%">01<\/span>/)
    expect(html).not.toContain('gradient')
  })

  it('plots only measured stage durations with an explicit ranking axis and keeps missing histories out of the geometry', () => {
    const measured = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Measured fixture', order_number: 'F-100', logs: logs(), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const secondId = 'zakaz-second', secondLogs = logs().map((entry, index) => ({ ...entry, order_id: secondId, event_id: `second-${index}`, created_at_unix: now + (index ? 150 : 0) }))
    const second = buildManufacturingTimeline({ orderId: secondId, closedOrder: { order_id: secondId, title: 'Second measured fixture', order_number: 'F-200', logs: secondLogs, completed_at_unix: now + 150 }, map: { ...snapshot().maps[0].map, id: secondId }, asOfUnix: now + 600 })
    const missing = buildManufacturingTimeline({ orderId: 'zakaz-missing', closedOrder: { order_id: 'zakaz-missing', title: 'Missing fixture', logs: [], completed_at_unix: now + 300 }, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingTimeOverview timelines={[measured, missing, second]} />)
    expect(html).toContain('Qayd etilgan bosqich davomiyliklari, uzunligiga ko‘ra')
    expect(html).toContain('Ko‘pdan kamga tartiblangan qaydlar')
    expect(html).toContain('aria-label="01. Bosma · #F-100 · 5 daq 0 son"')
    expect(html).toContain('aria-label="02. Bosma · #F-200 · 2 daq 30 son"')
    expect(html).toContain('points="0,20 100,94"')
    expect(html).toMatch(/style="left:0%">01<\/span>/)
    expect(html).toMatch(/style="left:100%">02<\/span>/)
    expect(html).not.toContain('Missing fixture')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('OEE')
  })

  it('renders only bounded recorded intervals as duration segments and leaves live unknown time unfilled', () => {
    const closed = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Recorded fixture', logs: logs(), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const closedHtml = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={closed} timeZone="UTC" />)
    expect(closedHtml).toContain('data-interval-state="in_progress"')
    expect(closedHtml).toContain('left:0%;width:100%')
    const live = snapshot(); live.stage_states = { [orderId]: { 'print-stage': 'in_progress' } }
    const liveHtml = renderToStaticMarkup(<ManufacturingTimeTimeline timeline={buildManufacturingTimeline({ orderId, snapshot: live, asOfUnix: now + 600 })} timeZone="UTC" />)
    expect(liveHtml).toContain('Davomiylik baholanmagan')
    expect(liveHtml).not.toContain('data-interval-state=')
    expect(liveHtml).not.toContain('left:0%;width:100%')
  })

  it('draws event-rail interval marks and duration labels only between their exact validated visible endpoints', () => {
    const timeline = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Recorded rail', logs: [
      log('start', 0, 'start', 'pending', 'in_progress'), log('pause', 100, 'pause', 'in_progress', 'paused'), log('resume', 150, 'resume', 'paused', 'in_progress'), log('end', 300, 'complete', 'in_progress', 'completed'),
    ].map(row => ({ ...row, actor_display_name: 'QA Operator' })), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const html = renderToStaticMarkup(<ManufacturingEventRail timeline={timeline} events={timeline.events} selectedId={timeline.events[0].id} timeZone="UTC" onSelect={() => {}} />)
    expect((html.match(/data-rail-interval-state=/g) ?? []).length).toBe(3)
    expect(html).toContain('data-rail-start="queue:start" data-rail-end="queue:pause"')
    expect(html).toContain('data-rail-start="queue:pause" data-rail-end="queue:resume"')
    expect(html).toContain('data-rail-start="queue:resume" data-rail-end="queue:end"')
    for (const text of ['1 daq 40 son', '50 son', '2 daq 30 son', 'Qayd oralig‘i', 'Jarayonda → To‘xtatilgan', 'QA Operator']) expect(html).toContain(text)
    expect(html).not.toContain('data-rail-start="queue:end"')
  })

  it('does not join filtered-away endpoints or mutable batch markers into a new event-rail duration', () => {
    const timeline = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Filtered rail', logs: [
      log('start', 0, 'start', 'pending', 'in_progress'), log('pause', 100, 'pause', 'in_progress', 'paused'), log('resume', 150, 'resume', 'paused', 'in_progress'), log('end', 300, 'complete', 'in_progress', 'completed'),
    ], completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const filtered = timeline.events.filter(event => event.id !== 'queue:pause')
    const html = renderToStaticMarkup(<ManufacturingEventRail timeline={timeline} events={filtered} selectedId="queue:start" timeZone="UTC" onSelect={() => {}} />)
    expect((html.match(/data-rail-interval-state=/g) ?? []).length).toBe(1)
    expect(html).toContain('data-rail-start="queue:resume" data-rail-end="queue:end"')
    expect(html).not.toContain('data-rail-start="queue:start"')
    const marker = { ...timeline.events[0], id: 'batch:mutable:resumed_at_unix', kind: 'batch_marker' as const, transition: false, atUnix: now + 50 }
    const withMarker = renderToStaticMarkup(<ManufacturingEventRail timeline={timeline} events={[timeline.events[0], marker, timeline.events[1]]} selectedId="queue:start" timeZone="UTC" onSelect={() => {}} />)
    expect(withMarker).not.toContain('data-rail-interval-state=')
    expect(withMarker).toContain('Qayd oralig‘i baholanmagan')
  })

  it('leaves unknown, future, unmatched, and gap event-rail spans unfilled', () => {
    const measured = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Measured rail', logs: logs(), completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const render = (timeline: typeof measured, events = timeline.events) => renderToStaticMarkup(<ManufacturingEventRail timeline={timeline} events={events} selectedId={events[0]?.id ?? ''} timeZone="UTC" onSelect={() => {}} />)
    const gap = buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Gap rail', logs: [log('start', 0, 'start', 'pending', 'in_progress'), log('end', 300, 'complete', 'pending', 'completed')], completed_at_unix: now + 300 }, map: snapshot().maps[0].map, asOfUnix: now + 600 })
    const lineage = buildManufacturingTimeline({ orderId, report: { ok: true, history_scope: 'batch_lineage', lineage_complete: true, scanned_batch: { order_id: orderId }, logs: logs(), order: snapshot().maps[0].map }, asOfUnix: now + 600 })
    const unmatched = measured.events.map((event, index) => index === 1 ? { ...event, id: 'unmatched-end' } : event)
    const overlappingGap = { ...measured, stages: measured.stages.map(stage => ({ ...stage, gaps: [{ startUnix: now + 50, endUnix: now + 150, reason: 'unattributed' as const }] })) }
    for (const html of [render(gap), render(lineage), render({ ...measured, asOfUnix: now + 100 }), render(measured, unmatched), render(overlappingGap)]) {
      expect(html).not.toContain('data-rail-interval-state=')
      expect(html).toContain('Qayd oralig‘i baholanmagan')
    }
  })
})
