import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProductionSnapshot, ResourceKind, Row } from '@/lib/api-types'
import { apparatusQueueDistribution, domainMetricSummary, materialMicronMatrix, supportsDomainMetrics } from '@/lib/dashboardcn-analytics'
import { manufacturingTimeLabel } from '@/lib/manufacturing-time'
import { KpiCard } from '@/components/dashboardcn/kpi-card'
import { MetricList } from '@/components/dashboardcn/metric-list'
import { DotPlot } from '@/components/dashboardcn/dot-plot'
import { HeatmapChart } from '@/components/dashboardcn/heatmap-chart'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export interface DomainObservation {
  loading: boolean
  fetching: boolean
  error?: string | null
  connection: 'online' | 'offline' | 'checking'
  asOfUnix?: number | null
  refresh?: () => void
  refreshDisabled?: boolean
  emptyPrompt?: string
}

export interface DomainMetricsProps {
  kind: ResourceKind
  items: readonly Row[]
  available: boolean
  bounded?: boolean
  hasMore?: boolean
  filtered?: boolean
  warehouse?: string
  snapshot?: ProductionSnapshot
  snapshotFresh?: boolean
  snapshotAsOfUnix?: number | null
  observation?: DomainObservation
  snapshotStatus?: { loading: boolean; error?: string | null }
  className?: string
}

/** Presentation of current native resource/snapshot queries; it does not request or mutate data. */
export function DomainMetrics({ kind, items, available, bounded = false, hasMore = false, filtered = false, warehouse, snapshot, snapshotFresh = false, snapshotAsOfUnix = null, observation, snapshotStatus, className }: DomainMetricsProps) {
  if (!supportsDomainMetrics(kind)) return null
  const summary = domainMetricSummary(kind, items, available)
  const coverage = !available ? 'Ma’lumotlar olinmagan.' : bounded || hasMore ? 'Yuklangan qism bo‘yicha · ro‘yxat hali to‘liq emas.' : 'Yuklangan ro‘yxat bo‘yicha.'
  const loading = !available && Boolean(observation?.loading)
  const stale = available && Boolean(observation?.error || observation && observation.connection !== 'online')
  const state = loading ? 'loading' : observation?.error ? available ? 'retained' : 'error' : stale ? 'retained' : available ? 'ready' : 'unknown'
  const emptyMessage = observation?.emptyPrompt || (loading ? 'Kuzatuv yuklanmoqda…' : observation?.error ? 'Kuzatuv yuklanmadi. Qayta yuklab ko‘ring.' : available ? 'Bu kuzatuv uchun qayd etilgan yozuv yo‘q.' : 'Ma’lumotlar kutilmoqda.')
  return <section data-slot="domain-metrics" aria-label="Yuklangan ma’lumotlar kuzatuvi" className={className}>
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1">
      <p className="text-xs leading-5 text-muted-foreground">{coverage}{filtered ? ' Joriy qidiruv va filtr doirasida.' : ''}{kind === 'stock' && warehouse ? ` Ombor: ${warehouse}.` : ''} + kamida, — noma’lum.</p>
      {observation && <p role="status" data-observation-state={state} className="mt-1 text-xs leading-5 text-muted-foreground">{loading ? 'Kuzatuv yuklanmoqda…' : observation.emptyPrompt || (observation.connection === 'checking' ? 'Aloqa tekshirilmoqda · oxirgi yuklangan holat.' : observation.connection === 'offline' ? 'Ulanish yo‘q · oxirgi yuklangan holat.' : observation.fetching ? 'Kuzatuv yangilanmoqda…' : stale ? 'Oxirgi yuklangan holat.' : available ? 'Olingan holat.' : observation.error ? 'Kuzatuv olinmagan.' : 'Ma’lumotlar kutilmoqda.')}{available && observation.asOfUnix ? ` Kuzatuv: ${manufacturingTimeLabel(observation.asOfUnix)}.` : ''}</p>}
    </div>{observation?.refresh && <Button variant="outline" size="sm" aria-label="Kuzatuvni yangilash" disabled={observation.fetching || observation.refreshDisabled} onClick={observation.refresh}><RefreshCw className={observation.fetching ? 'animate-spin' : undefined} />{observation.fetching ? 'Yangilanmoqda…' : observation.error || snapshotStatus?.error ? 'Qayta urinish' : 'Yangilash'}</Button>}</div>
    {observation?.error && <Alert className="mb-3"><AlertTitle>{available ? 'Kuzatuv yangilanmadi' : 'Kuzatuv yuklanmadi'}</AlertTitle><AlertDescription>{observation.error}{available && <span> Oxirgi yuklangan ma’lumotlar saqlangan.</span>}</AlertDescription></Alert>}
    <div className="grid gap-3 sm:grid-cols-3">
      {summary.cards.map(metric => <KpiCard key={metric.key} label={metric.label} value={metric.value} loading={loading} valueClassName="text-[2rem] font-medium" className="gap-3 [&_[data-slot=card-description]]:text-xs">{coverage}</KpiCard>)}
    </div>
    {kind === 'apparatus' ? <ApparatusQueueMetrics items={available ? items : []} snapshot={snapshot} fresh={snapshotFresh} asOfUnix={snapshotAsOfUnix} available={available} status={snapshotStatus} /> : kind === 'materials' ? <MaterialVariantMetrics items={available ? items : []} available={available} emptyMessage={!available ? emptyMessage : undefined} /> : <Card className="mt-3 gap-4 py-5">
      <CardHeader className="px-5"><CardTitle className="text-sm">{summary.rowTitle}</CardTitle><CardDescription className="text-xs leading-5">{summary.note}</CardDescription></CardHeader>
      <CardContent className="px-5">{available && summary.rows.length ? <MetricList aria-label={summary.rowTitle} items={summary.rows} className="[&_[data-slot=metric-list-row]]:text-xs [&_[data-slot=metric-list-row]>div:last-child]:w-auto [&_[data-slot=metric-list-row]>div:last-child]:min-w-28" /> : <p className="text-xs text-muted-foreground">{emptyMessage}</p>}</CardContent>
    </Card>}
  </section>
}

function ApparatusQueueMetrics({ items, snapshot, fresh, asOfUnix, available, status }: { items: readonly Row[]; snapshot?: ProductionSnapshot; fresh: boolean; asOfUnix: number | null; available: boolean; status?: DomainMetricsProps['snapshotStatus'] }) {
  const [activeBin, setActiveBin] = useState<number | null>(null)
  const queues = apparatusQueueDistribution(items, snapshot)
  const dotLimit = 16
  const dotsTruncated = queues.bins.some(bin => bin.count > dotLimit)
  return <Card data-slot="apparatus-queue-metrics" className="mt-3 gap-4 py-5">
    <CardHeader className="px-5"><CardTitle className="text-sm">Ko‘rinadigan navbatlar taqsimoti</CardTitle><CardDescription className="text-xs leading-5">Yuklangan apparatlar · har bir apparatdagi ko‘rinadigan buyurtmalar soni</CardDescription></CardHeader>
    <CardContent className="space-y-4 px-5">
      {status?.error && <Alert><AlertTitle>Navbat kuzatuvi yuklanmadi</AlertTitle><AlertDescription>{status.error}{snapshot && <span> Oxirgi yuklangan navbatlar saqlangan.</span>}</AlertDescription></Alert>}
      {status?.loading && !snapshot && <p role="status" className="text-xs text-muted-foreground">Navbat kuzatuvi yuklanmoqda…</p>}
      <p className="text-[11px] leading-5 text-muted-foreground">{snapshot ? fresh ? 'Joriy olingan holat' : 'Oxirgi yuklangan holat' : 'Navbat kuzatuvi olinmagan'} · kuzatuv: {manufacturingTimeLabel(asOfUnix)}. {queues.knownCount} apparat navbati ma’lum{queues.unknownCount ? ` · ${queues.unknownCount} apparat navbati noma’lum` : ''}.</p>
      {queues.knownCount > 0 ? <div className="max-w-xl">
        <DotPlot data={queues.bins.map(bin => bin.count)} labels={queues.bins.map(bin => bin.label)} max={dotLimit} rows={dotLimit} color="var(--foreground)" emphasis={0} activeIndex={activeBin} onActiveIndexChange={setActiveBin} valueFormatter={value => `${value} apparat`} aria-label={`Apparatlardagi ko‘rinadigan navbatlar: ${queues.bins.map(bin => `${bin.label}: ${bin.count} apparat`).join(', ')}. Bitta nuqta bitta apparat; ustunda eng ko‘p ${dotLimit} nuqta.`} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }} className="min-h-16 items-end py-2 [--dot-size:0.875rem] [--dot-gap:0.25rem] [&_[data-slot=dot-plot-column]]:max-w-none [&_[data-slot=dot-plot-column]]:items-center [&_[data-slot=dot-plot-column]]:px-0 [&_[data-slot=dot-plot-column]>span:not([role=tooltip])]:w-3.5" />
        <ol className="grid grid-cols-4 text-center text-[11px]">{queues.bins.map((bin, index) => <li key={bin.label}><button type="button" className="flex w-full flex-col items-center gap-1 rounded-md px-1 py-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-pressed={activeBin === index} onClick={() => setActiveBin(activeBin === index ? null : index)} onFocus={() => setActiveBin(index)}><span>{bin.label}</span><span className="font-mono tabular-nums text-foreground">{bin.count} apparat</span>{bin.count > dotLimit && <span className="text-[10px]">{dotLimit} ta nuqtada</span>}</button></li>)}</ol>
        <p className="mt-2 text-[10px] leading-5 text-muted-foreground">1 nuqta — 1 apparat.{dotsTruncated ? ` Har bir ustunda eng ko‘p ${dotLimit} tasi nuqtada ko‘rsatilgan; aniq sonlar ustun ostida.` : ''}</p>
      </div> : <p className="text-xs text-muted-foreground">{available && items.length ? 'Navbat taqsimoti uchun tasdiqlangan apparat qaydi yetarli emas.' : available ? 'Yuklangan apparat yo‘q.' : 'Apparat ma’lumotlari kutilmoqda.'}</p>}
      {queues.rows.length > 0 && <MetricList aria-label="Apparatlardagi ko‘rinadigan buyurtmalar" items={queues.rows} className="[&_[data-slot=metric-list-row]]:text-xs [&_[data-slot=metric-list-row]>div:last-child]:w-auto [&_[data-slot=metric-list-row]>div:last-child]:min-w-28" />}
      <p className="text-[10px] leading-5 text-muted-foreground">— navbat qaydi olinmagan. Navbat soni kutish davomiyligini bildirmaydi.</p>
    </CardContent>
  </Card>
}

function MaterialVariantMetrics({ items, available, emptyMessage }: { items: readonly Row[]; available: boolean; emptyMessage?: string }) {
  const matrix = materialMicronMatrix(items)
  return <Card data-slot="material-micron-metrics" className="mt-3 min-w-0 gap-4 py-5">
    <CardHeader className="px-5"><CardTitle className="text-sm">Material va mikron variantlari</CardTitle><CardDescription className="text-xs leading-5">Material katalogidagi qalinlik variantlari · eng ko‘p 8 material va 12 mikron</CardDescription></CardHeader>
    <CardContent className="space-y-3 px-5">
      {matrix.rows.length > 0 && matrix.columns.length > 0 ? <div className="overflow-x-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} aria-label="Material va mikron jadvali, kichik ekranda gorizontal aylantiriladi"><HeatmapChart rows={matrix.rows} columns={matrix.columns.map(micron => `${micron} mkm`)} color="var(--foreground)" max={1} levels={2} gap={5} showLegend={false} columnLabelEvery={1} valueFormatter={value => value === 1 ? 'Variant bor' : 'Variant yo‘q'} aria-label="Material katalogidagi mikron variantlari" style={{ minWidth: Math.max(240, matrix.columns.length * 40 + 140) }} className="[&_[data-slot=heatmap-chart-cell]]:h-9 [&_[data-slot=heatmap-chart-cell]]:aspect-auto [&_[data-slot=heatmap-chart-row-label]]:max-w-32 [&_[data-slot=heatmap-chart-row-label]]:truncate" /></div> : <p className="py-4 text-xs text-muted-foreground">{emptyMessage || (available ? 'Jadval uchun aniq mikron varianti olinmagan.' : 'Material ma’lumotlari kutilmoqda.')}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><span className="size-3 rounded-sm bg-foreground" aria-hidden="true" />Variant bor</span><span className="flex items-center gap-1.5"><span className="size-3 rounded-sm border border-border bg-muted" aria-hidden="true" />Variant yo‘q</span><span className="flex items-center gap-1.5"><span className="size-3 rounded-sm border border-dashed border-muted-foreground/50" aria-hidden="true" />Qayd noma’lum</span></div>
      <p className="text-[10px] leading-5 text-muted-foreground">Katalog variantlari. Ombordagi qoldiq alohida ko‘rsatiladi.{matrix.unknownRows > 0 ? ` ${matrix.unknownRows} materialning variant qaydi noma’lum.` : ''}{matrix.omittedRows > 0 ? ` ${matrix.omittedRows} material bu ko‘rinishda qisqartirilgan.` : ''}{matrix.omittedColumns > 0 ? ` ${matrix.omittedColumns} mikron ustuni bu ko‘rinishda qisqartirilgan.` : ''}</p>
    </CardContent>
  </Card>
}
