import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, CheckCheck, ClipboardList, Clock3, Factory, Layers3, RefreshCw, Search, Warehouse, Waypoints, WifiOff } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatNumber, text } from '@/lib/api'
import type { ResourceKind } from '@/lib/api-types'
import { dashboardCount, dashboardOrderCounts, dashboardOrders, dashboardPageCount, dashboardQueues, dashboardWipCount } from '@/lib/dashboard'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { factoryMapStatuses } from '@/lib/factory-map'
import { modules } from '@/lib/navigation'
import { canViewPage } from '@/lib/permissions'
import { useSession } from '@/lib/session'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Serverdan ma’lumotni olib bo‘lmadi.'
const quickLinks = [
  { id: 'orders', title: 'Buyurtmalar', description: 'Mijoz, reja va ish holati', icon: ClipboardList },
  { id: 'maps', title: 'Ish xaritalari', description: 'Operatsiyalar va bosqichlar', icon: Waypoints },
  { id: 'factory-map', title: '3D zavod xaritasi', description: 'Apparatlar va jonli navbatlar', icon: Factory },
  { id: 'warehouses', title: 'Omborlar', description: 'Qoldiqlar va mas’ul foydalanuvchilar', icon: Warehouse },
]
type OrderFilter = 'all' | 'attention' | 'running' | 'queued'
const filters: { id: OrderFilter; label: string }[] = [
  { id: 'all', label: 'Barchasi' }, { id: 'attention', label: 'E’tibor kerak' },
  { id: 'running', label: 'Jarayonda' }, { id: 'queued', label: 'Kutilmoqda' },
]

export function DashboardPage() {
  const { client, demo, scope, connection, session } = useSession()
  const [filter, setFilter] = useState<OrderFilter>('all')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(8)
  const enabled = demo || Boolean(client)
  const canView = (id: string) => demo || canViewPage(session, id)
  const production = useQuery({
    queryKey: [scope, 'production-snapshot'],
    queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal),
    enabled, staleTime: 15_000, refetchInterval: demo ? false : 30_000,
  })
  const listQuery = (kind: ResourceKind, status?: string) => ({
    queryKey: [scope, 'dashboard', kind, status ?? 'all'],
    queryFn: ({ signal }: { signal: AbortSignal }) => demo ? Promise.resolve(getDemoPage(kind, { limit: 500, status })) : client!.list(kind, { limit: 500, status }, signal),
    enabled: enabled && canView(kind), staleTime: 30_000, refetchInterval: demo ? false as const : 30_000,
  })
  const completion = useQuery(listQuery('completion'))
  const waitingWip = useQuery(listQuery('wip', 'waiting'))
  const inUseWip = useQuery(listQuery('wip', 'in_use'))
  const warehouseQuery = useQuery({ ...listQuery('warehouses'), staleTime: 60_000, refetchInterval: false })
  const queries = [production, ...(canView('completion') ? [completion] : []), ...(canView('wip') ? [waitingWip, inUseWip] : []), ...(canView('warehouses') ? [warehouseQuery] : [])]
  const refreshing = queries.some(query => query.isFetching)
  const errors = [
    ['Buyurtmalar', production], ['Yakunlash so‘rovlari', completion], ['Kutilayotgan WIP', waitingWip],
    ['Ishdagi WIP', inUseWip], ['Omborlar', warehouseQuery],
  ] as const
  const failed = errors.filter(([, query]) => query.isError)
  const offline = connection === 'offline'
  const snapshot = production.data
  const orders = useMemo(() => dashboardOrders(snapshot), [snapshot])
  const counts = dashboardOrderCounts(orders)
  const queues = useMemo(() => dashboardQueues(snapshot), [snapshot])
  const statusDetail = !snapshot ? 'Holat ma’lumotlari kutilmoqda' : counts.unknown ? `${counts.total - counts.unknown} / ${counts.total} buyurtma holati ma’lum` : `${counts.total} ta yuklangan buyurtma bo‘yicha`
  const partialDetail = (bounded?: boolean) => bounded ? 'Yuklangan qism · + kamida shuncha' : 'Serverdagi joriy ro‘yxat bo‘yicha'
  const stats = [
    { title: 'Jarayondagi buyurtmalar', value: dashboardCount(counts.running, Boolean(snapshot), counts.unknown > 0), detail: statusDetail, icon: Factory, to: 'orders', loading: production.isLoading, stale: production.isError },
    { title: 'Kutilayotgan buyurtmalar', value: dashboardCount(counts.queued, Boolean(snapshot), counts.unknown > 0), detail: statusDetail, icon: Clock3, to: 'orders', loading: production.isLoading, stale: production.isError },
    { title: 'E’tibor kerak', value: dashboardCount(counts.attention, Boolean(snapshot), counts.unknown > 0), detail: 'To‘xtatilgan, muzlatilgan yoki muammoli ishlar', icon: AlertTriangle, to: 'orders', loading: production.isLoading, stale: production.isError },
    { title: 'Yakunlash so‘rovlari', value: dashboardPageCount(completion.data), detail: partialDetail(completion.data?.hasMore || completion.data?.bounded), icon: CheckCheck, to: 'completion', loading: completion.isLoading, stale: completion.isError },
    { title: 'Kutilayotgan WIP', value: dashboardWipCount(waitingWip.data, 'waiting'), detail: 'Partiyalar soni · keyingi bosqich yoki ombor kutilmoqda', icon: Layers3, to: 'wip?status=waiting', loading: waitingWip.isLoading, stale: waitingWip.isError },
    { title: 'Ishdagi WIP', value: dashboardWipCount(inUseWip.data, 'in_use'), detail: 'Partiyalar soni · keyingi bosqich qabul qilgan', icon: Layers3, to: 'wip?status=in_use', loading: inUseWip.isLoading, stale: inUseWip.isError },
  ]
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('uz')
    return orders.filter(order => (filter === 'all' || order[filter]) && [order.saved.map.order_number, order.saved.map.code, order.saved.map.title,
      snapshot?.order_customers[order.id], order.saved.map.customer_name, order.statusLabel, order.stage].map(value => text(value, '')).join(' ').toLocaleLowerCase('uz').includes(needle))
      .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(!b.known) - Number(!a.known) || Number(b.running) - Number(a.running) || Number(b.partial) - Number(a.partial) || a.id.localeCompare(b.id))
  }, [orders, snapshot, filter, search])
  const updatedAt = production.dataUpdatedAt
  const refresh = () => { for (const query of queries) void query.refetch() }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Ish maydoni</h1>{demo && <Badge variant="outline">Namunaviy ma’lumotlar</Badge>}</div>
          <p className="text-sm text-muted-foreground">Buyurtmalar holati, apparatlar navbati va e’tibor talab qiladigan ishlar.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'animate-spin' : undefined} />{refreshing ? 'Yangilanmoqda…' : offline || failed.length ? 'Qayta urinish' : 'Yangilash'}</Button>
          <Button asChild><Link to="/app/orders"><ClipboardList />Buyurtmalar</Link></Button>
        </div>
      </div>

      {(offline || failed.length > 0) && <Alert><WifiOff /><AlertTitle>{offline ? 'Server bilan aloqa uzilgan' : 'Ba’zi ma’lumotlar yangilanmadi'}</AlertTitle><AlertDescription>
        <p>{snapshot ? 'Oxirgi yuklangan ma’lumotlar ko‘rsatilmoqda.' : 'Buyurtmalar holati hozircha noma’lum.'} {offline ? 'Ulanish tiklangach ma’lumotlar yangilanadi.' : failed.map(([label]) => label).join(', ') + '.'}</p>
        {!offline && failed[0] && <p>{errorMessage(failed[0][1].error)}</p>}
      </AlertDescription></Alert>}

      {snapshot && counts.unknown > 0 && <Alert><AlertTriangle /><AlertTitle>{counts.unknown} ta buyurtma holati noma’lum</AlertTitle><AlertDescription>Holat to‘liq kelmagan. + belgili ko‘rsatkichlar ma’lum buyurtmalar bo‘yicha eng kam sonni bildiradi; — aniq son yo‘qligini bildiradi.</AlertDescription></Alert>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {stats.filter(stat => canView(stat.to.split('?')[0])).map(stat => <Card key={stat.title} size="sm">
          <CardHeader>
            <CardDescription>{stat.title}</CardDescription><CardAction><stat.icon className="size-4 text-muted-foreground" /></CardAction>
            {stat.loading ? <Skeleton className="h-9 w-16" aria-label={`${stat.title} yuklanmoqda`} /> : <CardTitle className="text-3xl! tabular-nums">{stat.value}</CardTitle>}
          </CardHeader>
          <CardContent className="flex items-end justify-between gap-2 text-xs text-muted-foreground"><span>{stat.stale || offline ? 'Oxirgi yuklangan holat · ' : ''}{stat.detail}</span><Button size="icon-xs" variant="ghost" asChild><Link to={`/app/${stat.to}`} aria-label={`${stat.title} bo‘limini ochish`}><ArrowRight /></Link></Button></CardContent>
        </Card>)}
      </div>

      <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Buyurtmalar holati</CardTitle><CardDescription>To‘xtatilgan va muammoli buyurtmalar avval ko‘rsatiladi. Bosqichlar bajarilish soni kg rejasidan alohida.</CardDescription>
              <CardAction><Button variant="outline" size="sm" asChild><Link to="/app/orders">Buyurtmalar<ArrowRight /></Link></Button></CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Buyurtmalar holati bo‘yicha filtr">{filters.map(item => <Button key={item.id} size="sm" variant={filter === item.id ? 'secondary' : 'ghost'} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setLimit(8) }}>{item.label}</Button>)}</div>
                <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input aria-label="Buyurtma yoki mijozni qidirish" placeholder="Buyurtma yoki mijoz…" className="pl-9" value={search} onChange={event => { setSearch(event.target.value); setLimit(8) }} /></div>
              </div>
              <Table aria-label="Buyurtmalar holati va ishlab chiqarish bosqichlari">
                <TableHeader><TableRow><TableHead>Buyurtma / mahsulot</TableHead><TableHead>Bosqich va bajarilish</TableHead><TableHead className="text-right">Reja, kg</TableHead><TableHead>Holati</TableHead></TableRow></TableHeader>
                <TableBody>
                  {production.isLoading ? <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground" role="status">Buyurtmalar yuklanmoqda…</TableCell></TableRow> : visible.length ? visible.slice(0, limit).map(order => <TableRow key={order.id}>
                    <TableCell><Link to={`/app/orders?selected=${encodeURIComponent(order.id)}`} className="font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{text(order.saved.map.order_number || order.saved.map.code || order.id)}</Link><p className="mt-1 max-w-64 truncate text-xs" title={text(order.saved.map.title)}>{text(order.saved.map.title)}</p><p className="mt-1 max-w-64 truncate text-xs text-muted-foreground">{text(snapshot?.order_customers[order.id] || order.saved.map.customer_name)}</p></TableCell>
                    <TableCell className="min-w-44"><p className="max-w-64 text-sm">{order.stage}</p>{order.stages.total > 0 && <div className="mt-1.5 space-y-1"><p className="text-xs text-muted-foreground">{order.stages.completed} / {order.stages.total} bosqich tugallangan{order.stages.known < order.stages.total ? ` · ${order.stages.total - order.stages.known} ta noma’lum` : ''}</p>{order.stages.known === order.stages.total && <Progress className="h-1 max-w-48" value={order.stages.completed / order.stages.total * 100} aria-label={`${order.stages.total} bosqichdan ${order.stages.completed} tasi tugallangan`} />}</div>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(order.saved.map.order_kg)}</TableCell>
                    <TableCell><Badge variant={order.attention ? 'outline' : order.running ? 'default' : 'secondary'}>{order.attention && <AlertTriangle className="size-3" />}{order.statusLabel}</Badge>{order.attentionReason && <p className="mt-1.5 max-w-40 text-xs text-muted-foreground">{order.attentionReason}</p>}</TableCell>
                  </TableRow>) : <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground">{!snapshot ? offline ? 'Ulanish yo‘q. Buyurtmalar yuklanmadi.' : production.isError ? errorMessage(production.error) : 'Buyurtmalar holati kutilmoqda.' : orders.length ? 'Bu filtrga mos buyurtma topilmadi.' : 'Hozircha buyurtmalar yo‘q.'}{snapshot && orders.length > 0 && <Button size="sm" variant="ghost" className="ml-2" onClick={() => { setFilter('all'); setSearch(''); setLimit(8) }}>Filtrni tozalash</Button>}</TableCell></TableRow>}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{snapshot ? `${Math.min(limit, visible.length)} / ${visible.length} buyurtma · ${dashboardCount(counts.partial, true, counts.unknown > 0)} qisman tugallangan · ${dashboardCount(counts.completed, true, counts.unknown > 0)} tugallangan` : 'Server ma’lumotlari kutilmoqda'}</span>{visible.length > limit && <Button variant="outline" size="sm" onClick={() => setLimit(value => value + 8)}>Yana 8 ta ko‘rsatish</Button>}</div>
            </CardContent>
          </Card>

          {canView('factory-map') && <Card>
            <CardHeader><CardTitle>Apparatlar navbati</CardTitle><CardDescription>Server ko‘rsatgan faol navbatlar. Bir buyurtma bir nechta apparatda qatnashishi mumkin.</CardDescription><CardAction><Button size="sm" variant="outline" asChild><Link to="/app/factory-map">3D xarita<ArrowRight /></Link></Button></CardAction></CardHeader>
            <CardContent>
              {production.isLoading ? <p className="py-4 text-sm text-muted-foreground">Navbatlar yuklanmoqda…</p> : queues.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{queues.slice(0, 6).map(queue => <Link key={queue.apparatusId} to={`/app/apparatus?selected=${encodeURIComponent(queue.apparatusId)}`} className="space-y-2 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{queue.label}</span><Badge variant="secondary" className="tabular-nums">{queue.total}</Badge></div><p className="text-xs text-muted-foreground">{dashboardCount(queue.running, true, queue.unknown > 0)} ishda · {dashboardCount(queue.waiting, true, queue.unknown > 0)} kutilmoqda{queue.unknown ? ` · ${queue.unknown} noma’lum` : ''}</p><p className="text-xs">{factoryMapStatuses[queue.firstStatus].label}</p></Link>)}</div> : <p className="py-4 text-sm text-muted-foreground">{snapshot?.visible_order_ids ? 'Hozircha faol navbat yo‘q.' : 'Navbat ma’lumotlari olinmadi.'}</p>}
            </CardContent>
          </Card>}
        </div>

        <div className="space-y-6">
          {canView('completion') && <Card>
            <CardHeader><CardTitle>Yakunlash kutilmoqda</CardTitle><CardDescription>Operator yuborgan so‘rovlarni ko‘rib chiqing.</CardDescription><CardAction><Badge variant="secondary">{dashboardPageCount(completion.data)}</Badge></CardAction></CardHeader>
            <CardContent className="space-y-3">
              {completion.isLoading ? <Skeleton className="h-16 w-full" /> : completion.data?.items.length ? completion.data.items.slice(0, 4).map(row => <Link key={text(row.event_id)} to={`/app/completion?selected=${encodeURIComponent(text(row.event_id, ''))}`} className="block rounded-md border p-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{text(row.order_number || row.order_id)}</span><ArrowRight className="size-3.5 text-muted-foreground" /></div><p className="mt-1 truncate text-xs">{text(row.order_title)}</p><p className="mt-1 text-xs text-muted-foreground">{text(row.apparatus_name || row.apparatus)} · {text(row.worker_display_name)}</p></Link>) : <p className="py-3 text-sm text-muted-foreground">{completion.isError ? 'Yakunlash so‘rovlari yuklanmadi.' : offline && !completion.data ? 'Ulanish kutilmoqda.' : 'Ko‘rib chiqiladigan so‘rov yo‘q.'}</p>}
              <Button variant="outline" size="sm" className="w-full" asChild><Link to="/app/completion">So‘rovlarni ko‘rish<ArrowRight /></Link></Button>
            </CardContent>
          </Card>}

          <Card>
            <CardHeader><CardTitle>Tezkor kirish</CardTitle><CardDescription>Kundalik ishlar uchun asosiy bo‘limlar.</CardDescription></CardHeader>
            <CardContent className="space-y-1">{quickLinks.filter(link => canView(link.id)).map(link => <Link key={link.id} to={`/app/${link.id}`} className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><link.icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{link.title}</span><span className="block text-xs text-muted-foreground">{link.description}{link.id === 'warehouses' && warehouseQuery.data ? ` · ${dashboardPageCount(warehouseQuery.data)} ta ombor` : ''}</span></span><ArrowRight className="size-4 text-muted-foreground" /></Link>)}</CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{modules.filter(module => canView(module.id)).map(module => <Card key={module.id} size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><module.icon className="size-4 text-muted-foreground" />{module.title}</CardTitle><CardDescription>{module.description}</CardDescription><CardAction><Button size="icon-xs" variant="ghost" asChild><Link to={`/app/${module.id}`} aria-label={`${module.title} bo‘limini ochish`}><ArrowRight /></Link></Button></CardAction></CardHeader></Card>)}</div>
      <p className="text-xs text-muted-foreground" role="status">{demo ? 'Ko‘rish rejimi · namunaviy ma’lumotlar' : updatedAt ? `Buyurtmalar yangilangan: ${new Date(updatedAt).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })} · har 30 soniyada yangilanadi` : 'Server ma’lumotlari kutilmoqda'}</p>
    </div>
  )
}
