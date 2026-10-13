import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, Clock3, RefreshCw } from 'lucide-react'
import { ManufacturingTimeOverview } from '@/components/manufacturing-time-overview'
import { ManufacturingTimeTimeline } from '@/components/manufacturing-time-timeline'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { text } from '@/lib/api'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { readManufacturingBatches, readManufacturingClosed, readManufacturingMap, readManufacturingReport } from '@/lib/manufacturing-data'
import { buildManufacturingTimeline, manufacturingTimeLabel, manufacturingTimeZone } from '@/lib/manufacturing-time'
import { useSession } from '@/lib/session'

const message = (error: unknown) => error instanceof Error ? error.message : 'Tarixni yuklab bo‘lmadi.'

export function ManufacturingTimePage() {
  const { scope } = useSession()
  return <ManufacturingTimeContent key={scope} />
}

function ManufacturingTimeContent() {
  const { client, demo, scope, connection } = useSession()
  const [params, setParams] = useSearchParams()
  const orderId = params.get('orderId')?.trim() ?? '', batchId = params.get('batchId')?.trim() ?? ''
  const production = useQuery({ queryKey: [scope, 'production-snapshot'], queryFn: ({ signal }) => demo ? demoProductionSnapshot : client!.productionSnapshot(signal), enabled: demo || Boolean(client), refetchInterval: 30_000, retry: false })
  const closed = useQuery({ queryKey: ['manufacturing-closed', scope], queryFn: ({ signal }) => demo ? getDemoPage('closed', { limit: 200 }).items : readManufacturingClosed(client!, signal), enabled: demo || Boolean(client), retry: false, staleTime: 30_000 })
  const batches = useQuery({ queryKey: ['manufacturing-batches', scope, orderId], queryFn: ({ signal }) => readManufacturingBatches(client!, orderId, signal), enabled: !demo && Boolean(client && orderId), retry: false, staleTime: 15_000 })
  const savedMap = production.data?.maps.find(saved => saved.map.id === orderId)?.map
  const map = useQuery({ queryKey: ['manufacturing-map', scope, orderId], queryFn: ({ signal }) => readManufacturingMap(client!, orderId, signal), enabled: !demo && Boolean(client && orderId && !savedMap), retry: false, staleTime: 30_000 })
  const selectedBatch = batches.data?.find(batch => batch.batch_id === batchId)
  const report = useQuery({ queryKey: ['manufacturing-report', scope, orderId, batchId], queryFn: ({ signal }) => readManufacturingReport(client!, orderId, batchId, signal), enabled: !demo && Boolean(client && orderId && selectedBatch), retry: false, staleTime: 15_000 })
  const fresh = connection !== 'offline' && !production.isError && !closed.isError
  const timelines = useMemo(() => (closed.data ?? []).map(row => buildManufacturingTimeline({ orderId: text(row.order_id, ''), closedOrder: row, snapshot: production.data, asOfUnix: Math.floor(closed.dataUpdatedAt / 1000), fresh })), [closed.data, closed.dataUpdatedAt, production.data, fresh])
  const selectedClosed = closed.data?.find(row => row.order_id === orderId)
  const observedAt = selectedClosed ? closed.dataUpdatedAt : report.data ? report.dataUpdatedAt : production.dataUpdatedAt
  const timeline = orderId ? buildManufacturingTimeline({ orderId, closedOrder: selectedClosed, report: report.data, map: savedMap ?? map.data, snapshot: production.data, asOfUnix: Math.floor(observedAt / 1000), fresh: fresh && !report.isError && !map.isError }) : null
  const choices = useMemo(() => {
    const rows = new Map<string, { id: string; label: string; closed: boolean }>()
    for (const saved of production.data?.maps ?? []) {
      const id = text(saved.map.id, '')
      rows.set(id, { id, label: `№ ${text(saved.map.order_number || saved.map.code || id)} · ${text(saved.map.title, 'Buyurtma')}`, closed: false })
    }
    for (const row of closed.data ?? []) {
      const id = text(row.order_id, '')
      rows.set(id, { id, label: `№ ${text(row.order_number || id)} · ${text(row.title, 'Buyurtma')}`, closed: true })
    }
    if (orderId && !rows.has(orderId)) rows.set(orderId, { id: orderId, label: orderId, closed: false })
    return [...rows.values()]
  }, [production.data, closed.data, orderId])
  function selectOrder(id: string) {
    const next = new URLSearchParams(params)
    next.set('orderId', id); next.delete('batchId'); setParams(next)
  }
  const queries = [production, closed, ...(orderId ? [batches, ...(savedMap ? [] : [map])] : []), ...(selectedBatch ? [report] : [])]
  const refreshing = queries.some(query => query.isFetching)
  const timeZone = manufacturingTimeZone()

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Ishlab chiqarish vaqti</h1>{demo && <Badge variant="outline">Namunaviy ma’lumotlar</Badge>}</div><p className="max-w-3xl text-sm text-muted-foreground">Qayd etilgan bosqichlar, to‘xtashlar va navbatlar. Davomiylik serverdagi hodisalar doirasida ko‘rsatiladi.</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => { for (const query of queries) void query.refetch() }}><RefreshCw className={refreshing ? 'animate-spin' : undefined} />Yangilash</Button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Tarix: oxirgi eng ko‘p 200 ta yopilgan buyurtma · umumiy son API orqali olinmaydi.</span><span>Vaqt zonasi: {timeZone} · kuzatuv: {manufacturingTimeLabel(Math.floor(Math.max(closed.dataUpdatedAt, production.dataUpdatedAt) / 1000), timeZone)}</span></div>
    {(closed.error || production.error || connection === 'offline') && <Alert><AlertTitle>{connection === 'offline' ? 'Server bilan aloqa uzilgan' : 'Tarixning bir qismi yuklanmadi'}</AlertTitle><AlertDescription>{closed.error ? message(closed.error) : production.error ? message(production.error) : 'Oxirgi yuklangan ma’lumotlar ko‘rsatilmoqda.'} Saqlangan kuzatuvlar joriy vaqtgacha uzaytirilmaydi.</AlertDescription></Alert>}
    {closed.isPending && !closed.data ? <div className="grid gap-3 sm:grid-cols-3" role="status" aria-label="Vaqt tarixi yuklanmoqda"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div> : <ManufacturingTimeOverview timelines={timelines} historyAvailable={Boolean(closed.data)} snapshot={production.isError || connection === 'offline' ? undefined : production.data} onSelectOrder={selectOrder} />}
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="size-4" />Buyurtma bo‘yicha tarix</CardTitle><CardDescription>Bosqichni tekshirish uchun buyurtma tanlang. Ochiq buyurtmada faqat joriy holat va mavjud rulonning cheklangan tarixi olinadi.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-2"><Label htmlFor="manufacturing-order">Buyurtma</Label><Select value={orderId} onValueChange={selectOrder} disabled={production.isPending && closed.isPending}><SelectTrigger id="manufacturing-order" className="w-full"><SelectValue placeholder="Buyurtmani tanlang" /></SelectTrigger><SelectContent>{choices.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.label}{choice.closed ? ' · yopilgan' : ''}</SelectItem>)}</SelectContent></Select></div>
          {orderId && !demo && <div className="space-y-2"><Label htmlFor="manufacturing-batch">Rulon tarixi (ixtiyoriy)</Label><Select value={batchId || '_none'} disabled={batches.isPending || batches.isError || !batches.data?.length} onValueChange={id => { const next = new URLSearchParams(params); id === '_none' ? next.delete('batchId') : next.set('batchId', id); setParams(next) }}><SelectTrigger id="manufacturing-batch" className="w-full"><SelectValue placeholder="Rulonni tanlang" /></SelectTrigger><SelectContent><SelectItem value="_none">Faqat buyurtma holati</SelectItem>{batches.data?.map(batch => <SelectItem key={text(batch.batch_id)} value={text(batch.batch_id)}>{text(batch.barcode || batch.batch_id)} · {text(batch.apparatus, 'Apparat noma’lum')}</SelectItem>)}</SelectContent></Select></div>}
          {orderId && <Button variant="outline" asChild className="self-end"><Link to={`/app/${selectedClosed ? 'closed' : 'orders'}?selected=${encodeURIComponent(orderId)}`}>Buyurtma tafsiloti<ArrowUpRight /></Link></Button>}
        </div>
        {orderId && !demo && <p className="text-xs text-muted-foreground">Rulonlar eng ko‘p 500 ta qaytariladi; umumiy son noma’lum. Rulon hisoboti faqat uning bog‘langan tarixini ko‘rsatadi.</p>}
        {orderId && (batches.error || map.error || report.error) && <Alert variant="destructive"><AlertDescription>{message(batches.error || map.error || report.error)}</AlertDescription></Alert>}
        {orderId && batchId && batches.isSuccess && !selectedBatch && <Alert><AlertDescription>Tanlangan rulon buyurtmaning cheklangan joriy ro‘yxatida topilmadi. Boshqa rulonni tanlang yoki ma’lumotni yangilang.</AlertDescription></Alert>}
        {orderId && batches.isSuccess && !batches.data.length && <p className="text-sm text-muted-foreground">Bu buyurtma uchun ro‘yxatda rulon tarixi qaytmadi.</p>}
        {report.isFetching && selectedBatch && <p className="text-sm text-muted-foreground" role="status">Rulon tarixi yuklanmoqda…</p>}
        {timeline ? <ManufacturingTimeTimeline timeline={timeline} /> : <div className="py-8 text-center text-sm text-muted-foreground">Buyurtma tanlang yoki yuqoridagi kuzatuvdan uning tarixini oching.</div>}
      </CardContent>
    </Card>
  </div>
}
