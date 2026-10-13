import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Boxes, ClipboardList, Factory, Layers3, RefreshCw, Warehouse, Waypoints } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatNumber, isRecord, text } from '@/lib/api'
import type { ProductionSnapshot, Row, SavedMap } from '@/lib/api-types'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { modules } from '@/lib/navigation'
import { display } from '@/lib/presentation'
import { useSession } from '@/lib/session'

const activeStates = new Set(['in_progress', 'running', 'processing', 'print_preflight'])
const pendingStates = new Set(['pending', 'queued', 'waiting', 'waiting_wip', 'not_started', 'ready', 'waiting_next_stage'])
const statusLabels: Record<string, string> = {
  in_progress: 'Jarayonda', running: 'Jarayonda', processing: 'Jarayonda',
  pending: 'Kutilmoqda', queued: 'Navbatda', waiting: 'Kutilmoqda',
  paused: 'To‘xtatilgan', frozen: 'Muzlatilgan', open: 'Ochiq', idle: 'Ish boshlanmagan',
  print_preflight: 'Bosma tekshiruvi', print_preflight_passed: 'Bosmaga tayyor',
  production_completed: 'Tugallangan', completed: 'Tugallangan', closed: 'Yopilgan',
  waiting_wip: 'WIP kutilmoqda', wip_ready: 'WIP tayyor', wip_waiting: 'WIP kutilmoqda',
  requeued_ready: 'Ishga tayyor', requeued_waiting: 'Navbatda',
  not_started: 'Boshlanmagan', ready: 'Ishga tayyor', waiting_next_stage: 'Keyingi bosqich kutilmoqda', partially_completed: 'Qisman tugallangan',
}

function orderStatus(snapshot: ProductionSnapshot, order: SavedMap): string {
  const status = snapshot.order_statuses[String(order.map.id)]
  return status ? text(status.order_status || status.work_status || status.lifecycle_status, '') : ''
}

function currentStage(snapshot: ProductionSnapshot, order: SavedMap): string {
  const states = snapshot.stage_states[String(order.map.id)]
  if (!states || !Array.isArray(order.map.nodes)) return '—'
  const nodes = order.map.nodes.filter(isRecord).filter((node) => node.kind === 'apparatus')
  const running = nodes.find((node) => activeStates.has(states[String(node.id)] ?? '') || ['paused', 'frozen'].includes(states[String(node.id)] ?? ''))
  if (running) return text(running.title)
  const pending = nodes.find((node) => pendingStates.has(states[String(node.id)] ?? ''))
  if (pending) return text(pending.title)
  return nodes.length > 0 && nodes.every((node) => states[String(node.id)] === 'completed') ? 'Tugallangan' : '—'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Serverdan ma’lumotni olib bo‘lmadi.'
}

const quickLinks = [
  { id: 'orders', title: 'Buyurtmalar', description: 'Mijoz, reja va ish holati', icon: ClipboardList },
  { id: 'maps', title: 'Ish xaritalari', description: 'Operatsiyalar va bosqichlar', icon: Waypoints },
  { id: 'wip', title: 'Yarim tayyor mahsulotlar', description: 'Rulonlar va ishlab chiqarish partiyalari', icon: Layers3 },
  { id: 'warehouses', title: 'Omborlar', description: 'Qoldiqlar va mas’ul foydalanuvchilar', icon: Warehouse },
]

export function DashboardPage() {
  const { client, demo, scope, connection } = useSession()
  const production = useQuery({
    queryKey: [scope, 'production-snapshot'],
    queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal),
    enabled: demo || Boolean(client), staleTime: 15_000,
  })
  const warehouseQuery = useQuery({
    queryKey: [scope, 'dashboard-warehouses'],
    queryFn: ({ signal }) => demo ? Promise.resolve(getDemoPage('warehouses')) : client!.list('warehouses', { limit: 500 }, signal),
    enabled: demo || Boolean(client), staleTime: 60_000,
  })

  const snapshot = production.data
  const orders = snapshot?.maps ?? []
  const statusRows = orders.map((order) => snapshot?.order_statuses[String(order.map.id)]).filter((row): row is Row => Boolean(row))
  const runningCount = statusRows.filter((row) => activeStates.has(String(row.work_status || row.order_status || ''))).length
  const pendingCount = statusRows.filter((row) => pendingStates.has(String(row.work_status || row.order_status || ''))).length
  const refreshing = production.isFetching || warehouseQuery.isFetching
  const stale = production.isError || warehouseQuery.isError || connection === 'offline'
  const updatedAt = Math.max(production.dataUpdatedAt, warehouseQuery.dataUpdatedAt)
  const stats = [
    { title: 'Yuklangan buyurtmalar', value: snapshot ? formatNumber(orders.length) : '—', detail: 'Joriy ro‘yxatdagi buyurtmalar', icon: ClipboardList, to: 'orders' },
    { title: 'Jarayondagi buyurtmalar', value: snapshot && (!orders.length || statusRows.length) ? formatNumber(runningCount) : '—', detail: 'Serverdagi ish holati bo‘yicha', icon: Factory, to: 'orders' },
    { title: 'Kutilayotgan buyurtmalar', value: snapshot && (!orders.length || statusRows.length) ? formatNumber(pendingCount) : '—', detail: 'Boshlanishi yoki keyingi bosqich kutilmoqda', icon: Layers3, to: 'maps' },
    { title: 'Yuklangan omborlar', value: warehouseQuery.data ? formatNumber(warehouseQuery.data.items.length) : '—', detail: warehouseQuery.data?.hasMore || warehouseQuery.data?.bounded ? 'Yuklangan qism, jami emas' : 'Serverdan kelgan omborlar', icon: Warehouse, to: 'warehouses' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Ish maydoni</h1>
          <p className="text-sm text-muted-foreground">Ishlab chiqarish, ombor va administrator uchun tezkor kirish.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={refreshing} onClick={() => { void production.refetch(); void warehouseQuery.refetch() }}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            Yangilash
          </Button>
          <Button asChild><Link to="/app/orders"><ClipboardList />Buyurtmalar</Link></Button>
        </div>
      </div>

      {stale && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{snapshot ? 'Oxirgi yuklangan ma’lumotlar ko‘rsatilmoqda' : 'Server ma’lumotlari yuklanmadi'}</CardTitle>
            <CardDescription>{connection === 'offline' ? 'Ulanish vaqtincha uzilgan. Ma’lumotlarni yangilash uchun ulanishni tekshiring.' : errorMessage(production.error ?? warehouseQuery.error)}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} size="sm">
            <CardHeader>
              <CardDescription>{stat.title}</CardDescription>
              <CardAction><stat.icon className="size-4 text-muted-foreground" /></CardAction>
              <CardTitle className="text-3xl tabular-nums">{production.isLoading && stat.to !== 'warehouses' || warehouseQuery.isLoading && stat.to === 'warehouses' ? '…' : stat.value}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{stat.detail}</span>
              <Button size="icon-xs" variant="ghost" asChild><Link to={`/app/${stat.to}`} aria-label={`${stat.title} bo‘limini ochish`}><ArrowRight /></Link></Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle>Ishdagi buyurtmalar</CardTitle>
            <CardDescription>Joriy ro‘yxatdagi {Math.min(orders.length, 6)} ta buyurtma. Bosqichlar ERP serveridan olinadi.</CardDescription>
            <CardAction><Button variant="outline" size="sm" asChild><Link to="/app/orders">Barchasi<ArrowRight /></Link></Button></CardAction>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Buyurtma / mahsulot</TableHead>
                  <TableHead>Mijoz</TableHead>
                  <TableHead>Bosqich</TableHead>
                  <TableHead className="text-right">Reja, kg</TableHead>
                  <TableHead>Holati</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {production.isLoading ? (
                  <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">Buyurtmalar yuklanmoqda…</TableCell></TableRow>
                ) : snapshot && orders.length ? orders.slice(0, 6).map((order) => {
                  const status = orderStatus(snapshot, order)
                  return (
                    <TableRow key={String(order.map.id)}>
                      <TableCell>
                        <Link to={`/app/orders?selected=${encodeURIComponent(String(order.map.id))}`} className="font-medium hover:underline">{text(order.map.order_number || order.map.code || order.map.id)}</Link>
                        <p className="mt-1 max-w-60 truncate text-xs text-muted-foreground" title={text(order.map.title)}>{text(order.map.title)}</p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{text(snapshot.order_customers[String(order.map.id)] || order.map.customer_name)}</TableCell>
                      <TableCell>{currentStage(snapshot, order)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(order.map.order_kg)}</TableCell>
                      <TableCell><Badge variant={activeStates.has(status) ? 'default' : status === 'paused' || status === 'frozen' ? 'outline' : 'secondary'}>{statusLabels[status] ?? display(status)}</Badge></TableCell>
                    </TableRow>
                  )
                }) : (
                  <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">{production.isError ? errorMessage(production.error) : 'Hozircha buyurtmalar yo‘q.'}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tezkor kirish</CardTitle>
            <CardDescription>Kundalik ishlar uchun asosiy bo‘limlar.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {quickLinks.map((link) => (
              <Link key={link.id} to={`/app/${link.id}`} className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-muted">
                <link.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{link.title}</span>
                  <span className="block text-xs text-muted-foreground">{link.description}</span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold">Bo‘limlar</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {modules.map((module) => (
            <Card key={module.id} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><module.icon className="size-4 text-muted-foreground" />{module.title}</CardTitle>
                <CardDescription>{module.description}</CardDescription>
                <CardAction><Button size="icon-xs" variant="ghost" asChild><Link to={`/app/${module.id}`} aria-label={`${module.title} bo‘limini ochish`}><ArrowRight /></Link></Button></CardAction>
              </CardHeader>
              <CardContent className="space-y-2">
                {module.groups.flatMap((group) => group.pages).slice(0, 4).map((page) => (
                  <Link key={page.id} to={`/app/${page.id}`} className="flex items-center justify-between gap-2 text-sm text-muted-foreground hover:text-foreground">
                    {page.title}<ArrowRight className="size-3" />
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Boxes className="size-3.5" />MES va ombor ish maydoni</span>
        <span>{demo ? 'Ko‘rish rejimi · namunaviy ma’lumotlar' : updatedAt ? `Oxirgi yuklash: ${new Date(updatedAt).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })}` : 'Server ma’lumotlari kutilmoqda'}</span>
      </div>
    </div>
  )
}
