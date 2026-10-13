import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DomainMetrics } from './domain-metrics'

describe('recognizable resource dashboardcn summaries', () => {
  it('mounts original KPI/MetricList rows with partial filter scope and units', () => {
    const html = renderToStaticMarkup(<DomainMetrics kind="stock" available bounded hasMore filtered warehouse="Xomashyo" items={[{ code: 'PET', name: 'PET 12', uom: 'kg', on_hand_qty: 123.45, package_count: 2 }, { code: 'PE', name: 'PE 50', uom: 'metr', on_hand_qty: 500, package_count: 1 }]} />)
    expect((html.match(/data-slot="kpi-card"/g) ?? []).length).toBe(3)
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(2)
    expect(html).toContain('data-slot="card-header"'); expect(html).toContain('data-slot="card-title"'); expect(html).toContain('data-slot="card-content"')
    expect(html).toContain('123,45 kg'); expect(html).toContain('500 metr'); expect(html).toContain('ro‘yxat hali to‘liq emas'); expect(html).toContain('qidiruv va filtr'); expect(html).toContain('Ombor: Xomashyo')
    expect(html).not.toContain('data-slot="sparkline"'); expect(html).not.toContain('data-slot="delta-badge"')
  })
  it('does not add unsupported summaries or a zero when native data is unavailable', () => {
    expect(renderToStaticMarkup(<DomainMetrics kind="workers" items={[]} available />)).toBe('')
    const html = renderToStaticMarkup(<DomainMetrics kind="materials" items={[]} available={false} />)
    expect((html.match(/>—<\/span>/g) ?? []).length).toBe(3)
    expect(html).toContain('Ma’lumotlar olinmagan'); expect(html).not.toContain('>0</span>')
  })
})

import type { ProductionSnapshot } from '@/lib/api-types'
const queueSnapshot = (visible: Record<string, unknown>): ProductionSnapshot => ({ ok: true, rev: 1, epoch: 'fixture', scope: 'admin', maps: [], order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {}, visible_order_ids: visible })

describe('domain-specific actual chart placement', () => {
  it('shows one dot per apparatus and exact rows on aligned categories, with freshness and unknown scope', () => {
    const html = renderToStaticMarkup(<DomainMetrics kind="apparatus" available snapshot={queueSnapshot({ 'apparatus:default:a': [], 'apparatus:default:b': ['order'] })} snapshotFresh={false} snapshotAsOfUnix={Date.UTC(2026, 9, 13, 12) / 1000} items={[
      { apparatus_id: 'apparatus:default:a', display: { display_name: 'Bosma A' }, lifecycle: { state: 'active' } },
      { apparatus_id: 'apparatus:default:b', display: { display_name: 'Bosma B' }, lifecycle: { state: 'active' } },
      { apparatus_id: 'apparatus:default:c', display: { display_name: 'Kesish' }, lifecycle: { state: 'active' } },
    ]} />)
    expect(html).toContain('data-slot="dot-plot"'); expect(html).toContain('data-slot="metric-list"')
    expect((html.match(/data-slot="dot-plot-column"/g) ?? []).length).toBe(4)
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(3)
    expect(html).toContain('0 buyurtma'); expect(html).toContain('1 buyurtma'); expect(html).toContain('3+ buyurtma')
    expect(html).toContain('Oxirgi yuklangan holat'); expect(html).toContain('1 apparat navbati noma’lum')
    expect(html).toContain('1 nuqta — 1 apparat.')
    expect(html).toContain('display:grid;grid-template-columns:repeat(4, minmax(0, 1fr))')
    expect(html).toContain('grid grid-cols-4 text-center')
    expect((html.match(/class="aspect-square w-full rounded-full transition-opacity"/g) ?? []).length).toBe(2)
    expect(html).not.toContain('data-slot="heatmap-chart"'); expect(html).not.toContain('data-slot="composed-chart"')
  })
  it('does not turn absent queue snapshot data into zero-valued chart geometry', () => {
    const html = renderToStaticMarkup(<DomainMetrics kind="apparatus" available items={[{ apparatus_id: 'apparatus:default:a', display: { display_name: 'Bosma' }, lifecycle: { state: 'active' } }]} />)
    expect(html).not.toContain('data-slot="dot-plot"'); expect(html).toContain('Navbat kuzatuvi olinmagan')
    expect(html).toContain('1 apparat navbati noma’lum'); expect(html).toContain('>—</span>')
  })
  it('uses a compact material-by-micron matrix with distinct present/absent/unknown cells and no duplicate list', () => {
    const html = renderToStaticMarkup(<DomainMetrics kind="materials" available items={[
      { id: 'pet', name: 'PET', active: true, variants: [{ micron: 12 }] },
      { id: 'pe', name: 'PE', active: true, variants: [{ micron: 50 }] },
      { id: 'missing', name: 'Missing', active: false },
    ]} />)
    expect(html).toContain('data-slot="heatmap-chart"'); expect((html.match(/data-slot="heatmap-chart-cell"/g) ?? []).length).toBe(6)
    expect((html.match(/data-unknown="true"/g) ?? []).length).toBe(2)
    expect(html).toContain('Variant bor, PET 12 mkm'); expect(html).toContain('Variant yo‘q, PET 50 mkm'); expect(html).toContain('Qayd olinmagan, Missing · faol emas 12 mkm')
    expect(html).toContain('heatmap-chart-cell]]:h-9'); expect(html).toContain('heatmap-chart-cell]]:aspect-auto')
    expect(html).toContain('Katalog variantlari. Ombordagi qoldiq alohida ko‘rsatiladi.')
    expect(html).not.toContain('data-slot="metric-list"'); expect(html).not.toContain('data-slot="dot-plot"')
    expect(html).not.toContain('>Kam</span>'); expect(html).not.toContain('>Ko‘p</span>')
  })
  it('discloses material/micron truncation without inventing a chart for an unknown-only response', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ id: `m-${index}`, name: `Material ${index}`, active: true, variants: Array.from({ length: 15 }, (_, micron) => ({ micron: micron + 1 })) }))
    const html = renderToStaticMarkup(<DomainMetrics kind="materials" available items={items} />)
    expect(html).toContain('2 material bu ko‘rinishda qisqartirilgan'); expect(html).toContain('3 mikron ustuni bu ko‘rinishda qisqartirilgan')
    expect((html.match(/data-slot="heatmap-chart-cell"/g) ?? []).length).toBe(8 * 12)
    const unknown = renderToStaticMarkup(<DomainMetrics kind="materials" available items={[{ id: 'missing' }]} />)
    expect(unknown).not.toContain('data-slot="heatmap-chart-cell"'); expect(unknown).toContain('Jadval uchun aniq mikron varianti olinmagan')
  })
})

describe('exact apparatus dots through the upstream count configuration', () => {
  it('renders two apparatus as two dots, one as one dot, with labels on the same four tracks', () => {
    const items = ['a', 'b', 'c'].map(id => ({ apparatus_id: `apparatus:default:${id}`, display: { display_name: id }, lifecycle: { state: 'active' } }))
    const html = renderToStaticMarkup(<DomainMetrics kind="apparatus" available snapshotFresh snapshot={queueSnapshot({ 'apparatus:default:a': [], 'apparatus:default:b': [], 'apparatus:default:c': ['order'] })} items={items} />)
    expect((html.match(/class="aspect-square w-full rounded-full transition-opacity"/g) ?? []).length).toBe(3)
    expect(html).toContain('0 buyurtma: 2 apparat, 1 buyurtma: 1 apparat')
    expect(html).toContain('>2 apparat</span>'); expect(html).toContain('>1 apparat</span>')
    expect(html).toContain('grid-template-columns:repeat(4, minmax(0, 1fr))'); expect(html).toContain('grid grid-cols-4 text-center')
    expect(html).not.toContain('Nuqtalar nisbiy zichlik')
  })
  it('discloses the sixteen-dot cap without changing raw exact counts or hiding known rows', () => {
    const items = Array.from({ length: 18 }, (_, index) => ({ apparatus_id: `apparatus:default:a-${index}`, display: { display_name: `A ${index}` }, lifecycle: { state: 'active' } }))
    const snapshot = queueSnapshot(Object.fromEntries(items.map(item => [item.apparatus_id, []])))
    const html = renderToStaticMarkup(<DomainMetrics kind="apparatus" available bounded hasMore snapshot={snapshot} items={items} />)
    expect((html.match(/class="aspect-square w-full rounded-full transition-opacity"/g) ?? []).length).toBe(16)
    expect(html).toContain('0 buyurtma: 18 apparat'); expect(html).toContain('>18 apparat</span>')
    expect((html.match(/data-slot="metric-list-row"/g) ?? []).length).toBe(18)
    expect(html).toContain('16 ta nuqtada'); expect(html).toContain('eng ko‘p 16 tasi nuqtada ko‘rsatilgan')
    expect(html).toContain('ro‘yxat hali to‘liq emas')
  })
})
