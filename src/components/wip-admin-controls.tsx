import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import { Textarea } from './ui/textarea'
import { isRecord, text } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import {
  cancelOpeningWip, createOpeningWip, isOpeningWipRow, openingWipCancelIssue, openingWipCreateCommand,
  openingWipAttempts, openingWipDestinations, openingWipDetail, openingWipIntakePreview, openingWipOrderIssue, openingWipRecords,
  openingWipSources, reconcileOpeningWipCancel, reconcileOpeningWipCreate, wipBatchDetail, wipBatchId,
  wipOrderId, wipPermissions, wipRoutePreview, WipMutationError,
} from '@/lib/wip-admin'
import type { OpeningWipAttemptLease, OpeningWipCommand, OpeningWipDetail, OpeningWipRecord, OpeningWipRollDraft } from '@/lib/wip-admin'

const statusLabels: Record<string, string> = { waiting: 'Kutilmoqda', in_use: 'Ishlatilmoqda', processed: 'Ishlov berilgan', void: 'Bekor qilingan', confirmed: 'Tasdiqlangan', cancelled: 'Bekor qilingan' }
const basisLabels: Record<string, string> = { measured: 'O‘lchangan', estimated: 'Taxminiy', unknown: 'Noma’lum' }
const emptyRoll = (): OpeningWipRollDraft => ({ basis: 'measured', metres: '', kg: '', bobinaKg: '', diameter: '' })
const message = (value: unknown) => value instanceof Error ? value.message : 'Amal bajarilmadi.'
const quantity = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('uz-UZ', { maximumFractionDigits: 3 }) : '—'
const nativeLabel = (row: Row) => { const map = isRecord(row.map) ? row.map : row; return [text(map.code ?? map.order_number, ''), text(map.title, '')].filter(Boolean).join(' · ') || wipOrderId(row) }

function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <Alert variant="destructive"><AlertDescription>{error.message}<Button type="button" size="sm" variant="outline" onClick={retry}>Qayta yuklash</Button></AlertDescription></Alert>
}
function OpeningSummary({ value }: { value: OpeningWipRecord }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm">
    <p className="font-medium">Qabul: {value.intake.intake_id}</p>
    <p className="break-all text-xs text-muted-foreground">Buyurtma: {value.intake.order_id} · Chiqish apparati: {value.intake.source_apparatus || value.intake.entry_apparatus} · Bosqich: {value.intake.resume_stage_node_id}</p>
    <Badge variant="secondary">{statusLabels[value.intake.status] ?? `Noma’lum (${value.intake.status})`}</Badge>
    <ul className="space-y-2">{value.batches.map(batch => <li className="space-y-1 border-t pt-2 text-xs" key={batch.batch_id}><p className="break-all font-medium">{batch.sequence_no}-rulon · {batch.batch_id}</p><p>{quantity(batch.finished_goods_meter)} m · {quantity(batch.finished_goods_kg)} kg · Bobina: {quantity(batch.bobina_kg)} kg{batch.diameter !== null ? ` · Diametr: ${quantity(batch.diameter)} mm` : ''}</p><p>{basisLabels[batch.quantity_basis] ?? batch.quantity_basis} · {statusLabels[batch.wip_status] ?? `Noma’lum (${batch.wip_status})`}</p></li>)}</ul>
  </div>
}

interface ToolbarProps { order?: Row; onSaved?: () => void }

/** Mount on opening-wip; pass `order` to keep registration scoped to an order detail. */
export function WipAdminToolbar({ order, onSaved }: ToolbarProps = {}) {
  const { scope } = useSession()
  openingWipAttempts.activate(scope)
  return <OpeningWipWizard key={`${scope}:${order ? wipOrderId(order) : 'all-orders'}`} fixedOrderId={order ? wipOrderId(order) : ''} onSaved={onSaved} />
}

function OpeningWipWizard({ fixedOrderId, onSaved }: { fixedOrderId: string; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession()
  const queryClient = useQueryClient()
  const permissions = wipPermissions(session)
  const context = `opening-wip:${fixedOrderId || 'all-orders'}`
  useSyncExternalStore(openingWipAttempts.subscribe, openingWipAttempts.getRevision, openingWipAttempts.getRevision)
  const stored = openingWipAttempts.get(scope, context, fixedOrderId)
  const [restored] = useState(() => stored)
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState(restored?.command.body.order_id ?? fixedOrderId)
  const [sourceNodeId, setSourceNodeId] = useState(restored?.command.body.source_stage_node_id ?? '')
  const [rolls, setRolls] = useState<OpeningWipRollDraft[]>(restored?.command.body.batches.map(batch => ({ basis: batch.quantity_basis as OpeningWipRollDraft['basis'], metres: String(batch.finished_goods_meter), kg: String(batch.finished_goods_kg), bobinaKg: String(batch.bobina_kg), diameter: batch.diameter === undefined ? '' : String(batch.diameter) })) ?? [emptyRoll()])
  const [note, setNote] = useState(restored?.command.body.note ?? '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const created = stored?.phase === 'confirmed' ? stored.result ?? null : null
  const uncertain = stored?.phase === 'uncertain' ? stored.command : null
  const registryPending = stored?.phase === 'pending'
  const [mutations] = useState(() => new MutationScope())
  const currentScope = useRef(scope)
  currentScope.current = scope
  const inFlight = useRef(false)
  const attempt = useRef<OpeningWipCommand | null>(restored?.command ?? null)
  const runningAttempt = useRef<OpeningWipAttemptLease | null>(null)
  useEffect(() => () => {
    mutations.cancelAll()
    if (runningAttempt.current) openingWipAttempts.interrupt(runningAttempt.current)
  }, [mutations])
  const enabled = Boolean(open && client && session && !demo && permissions.create)
  const snapshot = useQuery({ queryKey: [scope, 'production-snapshot'], queryFn: ({ signal }) => client!.productionSnapshot(signal), enabled, retry: false, staleTime: 5_000, refetchInterval: enabled ? 15_000 : false })
  const apparatus = useQuery({ queryKey: ['wip-admin', scope, 'apparatus'], queryFn: ({ signal }) => client!.listSnapshot('apparatus', { limit: 500 }, signal), enabled, retry: false, staleTime: 30_000 })
  const choices = snapshot.data?.maps.filter(value => (!fixedOrderId || value.map.id === fixedOrderId) && openingWipSources(snapshot.data, text(value.map.id, ''), apparatus.data?.items ?? []).length > 0) ?? []
  const sources = openingWipSources(snapshot.data, orderId, apparatus.data?.items ?? [])
  const source = sources.find(value => value.nodeId === sourceNodeId)
  const fresh = Boolean(snapshot.data && !snapshot.isError && !snapshot.isFetching && Date.now() - snapshot.dataUpdatedAt < 30_000 && apparatus.data && !apparatus.isError && !apparatus.isFetching)
  let preview: OpeningWipCommand | null = null
  if (snapshot.data && apparatus.data) {
    try { preview = openingWipCreateCommand(snapshot.data, apparatus.data.items, session, orderId, sourceNodeId, rolls, note, 'preview-only') } catch { /* Incomplete drafts cannot enable a write. */ }
  }
  const locked = pending || registryPending || Boolean(uncertain) || Boolean(created)
  const ready = !demo && client && permissions.create && fresh && preview && !locked && connection !== 'offline'

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: [scope, 'production-snapshot'] })
    void queryClient.invalidateQueries({ queryKey: ['wip-admin', scope] })
    for (const kind of ['opening-wip', 'wip', 'orders']) {
      void queryClient.invalidateQueries({ queryKey: ['resource', scope, kind] })
      void queryClient.invalidateQueries({ queryKey: ['detail', scope, kind] })
    }
  }
  function publish() {
    setError('')
    refresh()
    onSaved?.()
    toast.success('Qabul serverda tasdiqlandi.')
  }
  async function execute(command: OpeningWipCommand, readOnly = false) {
    if (!client || !session || demo || inFlight.current || !permissions.create) return
    let persistedLease: OpeningWipAttemptLease
    try { persistedLease = openingWipAttempts.begin(scope, context, command, readOnly || Boolean(uncertain)) }
    catch (caught) { setError(message(caught)); return }
    runningAttempt.current = persistedLease
    const requestClient = client, requestSession = session, requestScope = scope, lease = mutations.begin()
    const current = () => requestScope === currentScope.current && mutations.isCurrent(lease)
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const result = readOnly ? await reconcileOpeningWipCreate(requestClient, command, lease.controller.signal) : await createOpeningWip(requestClient, requestSession, command, lease.controller.signal, () => openingWipAttempts.dispatched(persistedLease))
      openingWipAttempts.finish(persistedLease, result ? { result } : { missing: true })
      if (!current()) return
      if (result) publish()
      else setError('Qabul cheklangan ro‘yxatda tasdiqlanmadi. Qayta yuborishda avvalgi amal identifikatori saqlanadi.')
    } catch (caught) {
      openingWipAttempts.finish(persistedLease, { error: message(caught), uncertain: caught instanceof WipMutationError && caught.uncertain })
      if (!current()) return
      setError(message(caught))
      refresh()
    } finally {
      const active = current()
      mutations.finish(lease)
      if (runningAttempt.current === persistedLease) runningAttempt.current = null
      if (active) { inFlight.current = false; setPending(false) }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!client || !session || demo || inFlight.current || registryPending || uncertain || created || !permissions.create) return
    if (!fresh || !snapshot.data || !apparatus.data) { setError('Joriy server holati va apparat ma’lumotlari olinmaguncha qabul bajarilmaydi.'); return }
    try {
      let command = openingWipCreateCommand(snapshot.data, apparatus.data.items, session, orderId, sourceNodeId, rolls, note, attempt.current?.body.idempotency_key ?? crypto.randomUUID())
      const sameBody = attempt.current && JSON.stringify({ ...attempt.current.body, idempotency_key: '' }) === JSON.stringify({ ...command.body, idempotency_key: '' })
      if (attempt.current && !sameBody) command = { ...command, body: { ...command.body, idempotency_key: crypto.randomUUID() } }
      attempt.current = structuredClone(command)
      void execute(attempt.current)
    } catch (caught) { setError(message(caught)) }
  }
  function resetDraft() {
    if (inFlight.current || uncertain) return
    openingWipAttempts.clear(scope, stored?.context ?? context)
    attempt.current = null
    setError('')
    setOrderId(fixedOrderId)
    setSourceNodeId('')
    setRolls([emptyRoll()])
    setNote('')
  }
  const updateRoll = (index: number, changes: Partial<OpeningWipRollDraft>) => setRolls(values => values.map((value, position) => position === index ? { ...value, ...changes } : value))
  if (!permissions.create) return <p className="text-sm text-muted-foreground">Boshlang‘ich WIP yaratish uchun ruxsat berilmagan.</p>
  return <div className="space-y-3">
    <Button type="button" variant="outline" disabled={demo || pending || registryPending || !client || connection === 'offline'} onClick={() => setOpen(true)}><Plus />Boshlang‘ich WIP qabul qilish</Button>
    {demo && <p className="text-xs text-muted-foreground">Ko‘rish rejimida qabul bajarilmaydi.</p>}
    {uncertain && !open && <Alert variant="destructive"><AlertDescription>Qabul natijasi aniqlanmagan. Avvalgi amalni tekshirish uchun qabul oynasini oching. Buyurtma: {uncertain.body.order_id} · {uncertain.body.batches.length} rulon.</AlertDescription></Alert>}
    {created && !open && <OpeningSummary value={created} />}
    <Dialog open={open} onOpenChange={value => { if (!inFlight.current && !pending) setOpen(value) }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Boshlang‘ich WIP qabul qilish</DialogTitle><DialogDescription>Buyurtmadagi haqiqiy chiqish bosqichini va har bir rulon o‘lchovlarini tasdiqlang. Rulonlar keyingi bosqichga kirish uchun ro‘yxatga olinadi.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {snapshot.error && <Failure error={snapshot.error} retry={() => { void snapshot.refetch() }} />}
          {apparatus.error && <Failure error={apparatus.error} retry={() => { void apparatus.refetch() }} />}
          {(snapshot.isPending || apparatus.isPending) && <Skeleton className="h-16 w-full" />}
          {snapshot.isSuccess && apparatus.isSuccess && !choices.length && <p className="text-sm text-muted-foreground">Qabul uchun mos faol buyurtma yoki chiqish bosqichi topilmadi. Holati noma’lum, muzlatilgan va tugallangan buyurtmalar qabul qilinmaydi.</p>}
          <div className="space-y-2"><Label htmlFor="opening-order">Buyurtma</Label>{fixedOrderId ? <p className="text-sm">{choices.find(value => value.map.id === fixedOrderId) ? nativeLabel(choices.find(value => value.map.id === fixedOrderId)!) : fixedOrderId}</p> : <Select value={orderId} disabled={locked || !fresh || !choices.length} onValueChange={value => { setOrderId(value); setSourceNodeId(''); setRolls(values => values.map(roll => ({ ...roll, diameter: '' }))); setError('') }}><SelectTrigger id="opening-order"><SelectValue placeholder="Faol buyurtmani tanlang" /></SelectTrigger><SelectContent>{choices.map(value => <SelectItem key={text(value.map.id)} value={text(value.map.id)}>{nativeLabel(value)}</SelectItem>)}</SelectContent></Select>}</div>
          <div className="space-y-2"><Label htmlFor="opening-source">Chiqish apparati / bosqich</Label><Select value={sourceNodeId} disabled={locked || !fresh || !sources.length} onValueChange={value => { setSourceNodeId(value); setRolls(values => values.map(roll => ({ ...roll, diameter: '' }))); setError('') }}><SelectTrigger id="opening-source"><SelectValue placeholder="Server xaritasidagi bosqichni tanlang" /></SelectTrigger><SelectContent>{sources.map(value => <SelectItem key={value.nodeId} value={value.nodeId}>{value.label} · {value.nodeId}</SelectItem>)}</SelectContent></Select></div>
          {source && <p className="text-xs text-muted-foreground">Chiqish ID: {source.apparatusId} · Keyingi bosqichlar: {source.next.map(value => `${value.label} (${value.apparatusId}, ${value.nodeId})`).join('; ')}</p>}
          <div className="space-y-3"><p className="text-sm font-medium">{rolls.length} ta alohida rulon</p>{rolls.map((roll, index) => <fieldset className="space-y-3 rounded-lg border p-3" key={index} disabled={locked}><legend className="px-1 text-xs font-medium">{index + 1}-rulon</legend><div className="space-y-2"><Label htmlFor={`opening-basis-${index}`}>Miqdor asosi</Label><Select value={roll.basis} disabled={locked} onValueChange={value => updateRoll(index, { basis: value as OpeningWipRollDraft['basis'] })}><SelectTrigger id={`opening-basis-${index}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="measured">O‘lchangan</SelectItem><SelectItem value="estimated">Taxminiy</SelectItem></SelectContent></Select></div><div className="grid gap-3 sm:grid-cols-2">{([['metres', 'Uzunlik, m'], ['kg', 'Tayyor mahsulot, kg'], ['bobinaKg', 'Bobina, kg'], ...(source?.operation === 'cut' ? [['diameter', 'Diametr, mm']] : [])] as [keyof OpeningWipRollDraft, string][]).map(([key, label]) => <div className="space-y-2" key={key}><Label htmlFor={`opening-${key}-${index}`}>{label}</Label><Input id={`opening-${key}-${index}`} inputMode="decimal" value={roll[key]} required disabled={locked} onChange={event => updateRoll(index, { [key]: event.target.value })} /></div>)}</div></fieldset>)}<div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={locked || rolls.length >= 500} onClick={() => setRolls(values => [...values, emptyRoll()])}><Plus />Rulon qo‘shish</Button><Button type="button" variant="outline" size="sm" disabled={locked || rolls.length <= 1} onClick={() => setRolls(values => values.slice(0, -1))}>Oxirgi rulonni olib tashlash</Button></div></div>
          <div className="space-y-2"><Label htmlFor="opening-note">Izoh</Label><Textarea id="opening-note" value={note} disabled={locked} maxLength={2000} onChange={event => setNote(event.target.value)} /></div>
          {preview && <div className="rounded-lg bg-muted p-3 text-sm">Tasdiqlash: {preview.body.batches.length} ta rulon · {quantity(preview.body.batches.reduce((sum, batch) => sum + Number(batch.finished_goods_meter), 0))} m · {quantity(preview.body.batches.reduce((sum, batch) => sum + Number(batch.finished_goods_kg), 0))} kg</div>}
          {created && <OpeningSummary value={created} />}
          {(error || stored?.error) && <Alert variant="destructive"><AlertDescription>{error || stored?.error}</AlertDescription></Alert>}
          {uncertain && <Alert variant="destructive"><AlertDescription>Yangi qabul yaratish yopiq. Buyurtma: {uncertain.body.order_id} · Chiqish: {uncertain.body.source_apparatus} / {uncertain.body.source_stage_node_id} · {uncertain.body.batches.length} rulon. Shu amal identifikatori bilan joriy holatni tekshiring yoki aynan avvalgi so‘rovni qayta yuboring.<div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={pending || registryPending} onClick={() => { void execute(uncertain, true) }}>Server holatini tekshirish</Button><Button type="button" variant="outline" disabled={pending || registryPending || connection === 'offline'} onClick={() => { void execute(uncertain) }}>Avvalgi so‘rovni qayta yuborish</Button></div></AlertDescription></Alert>}
          <p className="text-xs text-muted-foreground">Qabulni saqlash printerga buyruq yubormaydi. Apparatlar ro‘yxati eng ko‘p 500 yozuv bilan cheklangan.</p>
          <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>Yopish</Button>{created ? <Button type="button" disabled={pending || Boolean(uncertain)} onClick={resetDraft}>Yangi qabulni boshlash</Button> : <Button type="submit" disabled={!ready}>{pending && <Loader2 className="animate-spin" />}Qabulni tasdiqlash</Button>}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
}

interface DetailProps { kind?: 'wip' | 'opening-wip'; row: Row; onSaved?: () => void }

export function WipAdminControls({ kind, row, onSaved }: DetailProps) {
  const { scope } = useSession()
  const actualKind = kind ?? (isOpeningWipRow(row) ? 'opening-wip' : 'wip')
  return <WipDetailPanel key={`${scope}:${actualKind}:${wipOrderId(row)}:${wipBatchId(row)}`} kind={actualKind} row={row} onSaved={onSaved} />
}

function WipDetailPanel({ kind, row, onSaved }: DetailProps & { kind: 'wip' | 'opening-wip' }) {
  const { client, session, scope, demo, connection } = useSession()
  const queryClient = useQueryClient()
  const permissions = wipPermissions(session)
  const orderId = wipOrderId(row), batchId = wipBatchId(row), opening = kind === 'opening-wip'
  const enabled = Boolean(client && session && !demo && orderId && batchId && permissions.read)
  const openingDetail = useQuery({ queryKey: ['wip-admin', scope, 'opening-detail', orderId, batchId], queryFn: ({ signal }) => openingWipDetail(client!, row, signal), enabled: enabled && opening, retry: false })
  const progress = useQuery({ queryKey: ['wip-admin', scope, 'batch-detail', orderId, batchId], queryFn: ({ signal }) => wipBatchDetail(client!, row, signal), enabled: enabled && !opening, retry: false })
  const snapshot = useQuery({ queryKey: [scope, 'production-snapshot'], queryFn: ({ signal }) => client!.productionSnapshot(signal), enabled: enabled && permissions.preview, retry: false, staleTime: 5_000, refetchInterval: enabled && permissions.preview ? 15_000 : false })
  const orderIssue = openingWipOrderIssue(snapshot.data, orderId)
  const fresh = Boolean(snapshot.data && !snapshot.isError && !snapshot.isFetching && Date.now() - snapshot.dataUpdatedAt < 30_000)
  const route = useQuery({ queryKey: ['wip-admin', scope, 'route', orderId, batchId], queryFn: ({ signal }) => wipRoutePreview(client!, progress.data!, '', signal), enabled: enabled && !opening && permissions.preview && progress.isSuccess && progress.data.wip_status === 'waiting' && fresh && !orderIssue, retry: false })
  const live = opening ? openingDetail : progress
  const batch = opening ? openingDetail.data?.batch : progress.data
  const targets = openingDetail.data ? openingWipDestinations(snapshot.data, openingDetail.data) : []
  const routeIds = Array.isArray(route.data?.route?.consumer_apparatus_ids) ? route.data.route.consumer_apparatus_ids.filter((id): id is string => typeof id === 'string') : []
  const destinationIds = [...new Set(opening ? targets.map(value => value.apparatusId) : routeIds)]
  const [apparatusId, setApparatusId] = useState('')
  const [confirmation, setConfirmation] = useState<OpeningWipDetail | null>(null)
  const [uncertain, setUncertain] = useState<OpeningWipDetail | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mutations] = useState(() => new MutationScope())
  const currentScope = useRef(scope)
  currentScope.current = scope
  const inFlight = useRef(false)
  useEffect(() => () => mutations.cancelAll(), [mutations])
  const selectedApparatus = destinationIds.includes(apparatusId) ? apparatusId : destinationIds.length === 1 ? destinationIds[0] : ''
  const cancelIssue = openingDetail.data ? openingWipCancelIssue(openingDetail.data, session) : 'Joriy rulon holati olinmagan.'
  const cancelReady = !demo && opening && client && permissions.cancel && openingDetail.isSuccess && !openingDetail.isError && !openingDetail.isFetching && !cancelIssue && !pending && !uncertain && connection !== 'offline'
  const previewReady = enabled && permissions.preview && fresh && !orderIssue && !live.isFetching && !live.isError && batch?.wip_status === 'waiting' && selectedApparatus && !pending && !uncertain && !route.isFetching && (opening || route.isSuccess && !route.data.routeError)
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['wip-admin', scope] })
    void queryClient.invalidateQueries({ queryKey: [scope, 'production-snapshot'] })
    for (const resource of ['opening-wip', 'wip', 'orders']) {
      void queryClient.invalidateQueries({ queryKey: ['resource', scope, resource] })
      void queryClient.invalidateQueries({ queryKey: ['detail', scope, resource] })
    }
  }
  async function run(action: 'preview' | 'cancel' | 'reconcile', selected?: OpeningWipDetail) {
    if (!client || !session || demo || inFlight.current || (action === 'preview' ? !previewReady : action === 'cancel' ? !cancelReady : !uncertain)) return
    const requestClient = client, requestSession = session, requestScope = scope, lease = mutations.begin()
    const current = () => requestScope === currentScope.current && mutations.isCurrent(lease)
    inFlight.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      if (action === 'preview') {
        if (opening) await openingWipIntakePreview(requestClient, openingDetail.data!, selectedApparatus, lease.controller.signal)
        else await wipRoutePreview(requestClient, progress.data!, selectedApparatus, lease.controller.signal)
        if (current()) setNotice(`Server ${selectedApparatus} uchun shu rulonning kirish mosligini tasdiqladi. Rulon qabul qilinmadi yoki ko‘chirilmagan.`)
      } else if (action === 'cancel') {
        const result = await cancelOpeningWip(requestClient, requestSession, selected!, lease.controller.signal)
        if (!current()) return
        queryClient.setQueryData(['wip-admin', scope, 'opening-detail', orderId, batchId], result)
        setConfirmation(null)
        setUncertain(null)
        setNotice('Rulon bekor qilingani serverda tasdiqlandi.')
        refresh()
        onSaved?.()
      } else {
        const result = await reconcileOpeningWipCancel(requestClient, uncertain!, lease.controller.signal)
        if (!current()) return
        queryClient.setQueryData(['wip-admin', scope, 'opening-detail', orderId, batchId], result.detail)
        setUncertain(null)
        setConfirmation(null)
        setNotice(result.confirmed ? 'Rulonning bekor qilingan holati serverda tasdiqlandi.' : 'Rulon bekor qilingan deb tasdiqlanmadi. Joriy holatni ko‘rib, amalni qayta tasdiqlang.')
        refresh()
        onSaved?.()
      }
    } catch (caught) {
      if (!current()) return
      setError(message(caught))
      if (action === 'cancel' && caught instanceof WipMutationError && caught.uncertain) setUncertain(selected!)
      refresh()
    } finally {
      const active = current()
      mutations.finish(lease)
      if (active) { inFlight.current = false; setPending(false) }
    }
  }
  if (!orderId || !batchId) return <p className="text-sm text-destructive">Buyurtma yoki rulon identifikatori topilmadi.</p>
  if (demo) return <p className="text-sm text-muted-foreground">Ko‘rish rejimida WIP amallari bajarilmaydi.</p>
  if (!permissions.read) return <p className="text-sm text-muted-foreground">WIP holatini o‘qish uchun ruxsat berilmagan.</p>
  if (!client || !session) return <p className="text-sm text-muted-foreground">Joriy sessiyaga qayta kiring.</p>
  return <section className="space-y-4 border-t pt-4" aria-label="WIP boshqaruvi">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{opening ? 'Boshlang‘ich WIP holati' : 'WIP ruloni va kirish yo‘li'}</h3><Button type="button" variant="ghost" size="sm" disabled={pending || live.isFetching} onClick={refresh}><RefreshCw />Yangilash</Button></div>
    {live.error && <Failure error={live.error} retry={() => { void live.refetch() }} />}
    {live.isPending && <Skeleton className="h-16 w-full" />}
    {batch && <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><dt className="text-muted-foreground">Rulon ID</dt><dd className="break-all text-right">{text(batch.batch_id)}</dd><dt className="text-muted-foreground">Buyurtma</dt><dd className="text-right">{text(batch.order_id)}</dd><dt className="text-muted-foreground">Holat</dt><dd className="text-right">{statusLabels[text(batch.wip_status, '')] ?? `Noma’lum (${text(batch.wip_status)})`}</dd><dt className="text-muted-foreground">O‘lchovlar</dt><dd className="text-right">{quantity(batch.finished_goods_meter)} m · {quantity(batch.finished_goods_kg)} kg</dd><dt className="text-muted-foreground">Bobina / diametr</dt><dd className="text-right">{quantity(batch.bobina_kg)} kg / {quantity(batch.diameter)} mm</dd><dt className="text-muted-foreground">Joriy joy</dt><dd className="text-right">{text(openingDetail.data?.intake.current_location ?? batch.current_location)}</dd>{openingDetail.data && <><dt className="text-muted-foreground">Miqdor asosi</dt><dd className="text-right">{basisLabels[openingDetail.data.batch.quantity_basis] ?? openingDetail.data.batch.quantity_basis}</dd><dt className="text-muted-foreground">Chiqish apparati</dt><dd className="break-all text-right">{openingDetail.data.intake.source_apparatus || openingDetail.data.intake.entry_apparatus}</dd><dt className="text-muted-foreground">Qabul holati</dt><dd className="text-right">{statusLabels[openingDetail.data.intake.status] ?? openingDetail.data.intake.status}</dd></>}</dl>}
    {snapshot.error && <Failure error={snapshot.error} retry={() => { void snapshot.refetch() }} />}
    {orderIssue && permissions.preview && <p className="text-sm text-muted-foreground">{orderIssue}</p>}
    {route.error && <Failure error={route.error} retry={() => { void route.refetch() }} />}
    {route.isFetching && <Skeleton className="h-12 w-full" />}
    {route.data?.route && <p className="break-all text-xs text-muted-foreground">Server kirish bosqichi: {text(route.data.route.stage_node_id)} · {route.data.route.remapped === true ? 'Joriy xaritaga qayta bog‘langan.' : 'Joriy yo‘l tasdiqlangan.'}</p>}
    {route.data?.routeError && <Alert variant="destructive"><AlertDescription>Kirish yo‘li tasdiqlanmagan: {route.data.routeError}. Xarita holatini tekshiring.</AlertDescription></Alert>}
    {permissions.preview && batch?.wip_status === 'waiting' && <div className="space-y-2"><Label htmlFor={`wip-destination-${batchId}`}>Canonical kirish apparati</Label><Select value={selectedApparatus} disabled={pending || Boolean(uncertain) || !fresh || live.isFetching || live.isError || !destinationIds.length} onValueChange={value => { setApparatusId(value); setNotice(''); setError('') }}><SelectTrigger id={`wip-destination-${batchId}`}><SelectValue placeholder="Serverdan tasdiqlangan yo‘lni tanlang" /></SelectTrigger><SelectContent>{destinationIds.map(id => <SelectItem key={id} value={id}>{targets.find(value => value.apparatusId === id)?.label ?? id} · {id}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" disabled={!previewReady} onClick={() => { void run('preview') }}><CheckCircle2 />Kirish mosligini tekshirish</Button></div>}
    {opening && permissions.cancel && <><p className="text-xs text-muted-foreground">{cancelIssue || 'Faqat shu rulon bekor qilinadi. Ishlatilgan yoki avlod partiyasiga ulangan rulonni server bloklaydi.'}</p><Button type="button" variant="outline" className="text-destructive" disabled={!cancelReady} onClick={() => { setError(''); setConfirmation(structuredClone(openingDetail.data!)) }}><Trash2 />Rulonni bekor qilish</Button></>}
    {opening && !permissions.cancel && <p className="text-xs text-muted-foreground">Bekor qilish haqiqiy admin hisobiga ruxsat etiladi.</p>}
    {!opening && <p className="text-xs text-muted-foreground">Bu rulon uchun ko‘chirish yoki ishlovni ortga qaytarish amali mavjud emas. Kirish mosligini tekshirish rulonni qabul qilmaydi.</p>}
    {notice && <p className="text-sm" role="status">{notice}</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {uncertain && <Alert variant="destructive"><AlertDescription>Bekor qilish natijasi aniqlanmagan. Yangi amal holat tekshirilguncha yopiq.<Button type="button" variant="outline" disabled={pending} onClick={() => { void run('reconcile') }}>Server holatini tekshirish</Button></AlertDescription></Alert>}
    <Dialog open={Boolean(confirmation)} onOpenChange={value => { if (!value && !inFlight.current && !pending) setConfirmation(null) }}><DialogContent><DialogHeader><DialogTitle>Rulonni bekor qilish</DialogTitle><DialogDescription>{confirmation?.batch.batch_id} rulonini bekor qilishni tasdiqlang. Qabuldagi boshqa rulonlar saqlanadi.</DialogDescription></DialogHeader>{confirmation && <OpeningSummary value={{ intake: confirmation.intake, batches: [confirmation.batch] }} />}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}{uncertain && <Button type="button" variant="outline" disabled={pending} onClick={() => { void run('reconcile') }}>Server holatini tekshirish</Button>}<DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>Yopish</Button><Button type="button" variant="destructive" disabled={!cancelReady || !confirmation} onClick={() => { void run('cancel', confirmation!) }}>{pending && <Loader2 className="animate-spin" />}Bekor qilishni tasdiqlash</Button></DialogFooter></DialogContent></Dialog>
  </section>
}

/** Opening registration is order-centric; this panel uses the same retained-key wizard. */
export function OrderWipAdminControls({ row, onSaved }: { row: Row; onSaved?: () => void }) {
  const { client, session, scope, demo } = useSession()
  const orderId = wipOrderId(row)
  const records = useQuery({ queryKey: ['wip-admin', scope, 'opening-records', orderId], queryFn: ({ signal }) => openingWipRecords(client!, orderId, signal), enabled: Boolean(client && session && !demo && orderId && wipPermissions(session).read), retry: false })
  if (!orderId) return <p className="text-sm text-destructive">Buyurtma identifikatori topilmadi.</p>
  if (!wipPermissions(session).read) return <p className="text-sm text-muted-foreground">WIP holatini o‘qish uchun ruxsat berilmagan.</p>
  if (demo) return <p className="text-sm text-muted-foreground">Ko‘rish rejimida WIP amallari bajarilmaydi.</p>
  return <section className="space-y-4 border-t pt-4" aria-label="Buyurtma boshlang‘ich WIP"><h3 className="text-sm font-semibold">Buyurtma boshlang‘ich WIP</h3><WipAdminToolbar order={row} onSaved={onSaved} />{records.error && <Failure error={records.error} retry={() => { void records.refetch() }} />}{records.isFetching && <Skeleton className="h-16 w-full" />}{records.data?.map(value => <OpeningSummary key={value.intake.intake_id} value={value} />)}{records.isSuccess && !records.data.length && <p className="text-sm text-muted-foreground">Cheklangan ro‘yxatda shu buyurtma qabuli topilmadi.</p>}<p className="text-xs text-muted-foreground">Ro‘yxat eng ko‘p 500 qabulni saqlaydi; umumiy son emas.</p></section>
}
