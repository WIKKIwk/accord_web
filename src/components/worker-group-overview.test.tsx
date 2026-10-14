import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkerGroup } from '@/lib/worker-groups'
import { WorkerGroupOverview } from './worker-group-overview'

function group(patch: Partial<WorkerGroup> = {}): WorkerGroup {
  return { apparatus_id: 'apparatus:qa:print', apparatus: 'Bosma', group_code: 'A', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: [], workers: [], ...patch }
}
function metric(html: string, key: string): string | undefined {
  return new RegExp(`data-metric="${key}"[^>]*>[\\s\\S]*?data-slot="metric-value"[^>]*>(.*?)</span>`).exec(html)?.[1]
}

describe('compact worker-group overview', () => {
  it('uses genuine dashboardcn KPI and MetricList structures for exact directory questions', () => {
    const html = renderToStaticMarkup(<WorkerGroupOverview groups={[
      group({ worker_ids: ['a', 'b'], accounting_enabled: true }),
      group({ group_code: 'B', worker_ids: ['a', 'c'] }),
      group({ apparatus_id: 'apparatus:qa:cut', apparatus: 'Kesish' }),
    ]} />)
    expect((html.match(/data-slot="kpi-card"/g) ?? []).length).toBe(4)
    expect(html).toContain('data-slot="card-header"'); expect(html).toContain('data-slot="card-title"')
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(2)
    expect(metric(html, 'groups')).toBe('3'); expect(metric(html, 'members')).toBe('3')
    expect(metric(html, 'accounting')).toBe('1'); expect(metric(html, 'empty')).toBe('1')
    expect(html).toContain('Har bir biriktirilgan ishchi bir marta sanaladi')
    expect(html).toContain('<details '); expect(html).toContain('<summary '); expect(html).not.toContain('<details open')
    expect(html).toContain('grid-cols-2'); expect(html).toContain('sm:grid-cols-4')
    for (const invented of ['data-slot="sparkline"', 'data-slot="delta-badge"', 'data-slot="dot-plot"', 'data-slot="radar-chart"', 'gradient']) expect(html).not.toContain(invented)
  })

  it('keeps the empty state small and distinguishes unavailable data from zero', () => {
    const empty = renderToStaticMarkup(<WorkerGroupOverview groups={[]} />)
    for (const key of ['groups', 'members', 'accounting', 'empty']) expect(metric(empty, key)).toBe('0')
    expect(empty).not.toContain('<details'); expect(empty).not.toContain('data-slot="metric-list"')
    const unavailable = renderToStaticMarkup(<WorkerGroupOverview groups={[group()]} available={false} />)
    for (const key of ['groups', 'members', 'accounting', 'empty']) expect(metric(unavailable, key)).toBe('—')
    expect(unavailable).toContain('Guruhlar ma’lumotlari olinmagan'); expect(unavailable).not.toContain('<details')
  })

  it('shows unknown membership and accounting totals without provisional zeros', () => {
    const html = renderToStaticMarkup(<WorkerGroupOverview groups={[{ ...group(), worker_ids: null, accounting_enabled: null } as unknown as WorkerGroup]} />)
    expect(metric(html, 'groups')).toBe('1')
    for (const key of ['members', 'accounting', 'empty']) expect(metric(html, key)).toBe('—')
    expect(html).toContain('Ayrim qaydlar noma’lum'); expect(html).not.toContain('<details')
    const invalid = renderToStaticMarkup(<WorkerGroupOverview groups={[group(), group()]} />)
    for (const key of ['groups', 'members', 'accounting', 'empty']) expect(metric(invalid, key)).toBe('—')
    expect(invalid).toContain('Guruh qaydlari to‘liq emas'); expect(invalid).not.toContain('data-slot="metric-list"')
  })

  it('keeps apparatus distribution collapsed and discloses the exact remainder after six rows', () => {
    const groups = Array.from({ length: 8 }, (_, index) => group({ apparatus_id: `apparatus:qa:unit-${index}`, apparatus: `Apparat ${index}` }))
    groups.push(group({ apparatus_id: 'apparatus:qa:unit-7', apparatus: 'Apparat 7', group_code: 'B' }))
    const html = renderToStaticMarkup(<WorkerGroupOverview groups={groups} className="qa-overview" />)
    expect(metric(html, 'groups')).toBe('9')
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(6)
    expect(html).toContain('Apparat 7'); expect(html).not.toContain('Apparat 6</span>')
    expect(html).toContain('Eng ko‘p guruhli 6 apparat ko‘rsatilgan')
    expect(html).toContain('Qolgan <span data-slot="metric-value" class="tabular-nums">2</span> apparatda jami <span data-slot="metric-value" class="tabular-nums">2</span> guruh bor.')
    expect(html).toContain('qa-overview'); expect(html).not.toContain('open=""')
  })
})
