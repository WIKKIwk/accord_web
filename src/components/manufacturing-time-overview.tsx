import { useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { cn } from 'cn'
import type { ProductionSnapshot } from '@/lib/api-types'
import { manufacturingDurationLabel, manufacturingOverview, manufacturingTimeLabel, manufacturingTimeZone } from '@/lib/manufacturing-time'
import type { ManufacturingRanking, ManufacturingTimeline } from '@/lib/manufacturing-time'
import { retainedHistoryAnalytics } from '@/lib/dashboardcn-analytics'
import type { RetainedHistoryPeriod } from '@/lib/dashboardcn-analytics'
import { DashboardNote, DashboardSurface } from '@/components/dashboard-surface'
import { KpiCard } from '@/components/dashboardcn/kpi-card'
import { ComposedChart } from '@/components/dashboardcn/composed-chart'
import { PeriodTabs } from '@/components/dashboardcn/period-tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface ManufacturingTimeOverviewProps {
  timelines: readonly ManufacturingTimeline[]
  snapshot?: ProductionSnapshot
  historyAvailable?: boolean
  onSelectOrder?: (orderId: string) => void
  className?: string
}

export function ManufacturingRecordedAnalytics({ timelines, historyAvailable, asOfUnix, timeZone = manufacturingTimeZone() }: { timelines: readonly ManufacturingTimeline[]; historyAvailable: boolean; asOfUnix: number | null; timeZone?: string }) {
  const [period, setPeriod] = useState<RetainedHistoryPeriod>('all')
  const analytics = useMemo(() => retainedHistoryAnalytics(timelines, period, asOfUnix, { timeZone }), [timelines, period, asOfUnix, timeZone])
  return <section data-slot="manufacturing-recorded-analytics" aria-label="Olingan tarix bo‘yicha vaqt kuzatuvi" className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-sm font-medium">Sana bo‘yicha qayd etilgan vaqt</h2><DashboardNote className="mt-1">Eng so‘nggi 200 tagacha yopilgan buyurtma · vaqt filtri faqat shu qaydlarga qo‘llanadi.</DashboardNote></div>
      <PeriodTabs value={period} onValueChange={value => setPeriod(value as RetainedHistoryPeriod)} options={analytics.asOfUnix === null ? [{ value: 'all', label: 'Olingan tarix' }] : [{ value: '7d', label: '7 kun' }, { value: '30d', label: '30 kun' }, { value: 'all', label: 'Olingan tarix' }]} aria-label="Olingan tarix vaqt oralig‘i" />
    </div>
    <Card className="min-w-0 gap-4 py-5">
      <CardHeader className="px-5"><CardTitle className="text-sm">Jarayon va to‘xtash</CardTitle><CardDescription className="text-xs leading-5">Qayd etilgan apparat soati · vaqt zonasi: {analytics.timeZone ?? 'noma’lum'}</CardDescription></CardHeader>
      <CardContent className="min-w-0 px-5">
        {analytics.observedIntervalCount > 0 && analytics.series.length > 0 ? <ComposedChart aria-label={`Olingan tarixdagi jarayon va to‘xtash oralig‘i, apparat soati · ${analytics.timeZone}`} data={analytics.series} xKey="date" series={[{ key: 'inProgress', label: 'Qayd etilgan jarayon', type: 'bar', color: 'var(--foreground)' }, { key: 'paused', label: 'Qayd etilgan to‘xtash', type: 'line', color: 'var(--muted-foreground)', curve: 'linear', dashed: true, dots: true }]} showYAxis showLegend animate={false} yFormatter={value => `${new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 2 }).format(value / 3600)} soat`} tooltipValueFormatter={manufacturingDurationLabel} className="h-64" /> : <p className="flex min-h-64 items-center justify-center text-center text-xs text-muted-foreground">{analytics.timeZone === null ? 'Vaqt zonasi olinmagan. Sana bo‘yicha kuzatuv hisoblanmadi.' : historyAvailable ? 'Bu vaqt oralig‘ida hisoblashga yetarli jarayon yoki to‘xtash qaydi yo‘q.' : 'Buyurtma tarixi olinmagan.'}</p>}
        <DashboardNote className="mt-3">Bir apparatdagi ustma-ust qaydlar har bir holat uchun bir marta olinadi, keyin apparatlar jamlanadi. Qaydsiz sanalar bo‘sh qoladi; filtr to‘liq kunlik hisobot bermaydi. Kuzatuv: {analytics.timeZone ? manufacturingTimeLabel(analytics.asOfUnix, analytics.timeZone) : '—'}.</DashboardNote>
      </CardContent>
    </Card>
  </section>
}

export function ManufacturingTimeOverview({ timelines, historyAvailable = true, onSelectOrder, className }: ManufacturingTimeOverviewProps) {
  const overview = manufacturingOverview(timelines)
  const rankings = overview.rankings.slice(0, 8)
  const maximum = rankings[0]?.inProgressSeconds || 1
  const [selectedKey, setSelectedKey] = useState('')
  const selected = rankings.find(row => rankingKey(row) === selectedKey) ?? rankings[0]

  return <DashboardSurface aria-label="Ishlab chiqarish vaqtiga umumiy qarash" className={className}>
    <div className="grid grid-cols-2 border-b border-border/65 xl:grid-cols-4">
      <KpiCard className="rounded-none border-r border-border/65 ring-0" label="Olingan buyurtma tarixi" value={historyAvailable ? String(overview.loadedOrders) : '—'} valueClassName="text-[2.5rem] font-medium">Yopilgan buyurtmalar ro‘yxati · eng so‘nggi 200 tagacha</KpiCard>
      <KpiCard className="rounded-none ring-0 xl:border-r xl:border-border/65" label="Vaqt oralig‘i mavjud" value={historyAvailable ? String(overview.eligibleOrders) : '—'} valueClassName="text-[2.5rem] font-medium">{historyAvailable ? `${overview.excludedOrders} buyurtmada hisoblashga yetarli qayd yo‘q` : 'Tarix ma’lumoti olinmagan'}</KpiCard>
      <KpiCard className="rounded-none border-r border-t border-border/65 ring-0 xl:border-t-0" label="Qaydi yetarli bo‘lmagan" value={historyAvailable ? String(overview.ordersWithGaps) : '—'} valueClassName="text-[2.5rem] font-medium">Vaqt qaydlari yo‘q, noaniq yoki bosqichga ulanmagan</KpiCard>
      <KpiCard className="rounded-none border-t border-border/65 ring-0 xl:border-t-0" label="O‘lchanadigan bosqichlar" value={historyAvailable ? String(overview.rankings.length) : '—'} valueClassName="text-[2.5rem] font-medium">Olingan yopilgan buyurtmalar ichida · jarayon oralig‘i qayd etilgan</KpiCard>
    </div>
    <div className="min-w-0">
      <section aria-label="Eng uzun qayd etilgan jarayonlar" className="min-w-0 px-5 pb-5 pt-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0"><h2 className="text-sm font-medium tracking-tight">Eng uzun qayd etilgan jarayonlar</h2><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Olingan yopilgan buyurtmalar ichida · ikki mos holat qaydi orasida</p></div>
          <span className="rounded-full border border-border/65 px-2.5 py-1 text-[10px] text-muted-foreground">{rankings.length} bosqich</span>
        </div>
        {selected ? <>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-3" aria-live="polite">
            <div><p className="text-[2.15rem] font-medium leading-none tracking-[-0.04em] tabular-nums sm:text-[2.65rem]">{manufacturingDurationLabel(selected.inProgressSeconds)}</p><p className="mt-2 text-xs text-muted-foreground">{selected.stageTitle} · {selected.orderNumber ? `#${selected.orderNumber}` : selected.orderId}</p></div>
            <DashboardNote>Ko‘pdan kamga tartiblangan qaydlar</DashboardNote>
          </div>
          <RecordedDurationPlot rankings={rankings} selected={selected} onSelect={row => setSelectedKey(rankingKey(row))} />
          <ol className="mt-3 grid border-t border-border/65 sm:grid-cols-2 sm:gap-x-6">
            {rankings.map((row, index) => <li key={rankingKey(row)} className="grid grid-cols-[1.2rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 py-3">
              <span className="self-start pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
              <div className="min-w-0"><p className="text-xs font-medium">{row.stageTitle}</p>{onSelectOrder ? <Button variant="link" size="sm" className="mt-0.5 h-auto max-w-full justify-start whitespace-normal px-0 text-left text-[11px] font-normal text-muted-foreground" onClick={() => onSelectOrder(row.orderId)}>{row.orderNumber ? `#${row.orderNumber}` : row.orderId} · {row.title}<ArrowUpRight className="size-3 shrink-0" /></Button> : <p className="mt-1 break-words text-[11px] text-muted-foreground">{row.orderNumber ? `#${row.orderNumber}` : row.orderId} · {row.title}</p>}
                {row.gapCount > 0 && <p className="mt-1 text-[10px] text-muted-foreground">{row.gapCount} oraliq baholanmagan</p>}
                {(row.earlyClosed || row.hasIssue) && <div className="mt-1.5 flex flex-wrap gap-1">{row.earlyClosed && <Badge variant="outline" className="text-[10px]">Erta yopilgan</Badge>}{row.hasIssue && <Badge variant="outline" className="text-[10px]">Muammoli qayd</Badge>}</div>}
              </div>
              <div className="flex min-w-[6rem] flex-col items-end gap-2"><span className="font-mono text-[11px] font-medium tabular-nums">{manufacturingDurationLabel(row.inProgressSeconds)}</span><span className="h-1 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full bg-foreground/55" style={{ width: `${row.inProgressSeconds / maximum * 100}%` }} /></span></div>
            </li>)}
          </ol>
        </> : <div className="flex min-h-64 items-center justify-center text-center"><p className="max-w-sm text-sm leading-6 text-muted-foreground">{historyAvailable ? 'Qayd etilgan jarayon oralig‘ini ko‘rsatish uchun mos bosqich yozuvlari yetarli emas.' : 'Buyurtma tarixi olinmagan.'}</p></div>}
        <DashboardNote className="mt-3 border-t border-border/65 pt-3">Mahsulot va hajm tengligi bu ro‘yxatda tekshirilmagan. Samaradorlikni taqqoslash uchun bir xil mahsulot va hajm bo‘yicha to‘liq tarix kerak.</DashboardNote>
      </section>

    </div>
  </DashboardSurface>
}

function rankingKey(row: ManufacturingRanking) { return `${row.orderId}:${row.stageKey}` }

/** The x-axis is a duration ranking, never a chronological trend or an interpolated missing record. */
function RecordedDurationPlot({ rankings, selected, onSelect }: { rankings: ManufacturingRanking[]; selected: ManufacturingRanking; onSelect: (row: ManufacturingRanking) => void }) {
  const maximum = rankings[0]?.inProgressSeconds || 1
  const point = (index: number, seconds: number) => ({ x: rankings.length === 1 ? 50 : index / (rankings.length - 1) * 100, y: 20 + (1 - seconds / maximum) * 148 })
  const selectedIndex = rankings.findIndex(row => rankingKey(row) === rankingKey(selected)), selectedPoint = point(selectedIndex, selected.inProgressSeconds)
  const points = rankings.map((row, index) => point(index, row.inProgressSeconds))
  return <div className="mt-5 grid grid-cols-[3.6rem_minmax(0,1fr)] gap-2" aria-label="Qayd etilgan bosqich davomiyliklari, uzunligiga ko‘ra">
    <div className="relative h-[204px] font-mono text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">{[1, .5, 0].map(ratio => <span key={ratio} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${20 + (1 - ratio) * 148}px` }}>{manufacturingDurationLabel(Math.round(maximum * ratio))}</span>)}</div>
    <div className="relative min-w-0">
      <div className="relative mx-5 h-[184px]">
        <svg viewBox="0 0 100 184" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {[20, 94, 168].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
          {points.length > 1 && <polyline points={points.map(value => `${value.x},${value.y}`).join(' ')} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          <line x1={selectedPoint.x} x2={selectedPoint.x} y1="8" y2="176" stroke="var(--foreground)" strokeOpacity=".35" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        {rankings.map((row, index) => { const p = point(index, row.inProgressSeconds); return <button key={rankingKey(row)} type="button" aria-label={`${String(index + 1).padStart(2, '0')}. ${row.stageTitle} · ${row.orderNumber ? `#${row.orderNumber}` : row.orderId} · ${manufacturingDurationLabel(row.inProgressSeconds)}`} aria-pressed={rankingKey(row) === rankingKey(selected)} className="absolute flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ left: `${p.x}%`, top: p.y }} onPointerEnter={() => onSelect(row)} onFocus={() => onSelect(row)} onClick={() => onSelect(row)}><span className={cn('size-1.5 rounded-full border border-muted-foreground bg-card', rankingKey(row) === rankingKey(selected) && 'size-2 bg-foreground ring-4 ring-card')} /></button> })}
        <div className="pointer-events-none absolute top-0 z-10 w-[min(12rem,100%)] rounded-xl border border-border/65 bg-popover px-3 py-2.5 text-[11px] text-popover-foreground shadow-sm" style={{ left: `clamp(0px, calc(${selectedPoint.x}% + .75rem), max(0px, calc(100% - 12rem)))` }} aria-hidden="true"><p className="truncate text-muted-foreground">{selected.orderNumber ? `#${selected.orderNumber}` : selected.orderId}</p><p className="mt-1 truncate font-medium">{selected.stageTitle}</p><p className="mt-1 font-mono tabular-nums">{manufacturingDurationLabel(selected.inProgressSeconds)}</p></div>
      </div>
      <div className="relative mx-5 h-5 font-mono text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">{rankings.map((row, index) => <span key={rankingKey(row)} className={cn('absolute top-0 -translate-x-1/2 rounded-full px-1.5 py-0.5', rankingKey(row) === rankingKey(selected) && 'bg-foreground text-background')} style={{ left: `${point(index, row.inProgressSeconds).x}%` }}>{String(index + 1).padStart(2, '0')}</span>)}</div>
    </div>
  </div>
}
