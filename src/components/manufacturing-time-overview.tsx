import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { cn } from 'cn'
import { isRecord } from '@/lib/api'
import type { ProductionSnapshot } from '@/lib/api-types'
import { dashboardCount, dashboardOrderCounts, dashboardOrders, dashboardQueues } from '@/lib/dashboard'
import { manufacturingDurationLabel, manufacturingOverview } from '@/lib/manufacturing-time'
import type { ManufacturingRanking, ManufacturingTimeline } from '@/lib/manufacturing-time'
import { DashboardMetric, DashboardNote, DashboardSurface } from '@/components/dashboard-surface'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export interface ManufacturingTimeOverviewProps {
  timelines: readonly ManufacturingTimeline[]
  snapshot?: ProductionSnapshot
  historyAvailable?: boolean
  onSelectOrder?: (orderId: string) => void
  className?: string
}

export function ManufacturingTimeOverview({ timelines, snapshot, historyAvailable = true, onSelectOrder, className }: ManufacturingTimeOverviewProps) {
  const overview = manufacturingOverview(timelines)
  const orders = dashboardOrders(snapshot), live = dashboardOrderCounts(orders)
  const queues = dashboardQueues(snapshot), queuesAvailable = Boolean(snapshot && isRecord(snapshot.visible_order_ids))
  const rankings = overview.rankings.slice(0, 8)
  const maximum = rankings[0]?.inProgressSeconds || 1
  const queueMaximum = Math.max(1, ...queues.map(queue => queue.total))
  const [selectedKey, setSelectedKey] = useState('')
  const selected = rankings.find(row => rankingKey(row) === selectedKey) ?? rankings[0]

  return <DashboardSurface aria-label="Ishlab chiqarish vaqtiga umumiy qarash" className={className}>
    <div className="grid grid-cols-2 border-b border-border/65 xl:grid-cols-4">
      <DashboardMetric className="border-r border-border/65" label="Olingan buyurtma tarixi" value={historyAvailable ? String(overview.loadedOrders) : '—'} detail="Yopilgan buyurtmalar ro‘yxati · eng so‘nggi 200 tagacha" />
      <DashboardMetric className="xl:border-r xl:border-border/65" label="Vaqt oralig‘i mavjud" value={historyAvailable ? String(overview.eligibleOrders) : '—'} detail={historyAvailable ? `${overview.excludedOrders} buyurtmada hisoblashga yetarli qayd yo‘q` : 'Tarix ma’lumoti olinmagan'} />
      <DashboardMetric className="border-r border-t border-border/65 xl:border-t-0" label="Qaydi yetarli bo‘lmagan" value={historyAvailable ? String(overview.ordersWithGaps) : '—'} detail="Vaqt qaydlari yo‘q, noaniq yoki bosqichga ulanmagan" />
      <DashboardMetric className="border-t border-border/65 xl:border-t-0" label="Hozir jarayonda" value={dashboardCount(live.running, Boolean(snapshot), live.unknown > 0)} detail={snapshot ? `${dashboardCount(live.queued, true, live.unknown > 0)} buyurtma navbatda${live.unknown ? ` · ${live.unknown} holat noma’lum` : ''}` : 'Joriy holat olinmagan'} />
    </div>
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
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
      <aside aria-label="Joriy navbat bosimi" className="min-w-0 border-t border-border/65 bg-muted/15 px-5 py-6 sm:px-6 lg:border-l lg:border-t-0">
        <h2 className="text-sm font-medium tracking-tight">Joriy navbat bosimi</h2><DashboardNote className="mt-1">Uskunalarda ko‘rinadigan navbat va ishlayotgan buyurtmalar.</DashboardNote>
        {queues.length ? <ul className="mt-4 divide-y divide-border/65">{queues.slice(0, 6).map(queue => <li key={queue.apparatusId} className="py-4 first:pt-1">
          <div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words text-xs font-medium">{queue.label}</p><p className="shrink-0 text-xl font-medium leading-none tracking-tight tabular-nums">{queue.total}<span className="ml-1 text-[10px] font-normal text-muted-foreground">buyurtma</span></p></div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-foreground/45" style={{ width: `${queue.total / queueMaximum * 100}%` }} /></div>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Navbatda: <span className="font-mono tabular-nums text-foreground">{dashboardCount(queue.waiting, true, queue.unknown > 0)}</span> · Jarayonda: <span className="font-mono tabular-nums text-foreground">{dashboardCount(queue.running, true, queue.unknown > 0)}</span>{queue.unknown > 0 && ` · ${queue.unknown} holat noma’lum`}</p>
          {onSelectOrder && queue.firstOrderId && <Button variant="ghost" size="sm" className="mt-1 h-auto max-w-full justify-start whitespace-normal px-0 text-left text-[11px]" onClick={() => onSelectOrder(queue.firstOrderId)}>{orders.find(order => order.id === queue.firstOrderId)?.saved.map.order_number ? `#${String(orders.find(order => order.id === queue.firstOrderId)!.saved.map.order_number)}` : queue.firstOrderId}<ArrowUpRight className="size-3 shrink-0" /></Button>}
        </li>)}</ul> : <p className="py-10 text-sm leading-6 text-muted-foreground">{queuesAvailable ? 'Uskunalarning ko‘rinadigan navbatida buyurtma yo‘q.' : 'Joriy navbat qamrovi olinmagan.'}</p>}
        <DashboardNote className="mt-4 border-t border-border/65 pt-3">Navbat soni ishga kirish vaqtini ko‘rsatmaydi. Kutish davomiyligi uchun navbatga kirish hodisasi talab qilinadi.</DashboardNote>
      </aside>
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
