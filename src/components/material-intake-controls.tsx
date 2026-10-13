import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, PackageCheck, RefreshCw, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import type { Row } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import { productionControlOrderId } from '@/lib/production-controls'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import type { ProductionOperationLease } from '@/lib/production-operation-ledger'
import { useSession } from '@/lib/session'
import {
  executeMaterialIntake, materialDeliveryPreview, materialIntakeAttempts, materialIntakeChoices,
  materialIntakeCommand, MaterialIntakeError, materialIntakeMaterials, materialIntakePermissions,
  materialIntakePolicies, materialIntakeStock, readMaterialIntakeOutcome,
} from '@/lib/material-intake'
import type { IntakeAssignment, MaterialIntakeCommand, MaterialIntakeDraft, MaterialIntakeResult } from '@/lib/material-intake'

const roles: Record<string, string> = { admin: 'Administrator', aparatchi: 'Operator', werka: 'Omborchi', material_taminotchi: 'Material ta’minotchi', qolipchi: 'Qolipchi', tayyorlov_masteri: 'Tayyorlov ustasi' }
const execution: Record<string, string> = { ready: 'Apparat oldida tayyor', awaiting_delivery: 'Yetkazish kutilmoqda', in_use: 'Ishga qabul qilingan', consumed: 'Sarflangan', needs_cutting: 'Kesish talab qilinadi', width_mismatch: 'Eni mos emas', dimensions_missing: 'O‘lchamlar yetarli emas', unavailable: 'Mavjud emas' }
const keyOf = (value: string) => value.trim().replace(/[a-z]/g, value => value.toUpperCase())
const errorText = (value: unknown) => value instanceof Error ? value.message : 'Material holati olinmadi.'
function Notice({ children }: { children: React.ReactNode }) { return <p className="text-sm text-muted-foreground">{children}</p> }
function MaterialSummary({ value }: { value: IntakeAssignment }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm">
    <div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{value.item_name}</p><Badge variant="secondary">{execution[value.execution_status] || 'Holat aniqlanmagan'}</Badge></div>
    <p className="break-words">{value.barcode} · {value.stock_warehouse} · {value.stock_qty} {value.stock_uom}</p>
    <Notice>Qabul qilingan: {value.received_qty} {value.stock_uom} · Qolgan: {value.remaining_qty} {value.stock_uom}</Notice>
  </div>
}
function Review({ plan }: { plan: MaterialIntakeCommand }) {
  return <div className="space-y-2">
    <p className="font-medium">{plan.action === 'delivery' ? 'Fizik yetkazish qaydi' : 'Qo‘shimcha material qabuli'}</p>
    <MaterialSummary value={plan.baseline} />
    <Notice>Bosqich: {plan.stageNodeId} · Apparat: {plan.apparatusId}</Notice>
    {plan.deliverer && <Notice>Olib kelgan: {plan.deliverer.name} · {roles[plan.deliverer.role] || plan.deliverer.role}</Notice>}
  </div>
}

/** Mount in the selected order detail. Every apparatus and roll comes from native reads. */
export function MaterialIntakeControls({ row, onSaved }: { row: Row; onSaved?: () => void }) {
  const { scope } = useSession()
  materialIntakeAttempts.activate(scope)
  const orderId = productionControlOrderId(row)
  return orderId ? <OrderMaterialIntake key={`${scope}:${orderId}`} orderId={orderId} onSaved={onSaved} /> : <Notice>Material qabul qilish uchun buyurtmaning haqiqiy identifikatori kerak.</Notice>
}
function OrderMaterialIntake({ orderId, onSaved }: { orderId: string; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession(), permissions = materialIntakePermissions(session)
  const queryClient = useQueryClient(), id = useId()
  useSyncExternalStore(materialIntakeAttempts.subscribe, materialIntakeAttempts.getRevision, materialIntakeAttempts.getRevision)
  const retained = materialIntakeAttempts.get(scope, orderId), operation = productionOperationLedger.get(scope, orderId), draft = materialIntakeAttempts.draft(scope, orderId)
  const [open, setOpen] = useState(false), [review, setReview] = useState<MaterialIntakeCommand | null>(null), [error, setError] = useState(''), [result, setResult] = useState<MaterialIntakeResult | null>(null)
  const [mutations] = useState(() => new MutationScope()), running = useRef<ProductionOperationLease | null>(null), inFlight = useRef(false), currentIdentity = useRef(`${scope}:${orderId}`)
  currentIdentity.current = `${scope}:${orderId}`
  const enabled = Boolean(open && client && session && permissions.manage && permissions.read && !demo)
  const snapshot = useQuery({ queryKey: [scope, 'production-snapshot'], queryFn: ({ signal }) => client!.productionSnapshot(signal), enabled, retry: false, staleTime: 5_000, refetchInterval: enabled ? 15_000 : false })
  const apparatus = useQuery({ queryKey: [scope, 'production-control-apparatus'], queryFn: ({ signal }) => client!.listSnapshot('apparatus', { limit: 500 }, signal), enabled, retry: false, staleTime: 15_000 })
  const policies = materialIntakePolicies(snapshot.data, orderId, session, apparatus.data?.items ?? [])
  const selectedId = retained?.plan.apparatusId || draft.apparatusId, policy = policies.find(value => value.apparatusId === selectedId)
  const materials = useQuery({ queryKey: ['material-intake', scope, orderId, selectedId, policy?.intake], queryFn: ({ signal }) => materialIntakeMaterials(client!, orderId, policy!, signal), enabled: Boolean(enabled && policy?.bound), retry: false, staleTime: 5_000 })
  const choices = policy && materials.data ? materialIntakeChoices(materials.data, policy) : []
  const selected = choices.find(value => value.barcode === draft.barcode), scanned = Boolean(selected && keyOf(draft.scanned) === keyOf(selected.barcode))
  const stock = useQuery({ queryKey: ['material-intake', scope, orderId, selectedId, 'stock', draft.barcode], queryFn: ({ signal }) => materialIntakeStock(client!, orderId, selectedId, draft.barcode, signal), enabled: Boolean(enabled && selected && scanned), retry: false, staleTime: 5_000 })
  const delivery = useQuery({ queryKey: ['material-intake', scope, orderId, selectedId, 'delivery', draft.barcode], queryFn: ({ signal }) => materialDeliveryPreview(client!, orderId, selectedId, draft.barcode, signal), enabled: Boolean(enabled && selected && scanned && policy?.delivery), retry: false, staleTime: 5_000 })
  useEffect(() => {
    if (!enabled || draft.apparatusId || operation || !policies.length) return
    materialIntakeAttempts.saveDraft(scope, orderId, { ...draft, apparatusId: (policies.find(value => value.intake || value.delivery) || policies[0]).apparatusId })
  }, [enabled, draft, operation, policies, scope, orderId])
  useEffect(() => () => { mutations.cancelAll(); if (running.current) materialIntakeAttempts.interrupt(running.current) }, [mutations])
  const pending = retained?.phase === 'pending', uncertain = retained?.phase === 'uncertain', blocked = Boolean(operation)
  const canOperate = Boolean(client && permissions.manage && !demo && connection !== 'offline')
  const reads = [snapshot, apparatus, materials, stock, delivery]
  const failures = reads.filter(value => value.isError)
  const fresh = Boolean(reads.every(value => value.data !== undefined && !value.isError && !value.isFetching && Date.now() - value.dataUpdatedAt < 30_000))
  const ready = Boolean(canOperate && !blocked && fresh && selected && scanned && policy && stock.data && delivery.data && materials.data)
  const deliverer = delivery.data?.deliverers.find(value => JSON.stringify([value.role, value.ref]) === draft.delivererKey)
  function change(next: MaterialIntakeDraft) { try { materialIntakeAttempts.saveDraft(scope, orderId, next); setReview(null); setError(''); setResult(null) } catch (caught) { setError(errorText(caught)) } }
  function refresh() {
    for (const key of [['material-intake', scope, orderId], ['raw-material-admin', scope], [scope, 'production-snapshot'], ['detail', scope, 'orders', orderId], ['resource', scope, 'orders'], ['resource', scope, 'raw-materials'], ['resource', scope, 'assets'], ['detail', scope, 'raw-materials']]) void queryClient.invalidateQueries({ queryKey: key })
  }
  function close(value: boolean) {
    if (!value) { mutations.cancelAll(); if (running.current) materialIntakeAttempts.interrupt(running.current); running.current = null; inFlight.current = false; setReview(null) }
    setOpen(value)
  }
  function build(action: 'delivery' | 'intake') {
    if (!ready || !snapshot.data || !apparatus.data || !materials.data || !stock.data || !delivery.data) return
    try { setReview(materialIntakeCommand(snapshot.data, orderId, session, scope, apparatus.data.items, selectedId, materials.data, stock.data, delivery.data, action, draft.scanned, deliverer)); setError('') } catch (caught) { setError(errorText(caught)) }
  }
  async function run(plan: MaterialIntakeCommand, action: 'save' | 'read' | 'retry') {
    if (!client || !session || !canOperate || inFlight.current) return
    let held: ProductionOperationLease
    try { held = materialIntakeAttempts.begin(scope, plan, action !== 'save') } catch (caught) { setError(errorText(caught)); return }
    const lease = mutations.begin(), identity = `${scope}:${orderId}`, requestClient = client, requestSession = session
    const current = () => mutations.isCurrent(lease) && currentIdentity.current === identity
    running.current = held; inFlight.current = true; setError('')
    try {
      const saved = action === 'read' ? await readMaterialIntakeOutcome(requestClient, requestSession, plan, lease.controller.signal, current) : await executeMaterialIntake(requestClient, requestSession, plan, held, lease.controller.signal, current, action === 'retry')
      materialIntakeAttempts.finish(held, saved ? { confirmed: true } : { error: 'Aniq avvalgi natija topilmadi. Ro‘yxatda yo‘qligi so‘rov bekor bo‘lganini isbotlamaydi; avvalgi so‘rov saqlangan.', uncertain: true })
      if (!current()) return
      setReview(null); refresh()
      if (saved) { setResult(saved); toast.success(saved.message); onSaved?.() }
    } catch (caught) {
      const message = errorText(caught)
      materialIntakeAttempts.finish(held, { error: message, uncertain: caught instanceof MaterialIntakeError && caught.kind === 'uncertain' })
      if (current()) { setError(message); setReview(null); refresh() }
    } finally { mutations.finish(lease); if (running.current === held) { running.current = null; inFlight.current = false } }
  }
  if (!permissions.manage) return <Notice>Material qabul qilish uchun apparatus.queue.manage ruxsati kerak.</Notice>
  if (orderId.startsWith('training-')) return <Notice>Mashg‘ulot materiallari alohida operator oqimida qabul qilinadi.</Notice>
  return <div className="space-y-2">
    <Button type="button" variant="outline" disabled={!client || demo} onClick={() => { setOpen(true); refresh() }}><PackageCheck />Material qabul qilish</Button>
    {demo && <Notice>Ko‘rish rejimida material qabuli o‘zgartirilmaydi.</Notice>}
    {operation && !retained && <Notice>Shu buyurtmada avvalgi ishlab chiqarish amali bor. Uning natijasi aniqlanmaguncha material qabuli qulflangan.</Notice>}
    {uncertain && <Notice>Avvalgi material so‘rovi saqlangan · {retained.plan.baseline.barcode}. Yangi amal qulflangan; oyna ichida natijani tekshiring.</Notice>}
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" onEscapeKeyDown={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>Material qabul qilish</DialogTitle><DialogDescription>Buyurtmaga biriktirilgan rulonni apparat oldiga yetkazish va ishga qo‘shimcha qabul qilish.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          {(snapshot.isPending || apparatus.isPending) && <Skeleton className="h-24 w-full" />}
          {failures.map((value, index) => <Alert variant="destructive" key={index}><AlertDescription className="space-y-2"><p>{errorText(value.error)}</p><Button type="button" variant="outline" size="sm" onClick={() => void value.refetch()}>Qayta yuklash</Button></AlertDescription></Alert>)}
          {snapshot.data && apparatus.data && !snapshot.isError && !apparatus.isError && <div className="space-y-2">
            <Label htmlFor={`${id}-apparatus`}>Apparat va bosqich</Label>
            {policies.length ? <Select value={selectedId} disabled={blocked} onValueChange={apparatusId => change({ apparatusId, barcode: '', scanned: '', delivererKey: '' })}><SelectTrigger id={`${id}-apparatus`} className="w-full"><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{policies.map(value => <SelectItem key={value.apparatusId} value={value.apparatusId}>{value.name} · {value.stageTitle}</SelectItem>)}</SelectContent></Select> : <Notice>Buyurtmaning canonical material qabul bosqichlari mavjud emas.</Notice>}
            {policy?.reason && <Notice>{policy.reason}</Notice>}
          </div>}
          {materials.isPending && policy?.bound && <Skeleton className="h-20 w-full" />}
          {materials.data && !materials.isError && policy && !retained && <>
            {choices.length ? <div className="space-y-2"><Label htmlFor={`${id}-material`}>Biriktirilgan material</Label><Select value={draft.barcode} disabled={blocked || !canOperate} onValueChange={barcode => change({ ...draft, barcode, scanned: '', delivererKey: '' })}><SelectTrigger id={`${id}-material`} className="w-full"><SelectValue placeholder="Rulonni tanlang" /></SelectTrigger><SelectContent>{choices.map(value => <SelectItem key={value.barcode} value={value.barcode}>{value.item_name} · {value.barcode} · {value.stock_qty} {value.stock_uom}</SelectItem>)}</SelectContent></Select></div> : <Notice>Joriy apparat uchun qabulga tayyor yangi material nomzodlari mavjud emas.</Notice>}
            {selected && <><MaterialSummary value={selected} /><div className="space-y-2"><Label htmlFor={`${id}-barcode`}>Material shtrixkodi</Label><Input id={`${id}-barcode`} value={draft.scanned} disabled={blocked || !canOperate} autoComplete="off" placeholder="Rulondagi haqiqiy shtrixkod" onChange={event => change({ ...draft, scanned: event.target.value, delivererKey: '' })} /></div>{draft.scanned && !scanned && <Notice>Skan tanlangan rulonning shtrixkodiga mos kelmadi.</Notice>}</>}
            {selected && scanned && (stock.isPending || delivery.isPending) && <Skeleton className="h-16 w-full" />}
            {delivery.data && !delivery.isError && scanned && <>{delivery.data.alreadyAtApparatus ? <Notice>Rulon apparat oldida ekani serverda tasdiqlangan.</Notice> : <div className="space-y-2"><Label htmlFor={`${id}-deliverer`}>Olib kelgan xodim</Label>{delivery.data.deliverers.length ? <Select value={draft.delivererKey} disabled={blocked || !canOperate} onValueChange={delivererKey => change({ ...draft, delivererKey })}><SelectTrigger id={`${id}-deliverer`} className="w-full"><SelectValue placeholder="Ruxsatli xodimni tanlang" /></SelectTrigger><SelectContent>{delivery.data.deliverers.map(value => <SelectItem key={JSON.stringify([value.role, value.ref])} value={JSON.stringify([value.role, value.ref])}>{value.name} · {roles[value.role] || value.role}</SelectItem>)}</SelectContent></Select> : <Notice>Materialning haqiqiy ombori uchun ruxsatli olib kelgan xodimlar mavjud emas.</Notice>}</div>}</>}
            {materials.data.assignments.length > 0 && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Apparatga biriktirilgan materiallar ({materials.data.assignments.length})</summary><div className="mt-3 space-y-2">{materials.data.assignments.map(value => <MaterialSummary key={value.barcode} value={value} />)}</div></details>}
          </>}
          {error || retained?.error ? <Alert variant="destructive"><AlertDescription>{error || retained?.error}</AlertDescription></Alert> : null}
          {pending && <p className="flex items-center gap-2 text-sm" aria-live="polite"><Loader2 className="size-4 animate-spin" />Materialning joriy holati tekshirilmoqda…</p>}
          {uncertain && <div className="space-y-3"><Review plan={retained.plan} /><Notice>{retained.plan.action === 'delivery' ? 'Aynan avvalgi yetkazish so‘rovi saqlangan. Tarixdagi aniq qayd tekshiriladi; ro‘yxat 200 ta hodisa bilan chegaralangan.' : 'Bu qabul amali qayta yuborilmaydi. Aynan shu rulonning serverdagi qabul holati tekshiriladi.'}</Notice><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => void run(retained.plan, 'read')}><RefreshCw />Serverdagi qabulni tekshirish</Button>{retained.plan.action === 'delivery' && <Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => setReview(retained.plan)}>Avvalgi yetkazishni ko‘rib chiqish</Button>}</div></div>}
          {review && <Alert><AlertDescription><Review plan={review} /></AlertDescription></Alert>}
          {result && <div className="space-y-2"><p className="flex items-start gap-2 text-sm"><CheckCircle2 className="size-4 shrink-0" />{result.message}</p>{result.assignment && <MaterialSummary value={result.assignment} />}</div>}
        </div>
        <DialogFooter className="flex-wrap">
          <Button type="button" variant="outline" onClick={() => close(false)}>Yopish</Button>
          {review ? <Button type="button" disabled={!canOperate || pending || Boolean(operation && !uncertain)} onClick={() => void run(review, uncertain ? 'retry' : 'save')}>{uncertain ? 'Avvalgi yetkazishni aynan yuborish' : 'Tasdiqlash va qabul qilish'}</Button> : !blocked && <>
            {policy?.delivery && delivery.data && !delivery.data.alreadyAtApparatus && <Button type="button" disabled={!ready || !deliverer} onClick={() => build('delivery')}><Truck />Yetkazishni qayd etish</Button>}
            {policy?.intake && <Button type="button" disabled={!ready || !delivery.data?.alreadyAtApparatus || selected?.execution_status !== 'ready'} onClick={() => build('intake')}><PackageCheck />Qo‘shimcha materialni qabul qilish</Button>}
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
