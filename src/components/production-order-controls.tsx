import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, CheckCircle2, CircleHelp, Loader2, Pause, Play, RefreshCw, Snowflake, TriangleAlert, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, isRecord, text } from '@/lib/api'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { MutationScope } from '@/lib/mutation-scope'
import { canViewPage } from '@/lib/permissions'
import { executeProductionCommand, ProductionControlError, productionActionLabels, productionControlOrderId, productionOrderCommand, productionOrderPolicy, productionQueueCommand, productionQueuePolicies, productionReorderCommand, type ProductionCommand, type ProductionOrderAction, type ProductionQueuePolicy } from '@/lib/production-controls'
import { useSession } from '@/lib/session'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import type { ProductionOperationLease } from '@/lib/production-operation-ledger'

interface Confirmation {
  kind: ProductionCommand['kind']
  action: ProductionCommand['action']
  snapshot: ProductionSnapshot
  apparatusRows: Row[]
  apparatusId: string
  queue?: ProductionQueuePolicy
}
const controlLabels = { active: 'Faol', freeze_requested: 'Muzlatish so‘rovi kutilmoqda', frozen: 'Muzlatilgan', unknown: 'Holat noma’lum' }
const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const emptyFrame = () => ({ metres: '', grossKg: '', diameter: '', tareKg: '' })
const message = (error: unknown) => error instanceof Error ? error.message : 'Amal bajarilmadi.'
const interrupted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
interface ControlProof { actor: { role: string; ref: string } }

/** Keyed by identity/order so dialogs and requests cannot migrate to another order. */
export function ProductionOrderControls({ row }: { row: Row }) {
  const { scope } = useSession()
  const orderId = productionControlOrderId(row)
  productionOperationLedger.activate(scope)
  return <ProductionOrderControlsPanel key={`${scope}:${orderId}`} row={row} orderId={orderId} />
}

function ProductionOrderControlsPanel({ row, orderId }: { row: Row; orderId: string }) {
  const { client, session, demo, scope, connection, reconnect } = useSession()
  const queryClient = useQueryClient()
  const queryKey = [scope, 'production-snapshot']
  const snapshot = useQuery({
    queryKey, queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'orders'))), staleTime: 5_000, refetchInterval: demo ? false : 15_000,
  })
  const apparatus = useQuery({
    queryKey: [scope, 'production-control-apparatus'],
    queryFn: ({ signal }) => demo ? Promise.resolve(getDemoPage('apparatus', { limit: 500 })) : client!.listSnapshot('apparatus', { limit: 500 }, signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'apparatus'))), staleTime: 60_000,
  })
  const mutationScope = useMemo(() => new MutationScope(), [])
  const identityRef = useRef({ client, scope, orderId, session })
  identityRef.current = { client, scope, orderId, session }
  const pendingRef = useRef(false)
  const activeAttempt = useRef<ProductionOperationLease | null>(null)
  useSyncExternalStore(productionOperationLedger.subscribe, productionOperationLedger.getRevision, productionOperationLedger.getRevision)
  const orderAttempt = productionOperationLedger.get(scope, orderId)
  const ownAttempt = productionOperationLedger.get<ProductionCommand, ControlProof>(scope, orderId, 'legacy-control')
  const uncertain = ownAttempt?.phase === 'uncertain' ? ownAttempt : null
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [comment, setComment] = useState('')
  const [quantity, setQuantity] = useState('')
  const [uom, setUom] = useState('')
  const [frames, setFrames] = useState<ReturnType<typeof emptyFrame>[]>([])
  const [qr, setQr] = useState('')
  const [batchId, setBatchId] = useState('')
  const [materials, setMaterials] = useState('')
  const [qolips, setQolips] = useState('')
  useEffect(() => () => {
    mutationScope.cancelAll()
    if (activeAttempt.current) productionOperationLedger.interrupt(activeAttempt.current)
    activeAttempt.current = null
  }, [mutationScope])
  useEffect(() => {
    mutationScope.cancelAll()
    if (activeAttempt.current) productionOperationLedger.interrupt(activeAttempt.current)
    activeAttempt.current = null
    pendingRef.current = false; setSaving(false); setConfirm(null)
  }, [client, session, mutationScope])

  const order = productionOrderPolicy(snapshot.data, orderId, session)
  const queues = productionQueuePolicies(snapshot.data, orderId, session, apparatus.data?.items)
  const fresh = Boolean(snapshot.data && !snapshot.isError && Date.now() - snapshot.dataUpdatedAt < 30_000)
  const canChange = !demo && Boolean(client) && fresh && !snapshot.isFetching && !saving && !orderAttempt && !blocked && connection !== 'offline'
  const displayedError = uncertain?.error || error
  const map = isRecord(row.map) ? row.map : row
  const orderLabel = text(map.order_number || map.code || orderId)

  const publish = async (value: ProductionSnapshot | undefined, current: () => boolean) => {
    if (!value || !current()) return
    await queryClient.cancelQueries({ queryKey, exact: true })
    if (!current()) return
    queryClient.setQueryData<ProductionSnapshot>(queryKey, before => {
      if (before && (before.epoch !== value.epoch || before.scope !== value.scope || before.rev > value.rev)) return before
      return value
    })
  }
  const invalidate = () => {
    void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) && query.queryKey.some(part => typeof part === 'string' && ['production-snapshot', 'orders', 'maps', 'wip', 'completed', 'closed', 'completion', 'dashboard'].includes(part)) })
  }
  const refresh = async () => {
    if (saving) return
    const lease = mutationScope.begin()
    try {
      if (connection === 'offline' || blocked) await reconnect()
      if (!mutationScope.isCurrent(lease)) return
      const result = await snapshot.refetch()
      if (!mutationScope.isCurrent(lease)) return
      void apparatus.refetch()
      if (result.isSuccess) { setBlocked(false); setError('') }
    } finally { mutationScope.finish(lease) }
  }
  const open = (kind: Confirmation['kind'], action: Confirmation['action'], queue?: ProductionQueuePolicy) => {
    if (!canChange || !snapshot.data) return
    setError(''); setComment(''); setQuantity(''); setUom(''); setQr(''); setBatchId(''); setMaterials(''); setQolips('')
    setFrames(queue?.operation === 'cut' ? Array.from({ length: queue.frameCount }, emptyFrame) : [])
    setConfirm({ kind, action, queue, snapshot: snapshot.data, apparatusRows: apparatus.data?.items ?? [], apparatusId: queue?.apparatusId ?? '' })
  }
  const run = async (recovery?: ProductionCommand) => {
    if (!client || demo || pendingRef.current || blocked || connection === 'offline' || !recovery && (!confirm || !canChange)) return
    let plan: ProductionCommand
    let attemptLease: ProductionOperationLease
    const actor = { role: String(session?.profile.role ?? '').trim(), ref: String(session?.profile.ref ?? '').trim() }
    try {
      if (recovery) {
        if (!uncertain || recovery.kind !== 'reorder' || uncertain.proof.actor.role !== actor.role || uncertain.proof.actor.ref !== actor.ref) throw new ProductionControlError('blocked', 'Avvalgi buyruq aynan shu sessiya va asl navbat identifikatori bilan tekshiriladi.')
        plan = recovery
      }
      else if (confirm!.kind === 'order') plan = productionOrderCommand(confirm!.snapshot, orderId, session, confirm!.action as ProductionOrderAction, comment)
      else if (confirm!.kind === 'reorder') plan = productionReorderCommand(confirm!.snapshot, orderId, session, confirm!.apparatusId, confirm!.action as 'move_up' | 'move_down')
      else plan = productionQueueCommand(confirm!.snapshot, orderId, session, confirm!.apparatusRows, confirm!.apparatusId, confirm!.action as 'pause' | 'resume', { quantity, uom, description: comment, frames, qr, batchId, materialBarcodes: lines(materials), qolipCodes: lines(qolips) })
      attemptLease = productionOperationLedger.begin(scope, { channel: 'legacy-control', orderId, apparatusId: plan.kind === 'reorder' ? plan.apparatusId : undefined, plan, proof: recovery ? uncertain!.proof : { actor } }, Boolean(recovery))
    } catch (failure) { setError(message(failure)); return }
    activeAttempt.current = attemptLease
    const lease = mutationScope.begin()
    const capturedClient = client, capturedScope = scope, capturedSession = session
    const current = () => mutationScope.isCurrent(lease) && identityRef.current.client === capturedClient && identityRef.current.scope === capturedScope && identityRef.current.orderId === plan.orderId && identityRef.current.session === capturedSession
    pendingRef.current = true; setSaving(true); setError('')
    try {
      const result = await executeProductionCommand(client, session, plan, lease.controller.signal, current, Boolean(recovery), () => {
        if (!productionOperationLedger.dispatched(attemptLease)) throw new DOMException('Amalning buyurtma doirasi o‘zgargan.', 'AbortError')
      })
      productionOperationLedger.finish(attemptLease, { confirmed: true })
      if (!current()) return
      await publish(result.snapshot, current)
      if (!current()) return
      setConfirm(null); setBlocked(false)
      toast.success(result.adjusted ? 'Navbat server ruxsat qilgan eng yaqin o‘ringa surildi.' : result.message)
      if (!result.snapshot) setError('Amal serverda tasdiqlandi. Joriy holat hali yangilanmadi; ma’lumotlarni yangilang.')
      invalidate()
    } catch (failure) {
      if (!current() || interrupted(failure)) { productionOperationLedger.interrupt(attemptLease); return }
      // A dispatched legacy write can fail after a native partial commit. A
      // refresh or rejection during recovery is not proof that it did nothing.
      const dispatched = productionOperationLedger.get(scope, orderId, 'legacy-control')?.dispatched === true
      productionOperationLedger.finish(attemptLease, { error: message(failure), uncertain: dispatched })
      if (failure instanceof ProductionControlError) await publish(failure.snapshot, current)
      if (!current()) return
      setError(message(failure))
      if (dispatched) setConfirm(null)
      if (failure instanceof ProductionControlError && failure.kind === 'conflict' || failure instanceof ApiError && failure.status === 409) { setConfirm(null); invalidate() }
      if (failure instanceof ApiError && failure.status === 403 || failure instanceof ProductionControlError && failure.kind === 'forbidden') { setBlocked(true); setConfirm(null) }
    } finally {
      productionOperationLedger.interrupt(attemptLease)
      if (activeAttempt.current === attemptLease) activeAttempt.current = null
      if (mutationScope.isCurrent(lease)) { pendingRef.current = false; setSaving(false) }
      mutationScope.finish(lease)
    }
  }

  const interaction = isRecord(confirm?.queue?.control?.interaction) ? confirm.queue.control.interaction : {}
  const closeEarly = confirm?.action === 'close_early'
  const pause = confirm?.action === 'pause'
  const resume = confirm?.action === 'resume'

  return <section className="space-y-4 rounded-lg border p-4" aria-label="Buyurtma va apparat navbatini boshqarish">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="space-y-1"><h3 className="text-sm font-semibold">Ishlab chiqarishni boshqarish</h3><p className="text-xs text-muted-foreground">Amallar № {orderLabel} buyurtmaga va tanlangan apparatga tegishli.</p></div><Button size="sm" variant="outline" disabled={snapshot.isFetching || saving} onClick={() => void refresh()}><RefreshCw className={snapshot.isFetching ? 'animate-spin' : undefined} />Yangilash</Button></div>
    {orderAttempt && orderAttempt.channel !== 'legacy-control' && <Alert><AlertDescription>Shu buyurtmaning boshqa ishlab chiqarish amali natijasi kutilmoqda. Buyurtmani o‘zgartirishdan oldin avvalgi amal holatini tekshiring.</AlertDescription></Alert>}
    {ownAttempt?.phase === 'pending' && <p role="status" className="text-xs text-muted-foreground">Buyurtma amali tekshirilmoqda. Shu buyurtmaning boshqa ishlab chiqarish amallari natija aniqlanguncha yopiq.</p>}
    {displayedError && <Alert variant={uncertain ? 'default' : 'destructive'}><TriangleAlert /><AlertTitle>{uncertain ? 'Amal natijasi noaniq' : 'Amal bajarilmadi yoki holat yangilanmadi'}</AlertTitle><AlertDescription>{displayedError}{uncertain && <><span>Avvalgi amal: {productionActionLabels[uncertain.plan.action]}. Asl buyruq va kiritilgan miqdorlar shu sessiya xotirasida saqlanmoqda.</span>{uncertain.plan.kind === 'reorder' ? <Button size="sm" variant="outline" className="mt-2 self-start" disabled={saving || blocked || connection === 'offline'} onClick={() => void run(uncertain.plan)}>{saving ? <Loader2 className="animate-spin" /> : <RefreshCw />}Navbat buyrug‘i natijasini qayta tekshirish</Button> : <><Button size="sm" variant="outline" className="mt-2 self-start" disabled={saving || snapshot.isFetching} onClick={() => void refresh()}><RefreshCw />Joriy holatni o‘qish</Button><span>Joriy holatni o‘qish avvalgi amalning aniq hisobotini tasdiqlamaydi. Native API bu buyruq uchun qayta yuborish identifikatorini bermaydi; yangi amal yopiq.</span></>}</>}</AlertDescription></Alert>}
    {(snapshot.isError || connection === 'offline') && <Alert><TriangleAlert /><AlertTitle>Joriy boshqaruv holati olinmadi</AlertTitle><AlertDescription>{connection === 'offline' ? 'Server bilan aloqa uzilgan. Holat yangilangach amallar ochiladi.' : message(snapshot.error)}</AlertDescription></Alert>}
    {demo && <p className="flex items-start gap-2 text-xs text-muted-foreground"><CircleHelp className="size-4 shrink-0" />Ko‘rish rejimida ishlab chiqarish amallari serverga yuborilmaydi. Boshqarish uchun serverga ulaning.</p>}
    {snapshot.isLoading ? <Skeleton className="h-16 w-full" /> : <>
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{controlLabels[order.state]}</Badge>{order.earlyClose && <Badge variant="secondary">{order.earlyClose.closed_at_unix ? 'Erta yopilgan' : 'Erta yopish kutilmoqda'}</Badge>}{!fresh && snapshot.data && <span className="text-xs text-muted-foreground">Oxirgi yuklangan holat</span>}</div>
      {order.earlyClose && <p className="text-sm text-muted-foreground">Sabab: {text(order.earlyClose.comment)}</p>}
      <div className="flex flex-wrap gap-2">{order.actions.map(action => <Button key={action} size="sm" variant={action === 'close_early' ? 'outline' : 'secondary'} disabled={!canChange} onClick={() => open('order', action)}>{action === 'freeze' ? <Snowflake /> : action === 'cancel_freeze' ? <X /> : action === 'unfreeze' ? <Play /> : <CheckCircle2 />}{productionActionLabels[action]}</Button>)}</div>
      {order.reason && <p className="text-xs text-muted-foreground">{order.reason}</p>}
      {queues.length > 0 && <><Separator /><div className="space-y-3">{queues.map(queue => <div key={queue.apparatusId} className="space-y-3 rounded-md bg-muted/30 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-medium">{queue.name}</p><p className="mt-1 text-xs text-muted-foreground">{queue.statusLabel}{queue.position >= 0 ? ` · navbatda ${queue.position + 1} / ${queue.orderIds.length}` : ''}</p></div><Button size="icon-xs" variant="ghost" asChild><Link to={`/app/apparatus?selected=${encodeURIComponent(queue.apparatusId)}`} aria-label={`${queue.name} tafsilotlarini ochish`}><CircleHelp /></Link></Button></div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><Link to={`/app/orders?view=queue&apparatus=${encodeURIComponent(queue.apparatusId)}`}><ArrowUp />Apparat navbati</Link></Button>
          {queue.pause && <Button size="sm" variant="outline" disabled={!canChange || apparatus.isError || apparatus.isLoading} onClick={() => open('queue', 'pause', queue)}><Pause />To‘xtatish va hisobot</Button>}
          {queue.resume && <Button size="sm" variant="secondary" disabled={!canChange} onClick={() => open('queue', 'resume', queue)}><Play />Davom ettirish</Button>}
          {(queue.moveUp || queue.moveDown) && <><Button size="sm" variant="outline" disabled={!canChange || !queue.moveUp} onClick={() => open('reorder', 'move_up', queue)}><ArrowUp />Oldinga</Button><Button size="sm" variant="outline" disabled={!canChange || !queue.moveDown} onClick={() => open('reorder', 'move_down', queue)}><ArrowDown />Orqaga</Button></>}
        </div>
        {queue.reason && <p className="text-xs text-muted-foreground">{queue.reason}</p>}
        {!queue.pause && !queue.resume && !queue.moveUp && !queue.moveDown && !queue.reason && <p className="text-xs text-muted-foreground">Server bu holat uchun qo‘shimcha amal bermagan.</p>}
      </div>)}</div></>}
      {apparatus.isError && queues.length > 0 && <p className="text-xs text-muted-foreground">Uskuna hisoboti ma’lumotlari yuklanmadi: {message(apparatus.error)}</p>}
    </>}
    <Dialog open={Boolean(confirm)} onOpenChange={opened => { if (!opened && !saving) { setConfirm(null); setError('') } }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto" showCloseButton={!saving} onEscapeKeyDown={event => { if (saving) event.preventDefault() }} onInteractOutside={event => { if (saving) event.preventDefault() }}>
        <DialogHeader><DialogTitle>{confirm ? productionActionLabels[confirm.action] : 'Amalni tasdiqlash'}</DialogTitle><DialogDescription>Buyurtma № {orderLabel}{confirm?.queue ? ` · ${confirm.queue.name}` : ''}. {closeEarly ? 'Bu ishni muddatidan oldin yopish so‘rovidir. Faol ish bo‘lsa, operatorning xavfsiz to‘xtatishi kutiladi; tayyor mahsulot qabuli sifatida qayd etilmaydi.' : pause ? 'Haqiqiy ishlab chiqarilgan miqdorni kiriting. To‘xtatish hisobot va WIP yozuvlarini yaratadi.' : confirm?.kind === 'reorder' ? 'Buyurtma shu apparat navbatida bir o‘rin suriladi. Ishdagi buyurtmalar chegarasini server tekshiradi.' : confirm?.action === 'unfreeze' ? 'Buyurtma navbatga qaytariladi; apparatdagi ishni davom ettirish alohida amal.' : 'Server amaldagi holatni qayta tekshiradi.'}</DialogDescription></DialogHeader>
        {closeEarly && <div className="space-y-2"><Label htmlFor="production-close-reason">Erta yopish sababi</Label><Textarea id="production-close-reason" value={comment} onChange={event => setComment(event.target.value)} placeholder="Sababni yozing" maxLength={4000} disabled={saving} /><p className="text-xs text-muted-foreground">{Array.from(comment.trim()).length} / 2000 belgi</p></div>}
        {pause && confirm?.queue?.operation !== 'cut' && <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="production-pause-quantity">Ishlab chiqarilgan miqdor</Label><Input id="production-pause-quantity" type="number" step="any" min="0" placeholder="Masalan, 1250" value={quantity} onChange={event => setQuantity(event.target.value)} disabled={saving} /></div><div className="space-y-2"><Label htmlFor="production-pause-uom">O‘lchov birligi</Label><Input id="production-pause-uom" placeholder="Masalan, m yoki kg" value={uom} onChange={event => setUom(event.target.value)} disabled={saving} /></div></div>}
        {pause && confirm?.queue?.operation === 'cut' && <div className="space-y-4">{frames.map((frame, index) => <fieldset key={index} className="space-y-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">{index + 1}-chi chiqish ruloni</legend><div className="grid gap-3 sm:grid-cols-2">{([['metres', 'Uzunlik, m'], ['grossKg', 'Brutto og‘irlik, kg'], ['diameter', 'Diametr'], ['tareKg', 'Bobina, kg (ixtiyoriy)']] as const).map(([field, label]) => <div key={field} className="space-y-2"><Label htmlFor={`production-frame-${index}-${field}`}>{label}</Label><Input id={`production-frame-${index}-${field}`} type="number" min="0" step="any" value={frame[field]} onChange={event => setFrames(previous => previous.map((item, number) => number === index ? { ...item, [field]: event.target.value } : item))} disabled={saving} /></div>)}</div></fieldset>)}<p className="text-xs text-muted-foreground">Bobina og‘irligi bo‘lmasa, maydonni bo‘sh qoldiring.</p></div>}
        {pause && <div className="space-y-2"><Label htmlFor="production-pause-note">Izoh (ixtiyoriy)</Label><Textarea id="production-pause-note" value={comment} onChange={event => setComment(event.target.value)} disabled={saving} /><Link className="text-xs text-muted-foreground underline" to="/app/wip">Saqlangan WIP partiyalarini ko‘rish</Link></div>}
        {resume && interaction.resume_input_required === true && <div className="space-y-3"><p className="text-sm">Server kirish WIP rulonini talab qilmoqda. QR kodi yoki partiya IDsi orqali kiriting.</p><div className="space-y-2"><Label htmlFor="production-resume-qr">WIP QR kodi</Label><Input id="production-resume-qr" value={qr} onChange={event => setQr(event.target.value)} disabled={saving} /></div><div className="space-y-2"><Label htmlFor="production-resume-batch">WIP partiya IDsi</Label><Input id="production-resume-batch" value={batchId} onChange={event => setBatchId(event.target.value)} disabled={saving} /></div></div>}
        {resume && interaction.material_scan_required === true && <div className="space-y-2"><Label htmlFor="production-resume-materials">Xomashyo kodlari · har qatorda bittadan</Label><Textarea id="production-resume-materials" value={materials} onChange={event => setMaterials(event.target.value)} disabled={saving} /></div>}
        {resume && interaction.qolip_mode === 'scan_required' && <div className="space-y-2"><Label htmlFor="production-resume-qolips">Qolip kodlari · har qatorda bittadan</Label><Textarea id="production-resume-qolips" value={qolips} onChange={event => setQolips(event.target.value)} disabled={saving} /></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => { setConfirm(null); setError('') }}>Bekor qilish</Button><Button variant={closeEarly ? 'destructive' : 'default'} disabled={!canChange || closeEarly && (!comment.trim() || Array.from(comment.trim()).length > 2000)} onClick={() => void run()}>{saving && <Loader2 className="animate-spin" />}{saving ? 'Server tekshirmoqda…' : 'Tasdiqlash'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
