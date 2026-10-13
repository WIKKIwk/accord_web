import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildManufacturingTimeline } from '@/lib/manufacturing-time'
import { ManufacturingRecordedAnalytics } from './manufacturing-time-overview'

const orderId = 'recorded-ui', apparatus = 'apparatus:print:fixture', observedAt = Date.UTC(2026, 9, 13, 12) / 1000
const timeline = () => buildManufacturingTimeline({ orderId, asOfUnix: observedAt,
  map: { id: orderId, nodes: [{ id: 'print', title: 'Bosma', kind: 'apparatus', apparatus_id: apparatus }], edges: [] },
  closedOrder: { order_id: orderId, title: 'Recorded fixture', completed_at_unix: observedAt - 300, logs: [
    { event_id: 'start', order_id: orderId, apparatus, stage_node_id: 'print', action: 'start', from_state: 'pending', to_state: 'in_progress', created_at_unix: observedAt - 600 },
    { event_id: 'end', order_id: orderId, apparatus, stage_node_id: 'print', action: 'complete', from_state: 'in_progress', to_state: 'completed', created_at_unix: observedAt - 300 },
  ] },
})

describe('actual dashboardcn recorded-history components', () => {
  it('keeps only the recorded date chart and period tabs on the production view', () => {
    const html = renderToStaticMarkup(<ManufacturingRecordedAnalytics timelines={[timeline()]} historyAvailable asOfUnix={observedAt} timeZone="UTC" />)
    for (const slot of ['period-tabs', 'composed-chart']) expect(html).toContain(`data-slot="${slot}"`)
    expect(html).toContain('role="tablist"'); expect(html).toContain('7 kun'); expect(html).toContain('30 kun'); expect(html).toContain('Olingan tarix')
    expect(html).toContain('to‘liq kunlik hisobot bermaydi'); expect(html).toContain('vaqt zonasi: UTC')
    for (const slot of ['dot-plot', 'heatmap-chart', 'radar-chart']) expect(html).not.toContain(`data-slot="${slot}"`)
    expect(html).not.toContain('Bosqich davomiyligi taqsimoti'); expect(html).not.toContain('Apparat va sana bo‘yicha jarayon qaydlari')
  })
  it('keeps unavailable data out of chart geometry and still exposes the retained-history period control', () => {
    const html = renderToStaticMarkup(<ManufacturingRecordedAnalytics timelines={[]} historyAvailable={false} asOfUnix={null} />)
    expect(html).toContain('data-slot="period-tabs"')
    for (const slot of ['composed-chart', 'dot-plot', 'heatmap-chart-cell', 'radar-chart']) expect(html).not.toContain(`data-slot="${slot}"`)
    expect(html).toContain('Buyurtma tarixi olinmagan'); expect(html).not.toContain('Variant bor')
  })
})

import { manufacturingTimeZone } from '@/lib/manufacturing-time'
import { historyTimeZone } from '@/lib/dashboardcn-analytics'

describe('visible production date timezone', () => {
  it('uses the established browser/user zone by default and labels an explicitly supplied operational zone', () => {
    const browser = renderToStaticMarkup(<ManufacturingRecordedAnalytics timelines={[timeline()]} historyAvailable asOfUnix={observedAt} />)
    expect(browser).toContain(`vaqt zonasi: ${historyTimeZone(manufacturingTimeZone())}`)
    const tashkent = renderToStaticMarkup(<ManufacturingRecordedAnalytics timelines={[timeline()]} historyAvailable asOfUnix={observedAt} timeZone="Asia/Tashkent" />)
    expect(tashkent).toContain('vaqt zonasi: Asia/Tashkent'); expect(tashkent).toContain('apparat soati · Asia/Tashkent')
    expect(tashkent).not.toContain('UTC sanalari'); expect(tashkent).toContain('to‘liq kunlik hisobot bermaydi')
  })
  it('leaves an invalid timezone visibly unknown instead of silently grouping UTC dates', () => {
    const html = renderToStaticMarkup(<ManufacturingRecordedAnalytics timelines={[timeline()]} historyAvailable asOfUnix={observedAt} timeZone="not-a-timezone" />)
    expect(html).toContain('vaqt zonasi: noma’lum'); expect(html).toContain('Sana bo‘yicha kuzatuv hisoblanmadi')
    expect(html).not.toContain('data-slot="composed-chart"'); expect(html).not.toContain('UTC')
  })
})
