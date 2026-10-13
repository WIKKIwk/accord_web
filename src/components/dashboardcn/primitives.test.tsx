import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KpiCard } from './kpi-card'
import { MetricList } from './metric-list'
import { MetricValue } from './metric-value'
import { DotPlot } from './dot-plot'
import { HeatmapChart } from './heatmap-chart'
import { PeriodTabs } from './period-tabs'
import { Timeline, TimelineConnector, TimelineContent, TimelineDescription, TimelineHeader, TimelineItem, TimelineMarker, TimelineRail, TimelineTime, TimelineTitle } from './timeline'

describe('reviewed upstream dashboardcn metric structures', () => {
  it('retains the real Card Header/Description/Title/Content structure and accessible native loading state', () => {
    const props = { label: 'Kutilayotgan WIP', value: '2+', valueId: 'observed-wip', children: <p>Yuklangan qism · kamida 2 partiya</p> }
    const ready = renderToStaticMarkup(<KpiCard {...props} />)
    for (const slot of ['kpi-card', 'card-header', 'card-description', 'card-title', 'card-content', 'metric-value']) expect(ready).toContain(`data-slot="${slot}"`)
    expect(ready).toContain('id="observed-wip"'); expect(ready).toContain('>2+</span>')
    expect(ready).toContain('kamida 2 partiya'); expect(ready).not.toContain('data-slot="delta-badge"'); expect(ready).not.toContain('data-slot="sparkline"')
    const loading = renderToStaticMarkup(<KpiCard {...props} loading />)
    expect(loading).toContain('id="observed-wip"'); expect(loading).toContain('Kutilayotgan WIP yuklanmoqda'); expect(loading).not.toContain('data-slot="metric-value"')
  })

  it('keeps exact native strings, zero, small numbers and invalid numeric values visible', () => {
    for (const value of ['—', '2+', '0', '1 234 567']) expect(renderToStaticMarkup(<MetricValue value={value} />)).toContain(`>${value}</span>`)
    const number = 1_234_567
    expect(renderToStaticMarkup(<MetricValue value={number} compactFrom={Infinity} />)).toContain(new Intl.NumberFormat('uz-UZ').format(number))
    expect(renderToStaticMarkup(<MetricValue value={1.234567} />)).toContain('1,234567')
    expect(renderToStaticMarkup(<MetricValue value={1.2e-24} />)).toContain('0,0000000000000000000000012')
    for (const value of [NaN, Infinity, -Infinity]) expect(renderToStaticMarkup(<MetricValue value={value} />)).toContain('>—</span>')
    const escaped = renderToStaticMarkup(<MetricValue value={'<script>saved text</script>'} />)
    expect(escaped).toContain('&lt;script&gt;'); expect(escaped).not.toContain('<script>')
  })

  it('uses the original metric row layout with label and aligned value columns rather than an inline legend', () => {
    const html = renderToStaticMarkup(<MetricList aria-label="Yuklangan holatlar" items={[
      { key: 'ready', label: 'Ishga tayyor', value: '2+' },
      { key: 'unknown', label: 'Holat noma’lum', value: '—' },
      { key: 'empty', label: 'Qayd etilgan', value: 0 },
    ]} />)
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(3)
    expect(html).toContain('flex min-w-0 flex-1 items-center gap-2')
    expect(html).toContain('flex w-28 shrink-0 items-center justify-end gap-2 tabular-nums')
    expect(html).toContain('>2+</span>'); expect(html).toContain('>—</span>'); expect(html).toContain('>0</span>')
    expect(html).not.toContain('data-slot="delta-badge"'); expect(html).not.toContain('data-slot="sparkline"')
  })
})

describe('reviewed upstream dashboardcn chronology and distributions', () => {
  it('renders the complete upstream timeline layout without equating selection to current execution', () => {
    const html = renderToStaticMarkup(<Timeline aria-label="Server hodisalari"><TimelineItem>
      <TimelineRail><TimelineMarker /><TimelineConnector /></TimelineRail>
      <TimelineContent><TimelineHeader><TimelineTitle>Saqlangan hodisa</TimelineTitle><TimelineTime dateTime="2026-10-13T12:00:00.000Z">12:00</TimelineTime></TimelineHeader><TimelineDescription>Server qaydi</TimelineDescription></TimelineContent>
    </TimelineItem></Timeline>)
    for (const slot of ['timeline', 'timeline-item', 'timeline-rail', 'timeline-marker', 'timeline-connector', 'timeline-content', 'timeline-header', 'timeline-title', 'timeline-time', 'timeline-description']) expect(html).toContain(`data-slot="${slot}"`)
    expect(html).toContain('<ol '); expect(html).toContain('<li '); expect(html).toContain('dateTime="2026-10-13T12:00:00.000Z"')
    expect(html).toContain('group-last/timeline-item:hidden'); expect(html).not.toContain('aria-current=')
  })

  it('preserves normalized dot density and exact counts supplied in its accessible description', () => {
    const html = renderToStaticMarkup(<DotPlot data={[1, 4, 0]} labels={['Qisqa', 'O‘rta', 'Uzun']} rows={8} aria-label="Qisqa: 1, O‘rta: 4, Uzun: 0 bosqich; nuqtalar nisbiy zichlik" color="var(--foreground)" />)
    expect(html).toContain('data-slot="dot-plot"'); expect((html.match(/data-slot="dot-plot-column"/g) ?? []).length).toBe(3)
    expect((html.match(/aspect-square w-full rounded-full/g) ?? []).length).toBe(10)
    expect(html).toContain('nuqtalar nisbiy zichlik')
  })

  it('distinguishes unknown heatmap cells from observed zero and keeps the actual matrix/tooltip structure', () => {
    const html = renderToStaticMarkup(<HeatmapChart rows={[{ label: 'Bosma', values: [null, 0, 120] }]} columns={['11.10', '12.10', '13.10']} color="var(--foreground)" valueFormatter={value => `${value} son`} />)
    expect((html.match(/data-slot="heatmap-chart-cell"/g) ?? []).length).toBe(3)
    expect((html.match(/data-unknown="true"/g) ?? []).length).toBe(1)
    expect(html).toContain('Qayd olinmagan, Bosma 11.10'); expect(html).toContain('0 son, Bosma 12.10'); expect(html).toContain('120 son, Bosma 13.10')
    expect(html).toContain('border-dashed'); expect(html).toContain('background-color:transparent')
  })

  it('uses upstream PeriodTabs and native shadcn tabs with supplied retained-history ranges', () => {
    const html = renderToStaticMarkup(<PeriodTabs value="all" options={[{ value: '7d', label: '7 kun' }, { value: '30d', label: '30 kun' }, { value: 'all', label: 'Olingan tarix' }]} aria-label="Olingan tarix vaqt oralig‘i" />)
    expect(html).toContain('data-slot="period-tabs"'); expect(html).toContain('role="tablist"'); expect((html.match(/role="tab"/g) ?? []).length).toBe(3)
    expect(html).toContain('data-state="active"'); expect(html).toContain('Olingan tarix')
  })
})
