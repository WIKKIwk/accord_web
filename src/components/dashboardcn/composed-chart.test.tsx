import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { manufacturingDurationLabel } from '@/lib/manufacturing-time'
import { ComposedChart } from './composed-chart'

const chartSample = vi.hoisted(() => ({ data: [] as Record<string, unknown>[] }))
vi.mock('recharts', () => {
  const empty = () => null
  return {
    Area: empty, Bar: empty, CartesianGrid: empty, Line: empty, ReferenceDot: empty, ReferenceLine: empty, XAxis: empty,
    ComposedChart: ({ data, children }: { data: Record<string, unknown>[]; children: ReactNode }) => { chartSample.data = data; return <div>{children}</div> },
    YAxis: ({ tickFormatter }: { tickFormatter?: (value: number) => string }) => <span data-tick>{tickFormatter?.(3600)}</span>,
  }
})
vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChartLegend: () => null, ChartLegendContent: () => null, ChartTooltipContent: () => null,
  ChartTooltip: ({ content }: { content: ReactElement<{ formatter: (value: number, name: string, item: { color: string }) => ReactNode }> }) => <div role="tooltip">{content.props.formatter(Number(chartSample.data[0].inProgress), 'inProgress', { color: 'var(--foreground)' })}</div>,
}))

describe('recorded duration tooltip independent of chart tick precision', () => {
  it('keeps sub-18-second recorded values exact while the axis remains scaled to hours', () => {
    for (const seconds of [1, 7, 17]) {
      const html = renderToStaticMarkup(<ComposedChart data={[{ date: '13.10', inProgress: seconds }]} xKey="date" series={[{ key: 'inProgress', label: 'Qayd etilgan jarayon', type: 'bar', color: 'var(--foreground)' }]} yFormatter={value => `${new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 2 }).format(value / 3600)} soat`} tooltipValueFormatter={manufacturingDurationLabel} animate={false} />)
      const tooltip = html.match(/<div role="tooltip">[\s\S]*?<\/div><\/div>/)?.[0] ?? ''
      expect(tooltip).toContain(`${seconds} son`); expect(tooltip).not.toContain('0 soat'); expect(html).toContain('data-tick="true">1 soat')
    }
  })
  it('preserves the upstream axis formatter fallback when no exact tooltip formatter is supplied', () => {
    const html = renderToStaticMarkup(<ComposedChart data={[{ date: '13.10', inProgress: 3600 }]} xKey="date" series={[{ key: 'inProgress', label: 'Jarayon', type: 'line' }]} yFormatter={value => `${value / 3600} soat`} animate={false} />)
    expect(html.match(/<div role="tooltip">[\s\S]*?<\/div><\/div>/)?.[0]).toContain('1 soat')
  })
})
