import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Row } from '@/lib/api-types'
import { buildManufacturingTimeline } from '@/lib/manufacturing-time'
import type { ManufacturingTimeline } from '@/lib/manufacturing-time'
import { ManufacturingEventRail } from './manufacturing-time-timeline'

const orderId = 'order-dashboardcn-timeline', apparatus = 'apparatus:print:fixture', start = 1_800_000_000
function timeline(logs?: Row[]): ManufacturingTimeline {
  return buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: 'Actual fixture history', completed_at_unix: start + 300, logs: logs ?? [
    { event_id: 'start', order_id: orderId, apparatus, stage_node_id: 'print', action: 'start', from_state: 'pending', to_state: 'in_progress', created_at_unix: start, actor_display_name: 'QA Operator' },
    { event_id: 'end', order_id: orderId, apparatus, stage_node_id: 'print', action: 'complete', from_state: 'in_progress', to_state: 'completed', created_at_unix: start + 300, actor_display_name: 'QA Operator' },
  ] }, map: { id: orderId, title: 'Actual fixture history', product_code: 'film', nodes: [{ id: 'print', kind: 'apparatus', title: 'Bosma', apparatus_id: apparatus }], edges: [] }, asOfUnix: start + 600 })
}
function rail(value: ManufacturingTimeline, zone = 'UTC', events = value.events) {
  return renderToStaticMarkup(<ManufacturingEventRail timeline={value} events={events} selectedId={events[0]?.id ?? ''} timeZone={zone} onSelect={() => {}} />)
}

describe('manufacturing event rail using reviewed timeline primitives', () => {
  it('renders the adapter chronology and exact server timestamps without turning the inspected event into live execution', () => {
    const value = timeline(), before = structuredClone(value), html = rail(value)
    expect(html).toContain('data-slot="timeline"')
    expect((html.match(/data-slot="timeline-item"/g) ?? []).length).toBe(value.events.length)
    const times = [...html.matchAll(/<time[^>]*dateTime="([^"]+)"/g)].map(match => match[1])
    expect(times).toEqual(value.events.map(event => new Date(event.atUnix * 1000).toISOString()))
    expect(rail(value, 'Asia/Tashkent').match(/<time[^>]*dateTime="([^"]+)"/)?.[1]).toBe(times[0])
    expect(html).toContain('aria-pressed="true"'); expect(html).not.toContain('aria-current=')
    expect(html).toContain('QA Operator'); expect(html).toContain('5 daq 0 son')
    expect(value).toEqual(before)
  })

  it('retains exact visible-endpoint and as-of guards after the layout adaptation', () => {
    const value = timeline()
    expect(rail(value)).toContain('data-rail-start="queue:start" data-rail-end="queue:end"')
    for (const html of [rail({ ...value, asOfUnix: start + 100 }), rail(value, 'UTC', value.events.filter(event => event.id !== 'queue:end'))]) {
      expect(html).not.toContain('data-rail-interval-state=')
      expect(html).toContain('Qayd oralig‘i baholanmagan')
    }
    const unknown = timeline([{ event_id: 'only', order_id: orderId, apparatus, stage_node_id: 'print', action: 'start', from_state: 'pending', to_state: 'in_progress', created_at_unix: start }])
    expect(rail(unknown)).not.toContain('data-rail-interval-state=')
    expect(rail(unknown)).not.toContain('0 son')
  })
})
