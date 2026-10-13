import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KpiCard } from './kpi-card'
import { MetricList } from './metric-list'
import { MetricValue } from './metric-value'
import { Timeline, TimelineConnector, TimelineContent, TimelineItem, TimelineMarker, TimelineRail, TimelineTime } from './timeline'

describe('adapted dashboardcn observed metric primitives', () => {
  it('preserves exact lower bounds, unknown values, zero and escaped native text without compacting counts', () => {
    for (const value of ['—', '2+', '0', '1 234 567']) {
      const html = renderToStaticMarkup(<MetricValue value={value} />)
      expect(html).toContain(`>${value}</span>`)
      expect(html).not.toContain('data-compact')
    }
    const number = 1_234_567
    expect(renderToStaticMarkup(<MetricValue value={number} />)).toContain(new Intl.NumberFormat('uz-UZ').format(number))
    expect(renderToStaticMarkup(<MetricValue value={1.234567} />)).toContain('1,234567')
    const small = renderToStaticMarkup(<MetricValue value={1.2e-24} />)
    expect(small).toContain('0,0000000000000000000000012'); expect(small).not.toContain('>0</span>')
    for (const value of [NaN, Infinity, -Infinity]) expect(renderToStaticMarkup(<MetricValue value={value} />)).toContain('>—</span>')
    const escaped = renderToStaticMarkup(<MetricValue value={'<script>saved text</script>'} />)
    expect(escaped).toContain('&lt;script&gt;'); expect(escaped).not.toContain('<script>')
  })

  it('keeps a loading KPI value unknown and retains the accessible value identity and explicit coverage text', () => {
    const props = { label: 'Kutilayotgan WIP', value: '2+', valueId: 'observed-wip', children: <p>Yuklangan qism · kamida 2 partiya</p> }
    const loading = renderToStaticMarkup(<KpiCard {...props} loading />)
    expect(loading).toContain('id="observed-wip"'); expect(loading).toContain('Kutilayotgan WIP yuklanmoqda')
    expect(loading).not.toContain('data-slot="metric-value"')
    const ready = renderToStaticMarkup(<KpiCard {...props} />)
    expect(ready).toContain('id="observed-wip"'); expect(ready).toContain('>2+</span>')
    expect(ready).toContain('kamida 2 partiya')
    expect(ready).not.toContain('delta-badge'); expect(ready).not.toContain('sparkline'); expect(ready).not.toContain('gradient')
  })

  it('renders each supplied fact once as a semantic list while retaining unknown and bounded values', () => {
    const html = renderToStaticMarkup(<MetricList aria-label="Yuklangan holatlar" layout="inline" items={[
      { key: 'ready', label: 'Ishga tayyor', value: '2+' },
      { key: 'unknown', label: 'Holat noma’lum', value: '—' },
      { key: 'empty', label: 'Qayd etilgan', value: 0 },
    ]} />)
    expect(html).toContain('<ul '); expect((html.match(/<li /g) ?? []).length).toBe(3)
    expect(html).toContain('aria-label="Yuklangan holatlar"')
    expect(html).toContain('>2+</span>'); expect(html).toContain('>—</span>'); expect(html).toContain('>0</span>')
    expect(html).not.toContain('%'); expect(html).not.toContain('sparkline')
  })
})

describe('adapted dashboardcn timeline presentation', () => {
  it('keeps supplied chronology, native timestamps and decorative rails separate from current execution', () => {
    const html = renderToStaticMarkup(<Timeline aria-label="Server hodisalari"><TimelineItem>
      <TimelineRail aria-hidden="true"><TimelineConnector /><TimelineMarker /></TimelineRail>
      <TimelineContent><TimelineTime dateTime="2026-10-13T12:00:00.000Z">12:00</TimelineTime>Qayd etilgan hodisa</TimelineContent>
    </TimelineItem></Timeline>)
    expect(html).toContain('<ol '); expect(html).toContain('<li ')
    expect(html).toContain('<time data-slot="timeline-time"')
    expect(html).toContain('dateTime="2026-10-13T12:00:00.000Z"')
    expect(html).toContain('data-slot="timeline-connector" aria-hidden="true"')
    expect(html).toContain('group-last/timeline-item:hidden')
    expect(html).not.toContain('aria-current='); expect(html).not.toContain('animate')
  })
})
