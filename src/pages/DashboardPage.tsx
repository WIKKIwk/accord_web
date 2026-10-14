import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, CheckCheck, ClipboardList, Clock3, Factory, Layers3, RefreshCw, Search, Warehouse, Waypoints, WifiOff } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DashboardNote, DashboardSurface } from '@/components/dashboard-surface'
import { KpiCard } from '@/components/dashboardcn/kpi-card'
import { MetricValue } from '@/components/dashboardcn/metric-value'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  const offline = !demo && connection === 'offline'
  const checking = !demo && connection === 'checking'
  const transportStale = offline || checking
  const snapshot = production.data
  const orders = useMemo(() => dashboardOrders(snapshot), [snapshot])
  const counts = dashboardOrderCounts(orders)
  const queues = useMemo(() => dashboardQueues(snapshot), [snapshot])
  const statusDetail = !snapshot ? 'Holat ma’lumotlari kutilmoqda' : counts.unknown ? `${counts.total - counts.unknown} / ${counts.total} buyurtma holati ma’lum` : `${counts.total} ta yuklangan buyurtma bo‘yicha`
  const partialDetail = (bounded?: boolean) => bounded ? 'Yuklangan qism · + kamida shuncha' : 'Serverdagi joriy ro‘yxat bo‘yicha'
  const stats = [
    { title: 'Jarayondagi buyurtmalar', available: Boolean(snapshot), value: dashboardCount(counts.running, Boolean(snapshot), counts.unknown > 0), detail: statusDetail, icon: Factory, to: 'orders', loading: production.isLoading, stale: production.isError || transportStale },
    { title: 'Kutilayotgan buyurtmalar', available: Boolean(snapshot), value: dashboardCount(counts.queued, Boolean(snapshot), counts.unknown > 0), detail: statusDetail, icon: Clock3, to: 'orders', loading: production.isLoading, stale: production.isError || transportStale },
    { title: 'E’tibor kerak', available: Boolean(snapshot), value: dashboardCount(counts.attention, Boolean(snapshot), counts.unknown > 0), detail: 'To‘xtatilgan, muzlatilgan yoki muammoli ishlar', icon: AlertTriangle, to: 'orders', loading: production.isLoading, stale: production.isError || transportStale },
    { title: 'Yakunlash so‘rovlari', available: Boolean(completion.data), value: dashboardPageCount(completion.data), detail: partialDetail(completion.data?.hasMore || completion.data?.bounded), icon: CheckCheck, to: 'completion', loading: completion.isLoading, stale: completion.isError || transportStale },
    { title: 'Kutilayotgan WIP', available: Boolean(waitingWip.data), value: dashboardWipCount(waitingWip.data, 'waiting'), detail: `${waitingWip.data?.hasMore || waitingWip.data?.bounded ? 'Yuklangan qism · + kamida shuncha · ' : ''}Partiyalar soni · keyingi bosqich yoki ombor kutilmoqda`, icon: Layers3, to: 'wip?status=waiting', loading: waitingWip.isLoading, stale: waitingWip.isError || transportStale },
    { title: 'Ishdagi WIP', available: Boolean(inUseWip.data), value: dashboardWipCount(inUseWip.data, 'in_use'), detail: `${inUseWip.data?.hasMore || inUseWip.data?.bounded ? 'Yuklangan qism · + kamida shuncha · ' : ''}Partiyalar soni · keyingi bosqich qabul qilgan`, icon: Layers3, to: 'wip?status=in_use', loading: inUseWip.isLoading, stale: inUseWip.isError || transportStale },
  ]
  const metricDetail = (stat: typeof stats[number]) => !stat.available ? stat.loading ? 'Ma’lumotlar yuklanmoqda…' : stat.stale ? 'Ma’lumotlar yuklanmadi.' : 'Ma’lumotlar kutilmoqda.' : `${stat.stale ? 'Oxirgi yuklangan holat · ' : ''}${stat.detail}`
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('uz')
    return orders.filter(order => (filter === 'all' || order[filter]) && [order.saved.map.order_number, order.saved.map.code, order.saved.map.title,
      snapshot?.order_customers[order.id], order.saved.map.customer_name, order.statusLabel, order.stage].map(value => text(value, '')).join(' ').toLocaleLowerCase('uz').includes(needle))
      .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(!b.known) - Number(!a.known) || Number(b.running) - Number(a.running) || Number(b.partial) - Number(a.partial) || a.id.localeCompare(b.id))
  }, [orders, snapshot, filter, search])
  const updatedAt = production.dataUpdatedAt
  const observationLabel = !snapshot ? production.isLoading ? 'Kuzatuv yuklanmoqda' : production.isError ? 'Kuzatuv olinmagan' : 'Kuzatuv kutilmoqda' : transportStale || production.isError ? 'Oxirgi kuzatuv' : 'Joriy kuzatuv'
  const refresh = () => { for (const query of queries) void query.refetch() }
  const distribution = useMemo(() => {
    const groups = new Map<string, { status: string; label: string; count: number }>()
    for (const order of orders) { const group = groups.get(order.status) ?? { status: order.status, label: order.statusLabel, count: 0 }; group.count += 1; groups.set(order.status, group) }
    return [...groups.values()].sort((a, b) => Number(a.status === 'unknown') - Number(b.status === 'unknown') || b.count - a.count)
  }, [orders])
  const queueMaximum = Math.max(1, ...queues.map(queue => queue.total))
  const attentionOrders = orders.filter(order => order.attention)
  function inspectAttention() {
    setFilter('attention'); setSearch(''); setLimit(8)
    const table = document.getElementById('dashboard-orders'); table?.scrollIntoView({ block: 'start' }); table?.focus({ preventScroll: true })
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/65 pb-3 sm:gap-4 sm:pb-5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-[1.65rem] font-medium leading-tight tracking-[-0.035em]">Ish maydoni</h1>{demo && <Badge variant="outline" className="text-[10px]">Namunaviy ma’lumotlar</Badge>}</div>
          <p className="text-xs leading-5 text-muted-foreground">Buyurtmalar holati, apparatlar navbati va e’tibor talab qiladigan ishlar.</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
          <Button variant="outline" className="rounded-full px-2 text-[11px] [&_svg]:size-3.5 sm:px-3 sm:text-xs sm:[&_svg]:size-4" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'animate-spin' : undefined} />{refreshing ? 'Yangilanmoqda…' : offline || failed.length ? 'Qayta urinish' : 'Yangilash'}</Button>
          {canView('production-time') && <Button variant="outline" className="rounded-full px-2 text-[11px] [&_svg]:size-3.5 sm:px-3 sm:text-xs sm:[&_svg]:size-4" asChild><Link to="/app/production-time"><Clock3 />Ishlab chiqarish vaqti</Link></Button>}
          <Button className="rounded-full px-2 text-[11px] [&_svg]:size-3.5 sm:px-3 sm:text-xs sm:[&_svg]:size-4" asChild><Link to="/app/orders"><ClipboardList />Buyurtmalar</Link></Button>
        </div>
      </div>

      {(transportStale || failed.length > 0) && <Alert>{checking ? <RefreshCw className="animate-spin" /> : offline ? <WifiOff /> : <AlertTriangle />}<AlertTitle>{offline ? 'Server bilan aloqa uzilgan' : checking ? 'Server bilan aloqa tekshirilmoqda' : 'Ba’zi ma’lumotlar yangilanmadi'}</AlertTitle><AlertDescription>
        <p>{snapshot ? 'Oxirgi yuklangan ma’lumotlar ko‘rsatilmoqda.' : 'Buyurtmalar holati hozircha noma’lum.'} {offline ? 'Ulanish tiklangach ma’lumotlar yangilanadi.' : checking ? 'Aloqa tasdiqlanguncha bu avvalgi kuzatuvdir.' : failed.map(([label]) => label).join(', ') + '.'}</p>
        {!offline && failed[0] && <p>{errorMessage(failed[0][1].error)}</p>}
      </AlertDescription></Alert>}

      {snapshot && counts.unknown > 0 && <Alert><AlertTriangle /><AlertTitle>{counts.unknown} ta buyurtma holati noma’lum</AlertTitle><AlertDescription>Holat to‘liq kelmagan. + belgili ko‘rsatkichlar ma’lum buyurtmalar bo‘yicha eng kam sonni bildiradi; — aniq son yo‘qligini bildiradi.</AlertDescription></Alert>}

      <DashboardSurface aria-label="Ish maydoni kuzatuvi">
        <div className="grid grid-cols-3 border-b border-border/65 xl:grid-flow-col xl:auto-cols-fr xl:grid-cols-none">
          {stats.filter(stat => canView(stat.to.split('?')[0])).map((stat, index) => <Link key={stat.title} to={`/app/${stat.to}`} aria-label={`${stat.title} bo‘limini ochish`} aria-describedby={`dashboard-value-${index}`} className="block min-w-0 border-b border-r border-border/65 transition-colors last:border-r-0 hover:bg-muted/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring xl:border-b-0">
            <KpiCard label={stat.title} value={stat.value} valueId={`dashboard-value-${index}`} loading={stat.loading} icon={<stat.icon className="hidden shrink-0 sm:block" aria-hidden="true" />} valueClassName={`text-[1.9rem] font-medium leading-none tracking-[-0.045em] ${index === 0 ? 'sm:text-[2.75rem]' : 'sm:text-[2.1rem]'}`} className="h-full gap-2 rounded-none bg-transparent py-3 ring-0 sm:gap-3 sm:py-5 [&_[data-slot=card-header]]:px-3 [&_[data-slot=card-content]]:px-3 sm:[&_[data-slot=card-header]]:px-5 sm:[&_[data-slot=card-content]]:px-5 [&_[data-slot=card-description]]:min-h-8 [&_[data-slot=card-description]]:items-start [&_[data-slot=card-description]]:text-[11px] [&_[data-slot=card-description]]:leading-4 sm:[&_[data-slot=card-description]]:min-h-0">
            <p className="min-h-3.5 text-[10px] leading-3.5 text-muted-foreground sm:hidden">{stat.available && stat.stale ? 'Oxirgi holat' : stat.value.endsWith('+') ? 'Kamida shuncha' : stat.value === '—' ? 'Holat noma’lum' : ''}</p>
            <DashboardNote className="hidden sm:block">{metricDetail(stat)}</DashboardNote>
            </KpiCard>
          </Link>)}
        </div>
        <details className="border-b border-border/65 px-3 py-2.5 sm:hidden"><summary className="cursor-pointer text-[11px] leading-5 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Hisob qamrovi · + kamida, — noma’lum</summary><dl className="space-y-3 pb-2 pt-3">{stats.filter(stat => canView(stat.to.split('?')[0])).map(stat => <div key={stat.title}><dt className="text-[11px] font-medium">{stat.title}</dt><dd className="mt-1 text-[11px] leading-5 text-muted-foreground">{metricDetail(stat)}</dd></div>)}</dl></details>
        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
          <section aria-label="Joriy ishlab chiqarish ko‘rinishi" className="min-w-0 px-5 py-5 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-medium tracking-tight">Buyurtmalar taqsimoti</h2><p className="mt-2 text-[2.8rem] font-medium leading-none tracking-[-0.045em] tabular-nums"><MetricValue value={snapshot ? String(counts.total) : '—'} /><span className="ml-2 text-xs font-normal tracking-normal text-muted-foreground">yuklangan buyurtma</span></p></div><span className="rounded-full border border-border/65 px-2.5 py-1 text-[10px] text-muted-foreground">{observationLabel}</span></div>
            <DashboardNote className="mt-2">Har bir buyurtma bitta joriy holat guruhida ko‘rsatilgan. Yuqoridagi e’tibor va ish ko‘rsatkichlari bir buyurtmaga birga tegishli bo‘lishi mumkin.</DashboardNote>
            {production.isLoading ? <Skeleton className="mt-4 h-12" aria-label="Buyurtmalar taqsimoti yuklanmoqda" /> : distribution.length ? <>
              <div role="img" aria-label={`Yuklangan buyurtmalar holati: ${distribution.map(group => `${group.label}: ${group.count}`).join(', ')}`} className="mt-4 flex h-12 overflow-hidden rounded-xl bg-muted/35">{distribution.map((group, index) => <span key={group.status} data-status-segment={group.status} data-order-count={group.count} className={group.status === 'unknown' ? 'h-full border border-dashed border-muted-foreground/60 bg-transparent' : ['h-full border-r-2 border-card bg-foreground/75', 'h-full border-r-2 border-card bg-foreground/50', 'h-full border-r-2 border-card bg-foreground/30', 'h-full border-r-2 border-card bg-foreground/20', 'h-full border-r-2 border-card bg-foreground/10'][index % 5]} style={{ width: `${group.count / counts.total * 100}%` }} title={`${group.label}: ${group.count} buyurtma`} />)}</div>
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Yuklangan buyurtmalar holatlari">{distribution.map((group, index) => <li key={group.status} className="flex items-center gap-2 text-[11px]"><span className={group.status === 'unknown' ? 'size-2 rounded-full border border-dashed border-muted-foreground' : ['size-2 rounded-full bg-foreground/75', 'size-2 rounded-full bg-foreground/50', 'size-2 rounded-full bg-foreground/30', 'size-2 rounded-full bg-foreground/20', 'size-2 rounded-full bg-foreground/10'][index % 5]} aria-hidden="true" /><span className="text-muted-foreground">{group.label}</span><MetricValue value={String(group.count)} className="font-mono" /></li>)}</ul>
            </> : <p className="mt-4 py-6 text-xs text-muted-foreground">{snapshot ? 'Hozircha buyurtmalar yo‘q.' : 'Holat ma’lumotlari kutilmoqda.'}</p>}
            {canView('factory-map') && <section aria-label="Uskunalar navbati taqqoslanishi" className="mt-5 border-t border-border/65 pt-4"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-medium tracking-tight">Apparatlar navbati</h2><DashboardNote className="mt-1">Ko‘rinadigan buyurtmalar soni · eng ko‘p 6 ta uskuna</DashboardNote></div><Button variant="ghost" size="sm" className="h-auto px-0 text-[11px]" asChild><Link to="/app/factory-map">3D xarita<ArrowRight className="size-3" /></Link></Button></div>
              {production.isLoading ? <Skeleton className="mt-3 h-28" aria-label="Navbatlar yuklanmoqda" /> : queues.length ? <ul className="mt-3 space-y-2.5">{queues.slice(0, 6).map(queue => <li key={queue.apparatusId} className="grid grid-cols-[7rem_minmax(0,1fr)_2rem] items-center gap-x-3 sm:grid-cols-[11rem_minmax(0,1fr)_2rem]"><Link to={`/app/apparatus?selected=${encodeURIComponent(queue.apparatusId)}`} className="min-w-0 truncate text-[11px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={queue.label}>{queue.label}</Link><div role="img" aria-label={`${queue.label}: ${queue.total} ko‘rinadigan buyurtma`} className="relative h-5 overflow-hidden rounded-md bg-muted/45"><span className="absolute inset-y-0 left-0 rounded-md bg-foreground/45" style={{ width: `${queue.total / queueMaximum * 100}%` }} />{[.25, .5, .75].map(ratio => <span key={ratio} className="pointer-events-none absolute inset-y-0 border-l border-card/70" style={{ left: `${ratio * 100}%` }} aria-hidden="true" />)}</div><span className="text-right font-mono text-xs tabular-nums">{queue.total}</span><p className="col-start-2 col-end-4 mt-1 text-[10px] leading-4 text-muted-foreground">{dashboardCount(queue.running, true, queue.unknown > 0)} ishda · {dashboardCount(queue.waiting, true, queue.unknown > 0)} kutilmoqda{queue.unknown ? ` · ${queue.unknown} noma’lum` : ''} · {factoryMapStatuses[queue.firstStatus].label}</p></li>)}</ul> : <p className="py-6 text-xs text-muted-foreground">{snapshot?.visible_order_ids ? 'Hozircha faol navbat yo‘q.' : 'Navbat ma’lumotlari olinmadi.'}</p>}
              <DashboardNote className="mt-3">Bir buyurtma bir nechta uskuna navbatida bo‘lishi mumkin. Navbat soni uskuna sig‘imi yoki kutish vaqtini bildirmaydi.</DashboardNote>
            </section>}
          </section>
          <aside aria-label="E’tibor va yakunlash kuzatuvi" className="min-w-0 border-t border-border/65 bg-muted/15 px-5 py-5 sm:px-6 lg:border-l lg:border-t-0">
            <section aria-label="E’tibor talab qiladigan ishlar"><div className="flex items-start justify-between gap-3"><h2 className="text-sm font-medium tracking-tight">E’tibor kerak</h2><AlertTriangle className="size-3.5 text-muted-foreground" /></div><p className="mt-2 text-[2.3rem] font-medium leading-none tracking-[-0.04em] tabular-nums">{dashboardCount(counts.attention, Boolean(snapshot), counts.unknown > 0)}</p><DashboardNote className="mt-2">To‘xtatilgan, muzlatilgan yoki muammoli ishlar{transportStale || production.isError ? ' · Oxirgi yuklangan holat' : ''}</DashboardNote>
              {attentionOrders.length ? <ul className="mt-3 divide-y divide-border/65">{attentionOrders.slice(0, 4).map(order => <li key={order.id}><Link to={`/app/orders?selected=${encodeURIComponent(order.id)}`} className="block rounded-md py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{text(order.saved.map.order_number || order.saved.map.code || order.id)}</span><ArrowRight className="size-3 text-muted-foreground" /></div><p className="mt-1 truncate text-[11px]" title={text(order.saved.map.title)}>{text(order.saved.map.title)}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{order.attentionReason || order.statusLabel}</p></Link></li>)}</ul> : <p className="py-4 text-xs leading-5 text-muted-foreground">{!snapshot ? 'Buyurtmalar holati kutilmoqda.' : counts.unknown ? 'Ma’lum holatlarda e’tiborli ish topilmadi; noma’lum holatlar bor.' : 'E’tibor talab qiladigan ishlar yo‘q.'}</p>}
              <Button variant="outline" size="sm" className="mt-2 w-full rounded-full text-[11px]" disabled={!snapshot} onClick={inspectAttention}>Jadvalda ko‘rish<ArrowRight className="size-3" /></Button>
            </section>
            {canView('completion') && <section aria-label="Yakunlash kutilmoqda" className="mt-5 border-t border-border/65 pt-4"><div className="flex items-start justify-between gap-2"><h2 className="text-sm font-medium tracking-tight">Yakunlash kutilmoqda</h2><Badge variant="outline" className="text-[10px] tabular-nums">{dashboardPageCount(completion.data)}</Badge></div><DashboardNote className="mt-1">Operator yuborgan so‘rovlarni ko‘rib chiqing.</DashboardNote>
              <div className="mt-2 divide-y divide-border/65">{completion.isLoading ? <Skeleton className="h-16 w-full" /> : completion.data?.items.length ? completion.data.items.slice(0, 4).map(row => <Link key={text(row.event_id)} to={`/app/completion?selected=${encodeURIComponent(text(row.event_id, ''))}`} className="block rounded-md py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{text(row.order_number || row.order_id)}</span><ArrowRight className="size-3 text-muted-foreground" /></div><p className="mt-1 truncate text-[11px]">{text(row.order_title)}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{text(row.apparatus_name || row.apparatus)} · {text(row.worker_display_name)}</p></Link>) : <p className="py-3 text-xs leading-5 text-muted-foreground">{completion.isError ? 'Yakunlash so‘rovlari yuklanmadi.' : offline && !completion.data ? 'Ulanish kutilmoqda.' : 'Ko‘rib chiqiladigan so‘rov yo‘q.'}</p>}</div>
              <Button variant="outline" size="sm" className="mt-2 w-full rounded-full text-[11px]" asChild><Link to="/app/completion">So‘rovlarni ko‘rish<ArrowRight /></Link></Button>
            </section>}
          </aside>
        </div>
      </DashboardSurface>
      <DashboardSurface aria-label="Buyurtmalar holati">
          <section id="dashboard-orders" tabIndex={-1} className="min-w-0 px-5 py-6 outline-none sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-medium tracking-tight">Buyurtmalar holati</h2><DashboardNote className="mt-1">To‘xtatilgan va muammoli buyurtmalar avval ko‘rsatiladi. Bosqichlar bajarilish soni kg rejasidan alohida.</DashboardNote></div><Button variant="outline" size="sm" className="rounded-full text-[11px]" asChild><Link to="/app/orders">Buyurtmalar<ArrowRight /></Link></Button></div>
            <div className="mt-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1 rounded-full bg-muted/60 p-1" role="group" aria-label="Buyurtmalar holati bo‘yicha filtr">{filters.map(item => <Button key={item.id} size="sm" className="rounded-full px-3 text-[11px]" variant={filter === item.id ? 'secondary' : 'ghost'} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setLimit(8) }}>{item.label}</Button>)}</div>
                <div className="relative w-full sm:w-56"><Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" /><Input aria-label="Buyurtma yoki mijozni qidirish" placeholder="Buyurtma yoki mijoz…" className="rounded-full pl-8 text-xs" value={search} onChange={event => { setSearch(event.target.value); setLimit(8) }} /></div>
              </div>
              <Table aria-label="Buyurtmalar holati va ishlab chiqarish bosqichlari">
                <TableHeader><TableRow className="border-border/65"><TableHead className="h-9 text-[10px] font-normal">Buyurtma / mahsulot</TableHead><TableHead className="h-9 text-[10px] font-normal">Bosqich va bajarilish</TableHead><TableHead className="h-9 text-right text-[10px] font-normal">Reja, kg</TableHead><TableHead className="h-9 text-[10px] font-normal">Holati</TableHead></TableRow></TableHeader>
                <TableBody>
                  {production.isLoading ? <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground" role="status">Buyurtmalar yuklanmoqda…</TableCell></TableRow> : visible.length ? visible.slice(0, limit).map(order => <TableRow key={order.id} className="border-border/60">
                    <TableCell className="py-3"><Link to={`/app/orders?selected=${encodeURIComponent(order.id)}`} className="text-xs font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{text(order.saved.map.order_number || order.saved.map.code || order.id)}</Link><p className="mt-1 max-w-56 truncate text-[11px]" title={text(order.saved.map.title)}>{text(order.saved.map.title)}</p><p className="mt-1 max-w-56 truncate text-[10px] text-muted-foreground">{text(snapshot?.order_customers[order.id] || order.saved.map.customer_name)}</p></TableCell>
                    <TableCell className="min-w-40 py-3"><p className="max-w-56 text-xs">{order.stage}</p>{order.stages.total > 0 && <div className="mt-1.5 space-y-1"><p className="text-[10px] text-muted-foreground">{order.stages.completed} / {order.stages.total} bosqich tugallangan{order.stages.known < order.stages.total ? ` · ${order.stages.total - order.stages.known} ta noma’lum` : ''}</p>{order.stages.known === order.stages.total && <Progress className="h-1 max-w-48" value={order.stages.completed / order.stages.total * 100} aria-label={`${order.stages.total} bosqichdan ${order.stages.completed} tasi tugallangan`} />}</div>}</TableCell>
                    <TableCell className="py-3 text-right font-mono text-[11px] tabular-nums">{formatNumber(order.saved.map.order_kg)}</TableCell>
                    <TableCell className="py-3"><Badge className="text-[10px]" variant={order.attention ? 'outline' : order.running ? 'default' : 'secondary'}>{order.attention && <AlertTriangle className="size-3" />}{order.statusLabel}</Badge>{order.attentionReason && <p className="mt-1.5 max-w-40 text-[10px] leading-4 text-muted-foreground">{order.attentionReason}</p>}</TableCell>
                  </TableRow>) : <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground">{!snapshot ? offline ? 'Ulanish yo‘q. Buyurtmalar yuklanmadi.' : production.isError ? errorMessage(production.error) : 'Buyurtmalar holati kutilmoqda.' : orders.length ? 'Bu filtrga mos buyurtma topilmadi.' : 'Hozircha buyurtmalar yo‘q.'}{snapshot && orders.length > 0 && <Button size="sm" variant="ghost" className="ml-2" onClick={() => { setFilter('all'); setSearch(''); setLimit(8) }}>Filtrni tozalash</Button>}</TableCell></TableRow>}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] leading-5 text-muted-foreground"><span>{snapshot ? `${Math.min(limit, visible.length)} / ${visible.length} buyurtma · ${dashboardCount(counts.partial, true, counts.unknown > 0)} qisman tugallangan · ${dashboardCount(counts.completed, true, counts.unknown > 0)} tugallangan` : 'Server ma’lumotlari kutilmoqda'}</span>{visible.length > limit && <Button variant="outline" size="sm" className="rounded-full text-[11px]" onClick={() => setLimit(value => value + 8)}>Yana 8 ta ko‘rsatish</Button>}</div>
            </div>
            <nav aria-label="Tezkor kirish" className="mt-5 border-t border-border/65 pt-4"><h2 className="text-xs font-medium">Tezkor kirish</h2><DashboardNote className="mt-1">Kundalik ishlar uchun asosiy bo‘limlar.</DashboardNote><div className="mt-2 grid sm:grid-cols-2">{quickLinks.filter(link => canView(link.id)).map(link => <Link key={link.id} to={`/app/${link.id}`} className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"><link.icon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{link.title}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{link.description}{link.id === 'warehouses' && warehouseQuery.data ? ` · ${dashboardPageCount(warehouseQuery.data)} ta ombor${warehouseQuery.isError || transportStale ? ' · oxirgi yuklangan holat' : ''}` : ''}</span></span><ArrowRight className="size-3 shrink-0 text-muted-foreground" /></Link>)}</div></nav>
          </section>
      </DashboardSurface>

      <DashboardSurface aria-label="Ish bo‘limlari"><nav className="grid sm:grid-cols-2 xl:grid-cols-4">{modules.filter(module => canView(module.id)).map(module => <Link key={module.id} to={`/app/${module.id}`} aria-label={`${module.title} bo‘limini ochish`} className="flex min-w-0 items-start gap-3 border-b border-r border-border/65 px-5 py-4 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"><module.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{module.title}</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{module.description}</span></span><ArrowRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" /></Link>)}</nav></DashboardSurface>
      <p className="text-[10px] text-muted-foreground" role="status">{demo ? 'Ko‘rish rejimi · namunaviy ma’lumotlar' : updatedAt ? `Buyurtmalar yangilangan: ${new Date(updatedAt).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })} · ${transportStale ? 'aloqa tiklangach yangilanadi' : 'har 30 soniyada yangilanadi'}` : 'Server ma’lumotlari kutilmoqda'}</p>
    </div>
  )
}
