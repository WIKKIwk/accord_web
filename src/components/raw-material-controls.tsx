import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Link2Off, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import { isRecord, text } from '@/lib/api'
import type { ApiClient } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import type { MutationLease } from '@/lib/mutation-scope'
import {
  rawMaterialAssignmentIssue, rawMaterialAssignments, rawMaterialCandidateOrders, rawMaterialCandidates,
  rawMaterialDiagnostic, rawMaterialDiagnosticMessage, rawMaterialHistory, rawMaterialLookup, rawMaterialMutation,
  rawMaterialOrderId, rawMaterialPermissions, rawMaterialStockId, rawMaterialStockMatches, rawMaterialStockSnapshot,
  rawMaterialUnlinkIssue, RawMaterialMutationError, reconcileRawMaterialMutation,
} from '@/lib/raw-material-admin'
import type { RawMaterialAssignment, RawMaterialDiagnostic, RawMaterialWrite } from '@/lib/raw-material-admin'
import { useSession } from '@/lib/session'

interface ControlsProps {
  row: Row
  onSaved?: () => void
}

const statusLabels: Record<string, string> = {
  available: 'Mavjud', in_use: 'Ishlatilmoqda', consumed: 'Sarflangan', ready: 'Apparatda tayyor',
  awaiting_delivery: 'Yetkazish kutilmoqda', compatible: 'Mos', needs_cutting: 'Kesish kerak',
  width_mismatch: 'Kenglik mos emas', dimensions_missing: 'O‘lchamlar yetishmaydi', unavailable: 'Mavjud emas',
}

function quantity(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('uz-UZ', { maximumFractionDigits: 3 }) : '—'
}

function dateLabel(value: unknown): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toLocaleString('uz-UZ') : text(value)
}

function orderLabel(row: Row): string {
  const map = isRecord(row.map) ? row.map : row
  return [text(map.code ?? map.order_number, ''), text(map.title, '')].filter(Boolean).join(' · ') || rawMaterialOrderId(row)
}

function apparatusLabel(row: Row | undefined, id: string): string {
  const map = row && isRecord(row.map) ? row.map : row
  const node = Array.isArray(map?.nodes) ? map.nodes.find(value => isRecord(value) && value.apparatus_id === id) : undefined
  return isRecord(node) && typeof node.title === 'string' && node.title.trim() ? `${node.title} · ${id}` : id
}

function QueryFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return <Alert variant="destructive"><AlertDescription>{error.message}<Button type="button" size="sm" variant="outline" onClick={onRetry}>Qayta yuklash</Button></AlertDescription></Alert>
}

function Diagnostic({ value }: { value: RawMaterialDiagnostic }) {
  return <div className={`space-y-2 rounded-lg border p-3 text-sm ${value.compatible ? 'bg-muted/30' : 'border-destructive/40'}`} role="status">
    <p>{rawMaterialDiagnosticMessage(value.reason)}</p>
    {(value.order_width_mm != null || value.roll_width_mm != null) && <p className="text-xs text-muted-foreground">Buyurtma kengligi: {quantity(value.order_width_mm)} mm · Rulon kengligi: {quantity(value.roll_width_mm)} mm</p>}
    {(value.minimum_width_mm != null || value.maximum_width_mm != null) && <p className="text-xs text-muted-foreground">Ruxsat etilgan kenglik: {quantity(value.minimum_width_mm)}–{quantity(value.maximum_width_mm)} mm</p>}
  </div>
}

function AssignmentSummary({ assignment, order }: { assignment: RawMaterialAssignment; order?: Row | null }) {
  return <div className="space-y-3 rounded-lg border p-3">
    <p className="text-sm font-medium">{order ? orderLabel(order) : assignment.order_id}</p>
    <p className="break-all text-xs text-muted-foreground">Buyurtma ID: {assignment.order_id}<br />Apparat ID: {assignment.apparatus_id}</p>
    <div className="flex flex-wrap gap-2"><Badge variant="secondary">Qoldiq: {statusLabels[assignment.stock_status] ?? `Noma’lum (${assignment.stock_status || 'bo‘sh'})`}</Badge><Badge variant="outline">Ish holati: {statusLabels[assignment.execution_status] ?? `Noma’lum (${assignment.execution_status})`}</Badge></div>
    <p className="text-xs text-muted-foreground">Qabul qilingan: {quantity(assignment.received_qty)} · Sarflangan: {quantity(assignment.consumed_qty)} · Qolgan: {quantity(assignment.remaining_qty)} {text(assignment.stock_uom, '')}</p>
    <p className="text-xs text-muted-foreground">{text(assignment.assigned_by_display_name, 'Mas’ul ko‘rsatilmagan')} · {dateLabel(assignment.assigned_at)}</p>
    {assignment.reserved_order_id && <p className="text-xs text-destructive">Band buyurtma: {assignment.reserved_order_id}</p>}
  </div>
}

/** Keying the complete workflow discards drafts and late callbacks on account/stock change. */
export function RawMaterialControls({ row, onSaved }: ControlsProps) {
  const { scope } = useSession()
  return <StockAssignmentPanel key={`${scope}:${text(row.barcode, '')}:${rawMaterialStockId(row)}`} row={row} onSaved={onSaved} />
}

interface StockPanelProps extends ControlsProps {
  fixedOrderId?: string
  onBusyChange?: (busy: boolean) => void
}

function StockAssignmentPanel({ row, fixedOrderId = '', onSaved, onBusyChange }: StockPanelProps) {
  const { client, session, scope, demo } = useSession()
  const queryClient = useQueryClient()
  const permissions = rawMaterialPermissions(session)
  const barcode = text(row.barcode, '').trim()
  const [selectedOrder, setSelectedOrder] = useState(fixedOrderId)
  const [selectedApparatus, setSelectedApparatus] = useState('')
  const [action, setAction] = useState<'assign' | 'unlink' | null>(null)
  const [validation, setValidation] = useState('')
  const [uncertain, setUncertain] = useState<RawMaterialWrite | null>(null)
  const [mutations] = useState(() => new MutationScope())
  const inFlight = useRef(false)
  const currentScope = useRef(scope)
  currentScope.current = scope
  useEffect(() => () => mutations.cancelAll(), [mutations, scope])
  const connected = Boolean(client && session && !demo && barcode)
  const lookup = useQuery({
    queryKey: ['raw-material-admin', scope, 'lookup', barcode],
    queryFn: ({ signal }) => rawMaterialLookup(client!, barcode, signal),
    enabled: connected && permissions.lookup, retry: false,
  })
  const warehouse = lookup.data?.warehouse ?? text(row.warehouse, '')
  const stock = useQuery({
    queryKey: ['raw-material-admin', scope, 'stock', warehouse],
    queryFn: ({ signal }) => rawMaterialStockSnapshot(client!, warehouse, signal),
    enabled: connected && permissions.stock && Boolean(warehouse) && lookup.isSuccess, retry: false,
  })
  const currentStock = stock.data?.find(value => rawMaterialStockMatches(row, value))
  const assignment = lookup.data?.assignment
  const orders = useQuery({
    queryKey: ['raw-material-admin', scope, 'candidate-orders', barcode],
    queryFn: ({ signal }) => rawMaterialCandidateOrders(client!, barcode, signal),
    enabled: connected && permissions.candidates && lookup.isSuccess && !assignment, retry: false,
  })
  const candidate = orders.data?.find(value => value.order.map.id === selectedOrder)
  const apparatusId = candidate?.apparatus_options.includes(selectedApparatus) ? selectedApparatus : candidate?.apparatus_options.length === 1 ? candidate.apparatus_options[0] : ''
  const diagnostic = useQuery({
    queryKey: ['raw-material-admin', scope, 'diagnostic', barcode, selectedOrder, apparatusId],
    queryFn: ({ signal }) => rawMaterialDiagnostic(client!, barcode, selectedOrder, apparatusId, signal),
    enabled: connected && permissions.candidates && lookup.isSuccess && !assignment, retry: false,
  })
  const history = useQuery({
    queryKey: ['raw-material-admin', scope, 'history', warehouse, barcode],
    queryFn: ({ signal }) => rawMaterialHistory(client!, warehouse, barcode, signal),
    enabled: connected && permissions.history && Boolean(warehouse), retry: false,
  })
  const queriesBusy = lookup.isFetching || stock.isFetching
  const assignIssue = currentStock && lookup.data ? rawMaterialAssignmentIssue(currentStock, lookup.data, candidate, apparatusId, diagnostic.data) : 'Joriy rulon qoldig‘i tasdiqlanmagan.'
  const unlinkIssue = assignment && lookup.data ? rawMaterialUnlinkIssue(assignment, lookup.data) : 'Biriktirish olinmagan.'
  const assignReady = connected && permissions.assign && !queriesBusy && !lookup.isError && !stock.isError && currentStock && !orders.isFetching && !orders.isError && !diagnostic.isFetching && !diagnostic.isError && !assignIssue
  const unlinkReady = connected && permissions.assign && !queriesBusy && !lookup.isError && !stock.isError && currentStock && !unlinkIssue

  type Request = { client: ApiClient; session: Session; scope: string; lease: MutationLease; write: RawMaterialWrite }
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['raw-material-admin', scope] })
    for (const kind of ['raw-materials', 'orders']) {
      void queryClient.invalidateQueries({ queryKey: ['resource', scope, kind] })
      void queryClient.invalidateQueries({ queryKey: ['detail', scope, kind] })
    }
  }
  const mutation = useMutation({
    retry: false,
    mutationFn: (request: Request) => rawMaterialMutation(request.client, request.session, request.write, request.lease.controller.signal),
    onSuccess: (result, request) => {
      if (request.scope !== currentScope.current || !mutations.isCurrent(request.lease)) return
      queryClient.setQueryData(['raw-material-admin', scope, 'lookup', barcode], result)
      setAction(null)
      setValidation('')
      toast.success(request.write.action === 'assign' ? 'Biriktirish serverda tasdiqlandi.' : 'Biriktirish uzilgani serverda tasdiqlandi.')
      void refresh()
      onSaved?.()
    },
    onError: (error, request) => {
      if (request.scope !== currentScope.current || !mutations.isCurrent(request.lease)) return
      if (error instanceof RawMaterialMutationError && error.uncertain) setUncertain(request.write)
      else void refresh()
    },
    onSettled: (_data, _error, request) => {
      const current = request.scope === currentScope.current && mutations.isCurrent(request.lease)
      mutations.finish(request.lease)
      if (current) inFlight.current = false
    },
  })
  const reconciliation = useMutation({
    retry: false,
    mutationFn: (request: Request) => reconcileRawMaterialMutation(request.client, request.write, request.lease.controller.signal),
    onSuccess: (result, request) => {
      if (request.scope !== currentScope.current || !mutations.isCurrent(request.lease)) return
      queryClient.setQueryData(['raw-material-admin', scope, 'lookup', request.write.stock.barcode], result.lookup)
      setUncertain(null)
      setAction(null)
      mutation.reset()
      setValidation(result.state === 'confirmed' ? 'Joriy holat serverda tasdiqlandi.' : result.state === 'not-applied' ? 'Kutilgan o‘zgarish serverda ko‘rinmadi. Yangi ma’lumotni tekshirib, amalni qayta tasdiqlang.' : 'Biriktirish boshqa holatga o‘zgargan. Joriy holatni tekshiring.')
      void refresh()
      onSaved?.()
    },
    onSettled: (_data, _error, request) => {
      const current = request.scope === currentScope.current && mutations.isCurrent(request.lease)
      mutations.finish(request.lease)
      if (current) inFlight.current = false
    },
  })
  const busy = mutation.isPending || reconciliation.isPending
  useEffect(() => { onBusyChange?.(busy || Boolean(uncertain)) }, [busy, uncertain, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  function open(next: 'assign' | 'unlink') {
    if (inFlight.current || busy || uncertain || demo || !permissions.assign) return
    mutation.reset()
    reconciliation.reset()
    setValidation('')
    setAction(next)
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!client || !session || demo || !action || inFlight.current || uncertain || !permissions.assign || !currentStock) return
    if (action === 'assign' ? !assignReady : !unlinkReady) { setValidation(action === 'assign' ? assignIssue : unlinkIssue); return }
    const write: RawMaterialWrite = action === 'assign'
      ? { action, stock: { ...currentStock }, orderId: selectedOrder, apparatusId }
      : { action, stock: { ...currentStock }, orderId: assignment!.order_id, apparatusId: assignment!.apparatus_id, assignment: { ...assignment! } }
    inFlight.current = true
    onBusyChange?.(true)
    setValidation('')
    mutation.mutate({ client, session, scope, lease: mutations.begin(), write })
  }
  function reconcile() {
    if (!client || !session || demo || !uncertain || inFlight.current) return
    inFlight.current = true
    reconciliation.mutate({ client, session, scope, lease: mutations.begin(), write: uncertain })
  }
  const rowInfo = currentStock ?? row
  const assignmentQueue = assignment && lookup.data && isRecord(lookup.data.queue_states[assignment.apparatus_id]) ? lookup.data.queue_states[assignment.apparatus_id] as Row : null
  const errors = <>
    {lookup.error && <QueryFailure error={lookup.error} onRetry={() => { void lookup.refetch() }} />}
    {stock.error && <QueryFailure error={stock.error} onRetry={() => { void stock.refetch() }} />}
    {!assignment && orders.error && <QueryFailure error={orders.error} onRetry={() => { void orders.refetch() }} />}
    {!assignment && diagnostic.error && <QueryFailure error={diagnostic.error} onRetry={() => { void diagnostic.refetch() }} />}
  </>
  return <section className="space-y-4 border-t pt-4" aria-label="Xomashyo biriktirish">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Xomashyo biriktirish</h3>{connected && permissions.lookup && <Button type="button" size="sm" variant="ghost" disabled={busy || queriesBusy} onClick={() => { void refresh() }}><RefreshCw className={queriesBusy ? 'animate-spin' : ''} />Yangilash</Button>}</div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">Shtrixkod</dt><dd className="break-all text-right font-medium">{barcode || '—'}</dd>
      <dt className="text-muted-foreground">Qoldiq ID</dt><dd className="break-all text-right">{rawMaterialStockId(rowInfo) || '—'}</dd>
      <dt className="text-muted-foreground">Ombor</dt><dd className="text-right">{warehouse || '—'}</dd>
      <dt className="text-muted-foreground">Miqdor</dt><dd className="text-right">{quantity(lookup.data?.qty ?? rowInfo.qty)} {text(lookup.data?.uom ?? rowInfo.uom, '')}</dd>
      <dt className="text-muted-foreground">Kenglik / mikron</dt><dd className="text-right">{quantity(rowInfo.width_mm)} mm / {quantity(rowInfo.micron)} µm</dd>
      {lookup.data && <><dt className="text-muted-foreground">Qoldiq holati</dt><dd className="text-right">{statusLabels[lookup.data.status] ?? `Noma’lum (${lookup.data.status})`}</dd></>}
    </dl>
    {demo ? <p className="text-sm text-muted-foreground">Ko‘rish rejimida biriktirish bajarilmaydi. Joriy holat uchun real ERP sessiyasiga kiring.</p>
      : !barcode ? <Alert variant="destructive"><AlertDescription>Rulon shtrixkodi topilmadi.</AlertDescription></Alert>
      : !permissions.lookup ? <p className="text-sm text-muted-foreground">Biriktirish holatini o‘qish uchun ruxsat berilmagan.</p>
      : !client || !session ? <p className="text-sm text-muted-foreground">Joriy sessiyaga qayta kiring.</p>
      : <>
        {errors}
        {(lookup.isPending || stock.isFetching) && <Skeleton className="h-16 w-full" />}
        {lookup.isSuccess && stock.isSuccess && !currentStock && <Alert variant="destructive"><AlertDescription>Tanlangan rulon omborning eng ko‘p 500 ta qoldiq yozuvida tasdiqlanmadi. Amalni bajarish uchun joriy qoldiqni yangilang.</AlertDescription></Alert>}
        {assignment ? <>
          <AssignmentSummary assignment={assignment} order={lookup.data?.order} />
          {fixedOrderId && assignment.order_id !== fixedOrderId && <p className="text-sm text-destructive">Rulon boshqa buyurtmaga biriktirilgan.</p>}
          {assignmentQueue && <p className="text-xs text-muted-foreground">Apparat navbati: {text(assignmentQueue[assignment.order_id])}</p>}
          {unlinkIssue && permissions.assign && <p className="text-xs text-muted-foreground">{unlinkIssue}</p>}
          {permissions.assign && (!fixedOrderId || fixedOrderId === assignment.order_id) && <Button type="button" variant="outline" disabled={!unlinkReady || busy || Boolean(uncertain)} onClick={() => open('unlink')}><Link2Off />Biriktirishni uzish</Button>}
        </> : lookup.isSuccess && <>
          <p className="text-sm text-muted-foreground">Rulon buyurtmaga biriktirilmagan.</p>
          {diagnostic.data && <Diagnostic value={diagnostic.data} />}
          {orders.isSuccess && (!orders.data.length || (fixedOrderId && !orders.data.some(value => value.order.map.id === fixedOrderId))) && <p className="text-sm text-muted-foreground">{fixedOrderId ? 'Bu buyurtma uchun mos, faol biriktirish topilmadi.' : 'Server mos faol buyurtma qaytarmadi.'}</p>}
          {permissions.assign && <Button type="button" variant="outline" disabled={busy || Boolean(uncertain) || queriesBusy || lookup.isError || stock.isError || !currentStock || orders.isFetching || orders.isError || !orders.data?.some(value => !fixedOrderId || value.order.map.id === fixedOrderId)} onClick={() => open('assign')}><Link2 />Buyurtmaga biriktirish</Button>}
        </>}
        {!permissions.assign && <p className="text-xs text-muted-foreground">Biriktirishni o‘zgartirish uchun raw_material.assign ruxsati talab qilinadi.</p>}
      </>}
    {validation && <p className="text-sm" role="status">{validation}</p>}
    {uncertain && <Alert variant="destructive"><AlertDescription>Amal natijasi aniqlanmagan. {uncertain.stock.barcode} uchun yangi amal holat tekshirilguncha yopiq.<Button type="button" size="sm" variant="outline" disabled={busy || demo} onClick={reconcile}>{reconciliation.isPending && <Loader2 className="animate-spin" />}Server holatini tekshirish</Button>{reconciliation.error && <span>{reconciliation.error.message}</span>}</AlertDescription></Alert>}
    {mutation.error && !uncertain && <Alert variant="destructive"><AlertDescription>{mutation.error.message}</AlertDescription></Alert>}
    {!demo && permissions.history && warehouse && <div className="space-y-2">
      <h4 className="text-sm font-medium">Rulon tarixi</h4>
      <p className="text-xs text-muted-foreground">Omborning so‘nggi 200 hodisasidan shu shtrixkod bo‘yicha tanlandi. To‘liq tarix yoki umumiy son emas.</p>
      {history.error && <QueryFailure error={history.error} onRetry={() => { void history.refetch() }} />}
      {history.isPending && <Skeleton className="h-12 w-full" />}
      {history.isSuccess && (history.data.length ? <ul className="divide-y rounded-lg border">{history.data.map(event => <li className="space-y-1 p-3 text-xs" key={text(event.event_id)}><p className="font-medium">{text(event.event_type)} · {quantity(event.qty_delta)} {text(event.uom, '')}</p><p className="text-muted-foreground">{dateLabel(event.occurred_at_unix)} · {text(event.actor_display_name)}</p><p className="text-muted-foreground">{text(event.stock_status_before)} → {text(event.stock_status_after)}{event.order_id ? ` · ${text(event.order_id)}` : ''}</p></li>)}</ul> : <p className="text-xs text-muted-foreground">Bu cheklangan tarixda rulon hodisasi topilmadi.</p>)}
    </div>}
    <Dialog open={Boolean(action)} onOpenChange={openValue => { if (!openValue && !inFlight.current && !busy) setAction(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{action === 'unlink' ? 'Biriktirishni uzish' : 'Xomashyoni buyurtmaga biriktirish'}</DialogTitle><DialogDescription>{barcode} · {rawMaterialStockId(rowInfo)}. {action === 'unlink' ? 'Joriy biriktirishni uzishni tasdiqlang.' : 'Mos faol buyurtma va apparatni tanlang. Server saqlashdan oldin moslikni yana tekshiradi.'}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {action === 'assign' && <>
            {fixedOrderId ? <p className="text-sm font-medium">{candidate ? orderLabel(candidate.order) : fixedOrderId}</p> : <div className="space-y-2"><Label htmlFor={`raw-order-${barcode}`}>Mos buyurtma</Label><Select value={selectedOrder} disabled={busy || Boolean(uncertain) || orders.isFetching || orders.isError} onValueChange={value => { setSelectedOrder(value); setSelectedApparatus(''); setValidation('') }}><SelectTrigger id={`raw-order-${barcode}`}><SelectValue placeholder="Buyurtmani tanlang" /></SelectTrigger><SelectContent>{orders.data?.map(value => <SelectItem value={value.order.map.id} key={value.order.map.id}>{orderLabel(value.order)}</SelectItem>)}</SelectContent></Select></div>}
            <div className="space-y-2"><Label htmlFor={`raw-apparatus-${barcode}`}>Mos apparat</Label><Select value={apparatusId} disabled={busy || Boolean(uncertain) || !candidate || orders.isFetching || orders.isError} onValueChange={value => { setSelectedApparatus(value); setValidation('') }}><SelectTrigger id={`raw-apparatus-${barcode}`}><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{candidate?.apparatus_options.map(id => <SelectItem key={id} value={id}>{apparatusLabel(candidate.order, id)}</SelectItem>)}</SelectContent></Select></div>
            {diagnostic.isFetching && <Skeleton className="h-12 w-full" />}
            {diagnostic.data && <Diagnostic value={diagnostic.data} />}
            {assignIssue && <p className="text-xs text-muted-foreground">{assignIssue}</p>}
          </>}
          {action === 'unlink' && assignment && <><AssignmentSummary assignment={assignment} order={lookup.data?.order} />{unlinkIssue && <p className="text-sm text-destructive">{unlinkIssue}</p>}</>}
          {errors}
          {mutation.error && <Alert variant="destructive"><AlertDescription>{mutation.error.message}</AlertDescription></Alert>}
          {uncertain && <Button type="button" variant="outline" disabled={busy} onClick={reconcile}>Server holatini tekshirish</Button>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setAction(null)}>Yopish</Button><Button type="submit" disabled={busy || demo || Boolean(uncertain) || (action === 'assign' ? !assignReady : !unlinkReady)}>{mutation.isPending && <Loader2 className="animate-spin" />}Tasdiqlash</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>
}

/** The native assignment API is order-centric, so orders can launch the same workflow. */
export function OrderRawMaterialControls({ row, onSaved }: ControlsProps) {
  const { scope } = useSession()
  return <OrderAssignmentPanel key={`${scope}:${rawMaterialOrderId(row)}`} row={row} onSaved={onSaved} />
}

function OrderAssignmentPanel({ row, onSaved }: ControlsProps) {
  const { client, session, scope, demo } = useSession()
  const permissions = rawMaterialPermissions(session)
  const orderId = rawMaterialOrderId(row)
  const [selected, setSelected] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const enabled = Boolean(client && session && !demo && orderId)
  const assignments = useQuery({
    queryKey: ['raw-material-admin', scope, 'order-assignments', orderId],
    queryFn: ({ signal }) => rawMaterialAssignments(client!, orderId, signal),
    enabled: enabled && permissions.lookup, retry: false,
  })
  const candidates = useQuery({
    queryKey: ['raw-material-admin', scope, 'order-candidates', orderId],
    queryFn: ({ signal }) => rawMaterialCandidates(client!, orderId, signal),
    enabled: enabled && permissions.candidates, retry: false,
  })
  if (!orderId) return <p className="text-sm text-destructive">Buyurtma identifikatori topilmadi.</p>
  if (demo) return <p className="text-sm text-muted-foreground">Ko‘rish rejimida xomashyo biriktirish bajarilmaydi.</p>
  if (!permissions.lookup) return <p className="text-sm text-muted-foreground">Xomashyo biriktirishlarini o‘qish uchun ruxsat berilmagan.</p>
  if (!client || !session) return <p className="text-sm text-muted-foreground">Joriy sessiyaga qayta kiring.</p>
  return <section className="space-y-4 border-t pt-4" aria-label="Buyurtma xomashyosi">
    <h3 className="text-sm font-semibold">Buyurtma xomashyosi</h3>
    {assignments.error && <QueryFailure error={assignments.error} onRetry={() => { void assignments.refetch() }} />}
    {assignments.isPending && <Skeleton className="h-16 w-full" />}
    {assignments.isSuccess && (assignments.data.length ? <ul className="space-y-2">{assignments.data.map(assignment => <li key={assignment.barcode} className="space-y-2 rounded-lg border p-3"><p className="break-all text-sm font-medium">{assignment.barcode} · {assignment.item_name}</p><p className="text-xs text-muted-foreground">{assignment.apparatus_id} · {statusLabels[assignment.execution_status] ?? `Noma’lum (${assignment.execution_status})`} · {quantity(assignment.remaining_qty)} {text(assignment.stock_uom, '')}</p><Button type="button" size="sm" variant="outline" disabled={busy || assignments.isFetching || assignments.isError} onClick={() => setSelected({ barcode: assignment.barcode, warehouse: assignment.stock_warehouse, item_code: assignment.item_code, uom: assignment.stock_uom })}>Rulon holati va biriktirish</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Server bu buyurtma uchun biriktirish qaytarmadi.</p>)}
    {permissions.candidates && <>
      {candidates.error && <QueryFailure error={candidates.error} onRetry={() => { void candidates.refetch() }} />}
      {candidates.isPending && <Skeleton className="h-10 w-full" />}
      <div className="space-y-2"><Label htmlFor={`order-raw-stock-${orderId}`}>Mos mavjud rulon</Label><Select value={text(selected?.barcode, '')} disabled={busy || candidates.isFetching || candidates.isError || !candidates.data?.length} onValueChange={value => { const candidate = candidates.data?.find(stock => stock.barcode === value); if (candidate && !busy) setSelected(candidate) }}><SelectTrigger id={`order-raw-stock-${orderId}`}><SelectValue placeholder="Shtrixkod bo‘yicha rulonni tanlang" /></SelectTrigger><SelectContent>{selected && !candidates.data?.some(stock => stock.barcode === selected.barcode) && <SelectItem value={text(selected.barcode)}>{text(selected.barcode)} · Joriy tanlov</SelectItem>}{candidates.data?.map(stock => <SelectItem value={stock.barcode} key={stock.barcode}>{stock.barcode} · {text(stock.item_name)} · {quantity(stock.qty)} {stock.uom} · {stock.warehouse}</SelectItem>)}</SelectContent></Select></div>
      {candidates.isSuccess && !candidates.data.length && <p className="text-xs text-muted-foreground">Server mos bo‘sh rulon qaytarmadi. Kenglik, material guruhi, qoldiq va buyurtma holati mos bo‘lishi kerak.</p>}
      <p className="text-xs text-muted-foreground">Mos rulonlar eng ko‘p 500 ta qoldiqdan tanlanadi; bu omborning to‘liq ro‘yxati emas.</p>
    </>}
    {selected && <StockAssignmentPanel key={`${scope}:${orderId}:${text(selected.barcode, '')}`} row={selected} fixedOrderId={orderId} onSaved={onSaved} onBusyChange={setBusy} />}
  </section>
}
