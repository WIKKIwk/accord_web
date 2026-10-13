import { ArrowUpRight, Clock3, ListOrdered } from 'lucide-react'
import { cn } from 'cn'
import { isRecord } from '@/lib/api'
import type { ProductionSnapshot } from '@/lib/api-types'
import { dashboardCount, dashboardOrderCounts, dashboardOrders, dashboardQueues } from '@/lib/dashboard'
import { manufacturingDurationLabel, manufacturingOverview } from '@/lib/manufacturing-time'
import type { ManufacturingTimeline } from '@/lib/manufacturing-time'
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

export function ManufacturingTimeOverview({ timelines, snapshot, historyAvailable = true, onSelectOrder, className }: ManufacturingTimeOverviewProps) {
  const overview = manufacturingOverview(timelines)
  const orders = dashboardOrders(snapshot), live = dashboardOrderCounts(orders)
  const queues = dashboardQueues(snapshot), queuesAvailable = Boolean(snapshot && isRecord(snapshot.visible_order_ids))
  const rankings = overview.rankings.slice(0, 8)
  const maximum = rankings[0]?.inProgressSeconds ?? 1
  return <div className={cn('space-y-4', className)}>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <OverviewMetric label="Olingan buyurtma tarixi" value={historyAvailable ? String(overview.loadedOrders) : '—'} detail="Yopilgan buyurtmalar ro‘yxati · eng so‘nggi 200 tagacha" />
      <OverviewMetric label="Vaqt oralig‘i mavjud" value={historyAvailable ? String(overview.eligibleOrders) : '—'} detail={historyAvailable ? `${overview.excludedOrders} buyurtmada hisoblashga yetarli qayd yo‘q` : 'Tarix ma’lumoti olinmagan'} />
      <OverviewMetric label="Qaydi yetarli bo‘lmagan" value={historyAvailable ? String(overview.ordersWithGaps) : '—'} detail="Vaqt qaydlari yo‘q, noaniq yoki bosqichga ulanmagan" />
      <OverviewMetric label="Hozir jarayonda" value={dashboardCount(live.running, Boolean(snapshot), live.unknown > 0)} detail={snapshot ? `${dashboardCount(live.queued, true, live.unknown > 0)} buyurtma navbatda${live.unknown ? ` · ${live.unknown} holat noma’lum` : ''}` : 'Joriy holat olinmagan'} />
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
      <Card className="min-w-0"><CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="size-4 text-muted-foreground" />Eng uzun qayd etilgan jarayonlar</CardTitle><CardDescription>Olingan yopilgan buyurtmalar ichida. Ikki mos holat qaydi orasidagi jarayon vaqti.</CardDescription></CardHeader><CardContent>
        {rankings.length ? <ol className="space-y-4">{rankings.map((row, index) => <li key={`${row.orderId}:${row.stageKey}`} className="space-y-2">
          <div className="flex items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-3"><span className="pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0"><p className="break-words text-sm font-medium">{row.stageTitle}</p>{onSelectOrder ? <Button variant="link" size="sm" className="h-auto max-w-full justify-start whitespace-normal px-0 text-left text-xs text-muted-foreground" onClick={() => onSelectOrder(row.orderId)}>{row.orderNumber ? `#${row.orderNumber}` : row.orderId} · {row.title}<ArrowUpRight className="size-3 shrink-0" /></Button> : <p className="mt-1 break-words text-xs text-muted-foreground">{row.orderNumber ? `#${row.orderNumber}` : row.orderId} · {row.title}</p>}</div></div><p className="shrink-0 font-mono text-sm font-medium tabular-nums">{manufacturingDurationLabel(row.inProgressSeconds)}</p></div>
          <div className="ml-8 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-foreground/70" style={{ width: `${row.inProgressSeconds / maximum * 100}%` }} /></div>
          {row.gapCount > 0 && <p className="ml-8 text-[11px] text-muted-foreground">{row.gapCount} oraliq baholanmagan</p>}
          {(row.earlyClosed || row.hasIssue) && <div className="ml-8 flex flex-wrap gap-1">{row.earlyClosed && <Badge variant="outline">Erta yopilgan</Badge>}{row.hasIssue && <Badge variant="outline">Muammoli qayd</Badge>}</div>}
        </li>)}</ol> : <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{historyAvailable ? 'Qayd etilgan jarayon oralig‘ini ko‘rsatish uchun mos bosqich yozuvlari yetarli emas.' : 'Buyurtma tarixi olinmagan.'}</p>}
        <p className="mt-5 border-t pt-3 text-xs leading-5 text-muted-foreground">Mahsulot va hajm tengligi bu ro‘yxatda tekshirilmagan. Samaradorlikni taqqoslash uchun bir xil mahsulot va hajm bo‘yicha to‘liq tarix kerak.</p>
      </CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle className="flex items-center gap-2"><ListOrdered className="size-4 text-muted-foreground" />Joriy navbat bosimi</CardTitle><CardDescription>Uskunalarda ko‘rinadigan navbat va ishlayotgan buyurtmalar.</CardDescription></CardHeader><CardContent>
        {queues.length ? <ul className="divide-y">{queues.slice(0, 6).map(queue => <li key={queue.apparatusId} className="space-y-2 py-3 first:pt-0 last:pb-0"><div className="flex items-start justify-between gap-3"><p className="break-words text-sm font-medium">{queue.label}</p><Badge variant="outline" className="shrink-0 font-mono tabular-nums">{queue.total} buyurtma</Badge></div><p className="text-xs text-muted-foreground">Navbatda: <span className="font-mono tabular-nums text-foreground">{dashboardCount(queue.waiting, true, queue.unknown > 0)}</span> · Jarayonda: <span className="font-mono tabular-nums text-foreground">{dashboardCount(queue.running, true, queue.unknown > 0)}</span>{queue.unknown > 0 && ` · ${queue.unknown} holat noma’lum`}</p>{onSelectOrder && queue.firstOrderId && <Button variant="ghost" size="sm" className="h-auto max-w-full justify-start whitespace-normal px-0 text-left text-xs" onClick={() => onSelectOrder(queue.firstOrderId)}>{orders.find(order => order.id === queue.firstOrderId)?.saved.map.order_number ? `#${String(orders.find(order => order.id === queue.firstOrderId)!.saved.map.order_number)}` : queue.firstOrderId}<ArrowUpRight className="size-3 shrink-0" /></Button>}</li>)}</ul> : <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{queuesAvailable ? 'Uskunalarning ko‘rinadigan navbatida buyurtma yo‘q.' : 'Joriy navbat qamrovi olinmagan.'}</p>}
        <p className="mt-5 border-t pt-3 text-xs leading-5 text-muted-foreground">Navbat soni ishga kirish vaqtini ko‘rsatmaydi. Kutish davomiyligi uchun navbatga kirish hodisasi talab qilinadi.</p>
      </CardContent></Card>
    </div>
  </div>
}

function OverviewMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Card size="sm"><CardHeader className="gap-2"><CardDescription className="text-xs">{label}</CardDescription><CardTitle className="font-mono text-2xl! tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-xs leading-5 text-muted-foreground">{detail}</CardContent></Card>
}
