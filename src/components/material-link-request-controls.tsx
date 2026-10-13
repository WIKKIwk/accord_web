import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Link2, Loader2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import type { Row } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { productionControlOrderId } from '@/lib/production-controls'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import type { ProductionOperationLease } from '@/lib/production-operation-ledger'
import {
  executeMaterialLink, isMaterialLinkRequestId, materialLinkApparatusChoices, materialLinkAttempts,
  materialLinkCanAct, materialLinkCreatePlan, materialLinkDecisionPlan, MaterialLinkError,
  materialLinkPermissions, materialLinkStatusLabels, readMaterialLinkOutcome, readMaterialLinkOverview, readMaterialLinkRequest,
} from '@/lib/material-link-requests'
import type { MaterialLinkCandidate, MaterialLinkDraft, MaterialLinkPlan, MaterialLinkRequest, MaterialLinkResult } from '@/lib/material-link-requests'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'

const errorText = (value: unknown) => value instanceof Error ? value.message : 'Homashyo so‘rovi holati olinmadi.'
function Notice({ children }: { children: React.ReactNode }) { return <p className="text-sm text-muted-foreground">{children}</p> }
function timestamp(value: number) { return value > 0 ? new Date(value * 1000).toLocaleString('uz-UZ') : '—' }
function Roll({ value }: { value: MaterialLinkCandidate }) {
  return <div className="min-w-0 space-y-1 text-sm"><p className="break-words font-medium">{value.barcode} · {value.item_name}</p><Notice>So‘rovdagi miqdor: {value.qty} {value.uom} · {value.location_name}</Notice><Notice>Ko‘chirgan: {value.mover_display_name || value.mover_ref}</Notice></div>
}
export function MaterialLinkRequestSummary({ request }: { request: MaterialLinkRequest }) {
  return <div className="space-y-3 rounded-lg border p-3 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="font-medium">{request.order_number || request.order_id} · {request.apparatus_name}</p><Badge variant="secondary">{materialLinkStatusLabels[request.status]}</Badge></div>
    <p className="break-all text-xs text-muted-foreground">{request.request_id}</p>
    <Notice>So‘ragan: {request.requester_display_name || request.requester_ref} · Ko‘chirgan: {request.mover_display_name || request.mover_ref}</Notice>
    <div className="space-y-2">{request.candidates.map(value => <Roll key={value.stock_id} value={value} />)}</div>
    {request.selected_barcodes.length > 0 && <p>Ulangan rulonlar: {request.selected_barcodes.join(', ')}</p>}
    {request.reason && <p>{request.reason}</p>}
    {request.status === 'pending' ? <Notice>Muddati: {timestamp(request.expires_at_unix)}</Notice> : <Notice>Saqlangan qaror: {request.decided_by_name || 'Server holati'} · {timestamp(request.decided_at_unix)}</Notice>}
  </div>
}
function RollPicker({ values, selected, disabled, onChange }: { values: MaterialLinkCandidate[]; selected: string[]; disabled: boolean; onChange: (values: string[]) => void }) {
  const id = useId()
  return <fieldset disabled={disabled} className="space-y-2"><legend className="mb-2 text-sm font-medium">Kerakli rulonlarni tanlang</legend>{values.map((value, index) => {
    const checked = selected.includes(value.barcode)
    return <div key={value.stock_id} className="flex items-start gap-3 rounded-lg border p-3"><Checkbox id={`${id}-${index}`} className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={next => onChange(next === true ? [...selected.filter(code => code !== value.barcode), value.barcode] : selected.filter(code => code !== value.barcode))} /><label htmlFor={`${id}-${index}`} className="min-w-0 flex-1 cursor-pointer"><Roll value={value} /></label></div>
  })}</fieldset>
}
function PlanReview({ plan }: { plan: MaterialLinkPlan }) {
  return <div className="space-y-3"><p className="font-medium">{plan.action === 'create' ? 'Homashyo ulash uchun so‘rov' : plan.action === 'approve' ? 'Tanlangan rulonlarni ulash' : plan.action === 'reject' ? 'So‘rovni rad etish' : 'Operator so‘rovini bekor qilish'}</p>{plan.action === 'create' ? <><Notice>Buyurtma: {plan.orderId} · Apparat: {plan.apparatusId}</Notice>{plan.selected.map(value => <Roll key={value.stock_id} value={value} />)}<Notice>So‘rovlar tanlangan rulonlarni ko‘chirgan haqiqiy xodimlar bo‘yicha serverda ajratiladi.</Notice></> : <><MaterialLinkRequestSummary request={plan.baseline} />{plan.action === 'approve' && <p className="text-sm">Ulash uchun tanlangan: {(plan.body.barcodes as string[]).join(', ')}</p>}</>}</div>
}

export interface MaterialLinkRequestControlsProps { row: Row; onSaved?: () => void }
/** Selected order detail: worker overview or manager lookup bound to that order. */
export function MaterialLinkRequestControls({ row, onSaved }: MaterialLinkRequestControlsProps) {
  const { scope } = useSession(), orderId = productionControlOrderId(row)
  materialLinkAttempts.activate(scope)
  return orderId ? <MaterialLinkPanel key={`${scope}:${orderId}`} orderId={orderId} onSaved={onSaved} /> : <Notice>Homashyo ulash uchun buyurtmaning haqiqiy identifikatori kerak.</Notice>
}
export interface MaterialLinkRequestDecisionControlsProps { requestId: string; expectedOrderId?: string; onSaved?: () => void }
/** Mount only with an actual native request ID, for example a native card reference. */
export function MaterialLinkRequestDecisionControls({ requestId, expectedOrderId, onSaved }: MaterialLinkRequestDecisionControlsProps) {
  const { scope } = useSession()
  materialLinkAttempts.activate(scope)
  return isMaterialLinkRequestId(requestId) ? <MaterialLinkPanel key={`${scope}:${requestId}:${expectedOrderId ?? ''}`} orderId={expectedOrderId} requestId={requestId} onSaved={onSaved} /> : <Notice>Haqiqiy native homashyo so‘rovi identifikatori kerak.</Notice>
}
function MaterialLinkPanel({ orderId, requestId, onSaved }: { orderId?: string; requestId?: string; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession(), permissions = materialLinkPermissions(session)
  const id = useId(), queryClient = useQueryClient(), draftKey = orderId || `request:${requestId}`
  useSyncExternalStore(materialLinkAttempts.subscribe, materialLinkAttempts.getRevision, materialLinkAttempts.getRevision)
  const draft = materialLinkAttempts.draft(scope, draftKey)
  const savedOrderId = orderId || (requestId ? materialLinkAttempts.orderForRequest(scope, requestId) : undefined)
  const savedPlan = savedOrderId ? materialLinkAttempts.get(scope, savedOrderId)?.plan : undefined
  const [open, setOpen] = useState(false), [lookupId, setLookupId] = useState(requestId || (savedPlan && savedPlan.action !== 'create' ? savedPlan.baseline.request_id : '')), [review, setReview] = useState<MaterialLinkPlan | null>(null), [error, setError] = useState(''), [result, setResult] = useState<MaterialLinkResult | null>(null)
  const [mutations] = useState(() => new MutationScope()), running = useRef<ProductionOperationLease | null>(null), inFlight = useRef(false), identity = useRef(`${scope}:${draftKey}`)
  identity.current = `${scope}:${draftKey}`
  const worker = Boolean(permissions.worker && orderId && !requestId)
  const enabled = Boolean(open && client && session && permissions.read && !demo)
  const detail = useQuery({ queryKey: ['material-link', scope, 'request', lookupId, orderId], queryFn: ({ signal }) => readMaterialLinkRequest(client!, session, lookupId, signal, orderId), enabled: Boolean(enabled && isMaterialLinkRequestId(lookupId)), retry: false, staleTime: 5_000, refetchInterval: enabled && isMaterialLinkRequestId(lookupId) ? 15_000 : false })
  const activeOrderId = orderId || materialLinkAttempts.orderForRequest(scope, lookupId) || detail.data?.request.order_id || ''
  const operation = activeOrderId ? productionOperationLedger.get(scope, activeOrderId) : null
  const retained = activeOrderId ? materialLinkAttempts.get(scope, activeOrderId) : null
  const observed = activeOrderId ? materialLinkAttempts.observed(scope, activeOrderId) : []
  const snapshot = useQuery({ queryKey: [scope, 'production-snapshot'], queryFn: ({ signal }) => client!.productionSnapshot(signal), enabled: enabled && worker, retry: false, staleTime: 5_000, refetchInterval: enabled && worker ? 15_000 : false })
  const choices = worker ? materialLinkApparatusChoices(snapshot.data, orderId!, session) : []
  const apparatusId = retained?.plan.apparatusId || draft.apparatusId
  const context = choices.find(value => value.apparatusId === apparatusId)
  const overview = useQuery({ queryKey: ['material-link', scope, 'overview', orderId, apparatusId], queryFn: ({ signal }) => readMaterialLinkOverview(client!, session, orderId!, apparatusId, signal), enabled: Boolean(enabled && worker && choices.some(value => value.apparatusId === apparatusId)), retry: false, staleTime: 5_000, refetchInterval: enabled && worker && apparatusId ? 15_000 : false })
  const pending = retained?.phase === 'pending', uncertain = retained?.phase === 'uncertain', blocked = Boolean(operation)
  const canOperate = Boolean(client && session && permissions.read && !demo && connection !== 'offline')
  const fresh = Boolean(snapshot.data && overview.data && !snapshot.isError && !overview.isError && !snapshot.isFetching && !overview.isFetching && Date.now() - snapshot.dataUpdatedAt < 30_000 && Date.now() - overview.dataUpdatedAt < 30_000)
  const freshDetail = Boolean(detail.data && !detail.isError && !detail.isFetching && Date.now() - detail.dataUpdatedAt < 30_000)
  useEffect(() => { if (enabled && worker && !draft.apparatusId && !operation && choices.length) materialLinkAttempts.saveDraft(scope, draftKey, { ...draft, apparatusId: (choices.find(value => value.create) || choices[0]).apparatusId }, activeOrderId) }, [enabled, worker, draft, operation, choices, scope, draftKey, activeOrderId])
  useEffect(() => () => { mutations.cancelAll(); if (running.current) materialLinkAttempts.interrupt(running.current) }, [mutations])
  function change(next: MaterialLinkDraft) { try { materialLinkAttempts.saveDraft(scope, draftKey, next, activeOrderId); setError(''); setResult(null); setReview(null) } catch (caught) { setError(errorText(caught)) } }
  function refresh() { for (const key of [['material-link', scope], [scope, 'production-snapshot'], ['raw-material-admin', scope], ['material-intake', scope], ['detail', scope, 'orders', activeOrderId], ['resource', scope, 'raw-materials']]) void queryClient.invalidateQueries({ queryKey: key }) }
  function close(value: boolean) { if (!value) { mutations.cancelAll(); if (running.current) materialLinkAttempts.interrupt(running.current); running.current = null; inFlight.current = false; setReview(null) } setOpen(value) }
  function lookup() { const value = draft.requestId.trim(); if (!isMaterialLinkRequestId(value)) { setError('Native kartadagi material-link-… identifikatorini to‘liq kiriting.'); return } if (value !== lookupId) change({ ...draft, barcodes: [] }); setLookupId(value); setError(''); setResult(null) }
  function buildCreate() { if (!client || !snapshot.data || !overview.data || !orderId || !fresh || blocked) return; try { setReview(materialLinkCreatePlan(snapshot.data, session, scope, orderId, apparatusId, overview.data, draft.barcodes)); setError('') } catch (caught) { setError(errorText(caught)) } }
  function buildDecision(request: MaterialLinkRequest, action: 'approve' | 'reject' | 'cancel') { if (!canOperate || blocked || action !== 'cancel' && !freshDetail) return; try { setReview(materialLinkDecisionPlan(session, scope, { request, can_decide: detail.data?.request.request_id === request.request_id ? detail.data.can_decide : false }, action, action === 'approve' ? draft.barcodes : [])); setError('') } catch (caught) { setError(errorText(caught)) } }
  async function run(plan: MaterialLinkPlan, action: 'save' | 'read' | 'retry') {
    if (!client || !session || !canOperate || inFlight.current) return
    let held: ProductionOperationLease
    try { held = materialLinkAttempts.begin(scope, plan, action !== 'save') } catch (caught) { setError(errorText(caught)); return }
    const lease = mutations.begin(), expected = `${scope}:${draftKey}`, requestClient = client, requestSession = session
    const current = () => mutations.isCurrent(lease) && identity.current === expected
    running.current = held; inFlight.current = true; setError('')
    try {
      const saved = action === 'read' ? await readMaterialLinkOutcome(requestClient, requestSession, plan, lease.controller.signal, current) : await executeMaterialLink(requestClient, requestSession, plan, held, lease.controller.signal, current, action === 'retry')
      materialLinkAttempts.finish(held, saved.confirmed ? { confirmed: true } : { error: saved.message, uncertain: true })
      if (!current()) return
      setReview(null); setResult(saved); refresh()
      if (saved.confirmed) { materialLinkAttempts.saveDraft(scope, draftKey, { ...draft, barcodes: [] }, plan.orderId); toast.success(saved.message); onSaved?.() }
    } catch (caught) {
      const message = errorText(caught)
      materialLinkAttempts.finish(held, { error: message, uncertain: caught instanceof MaterialLinkError && caught.kind === 'uncertain' })
      if (current()) { setError(message); setReview(null); refresh() }
    } finally { mutations.finish(lease); if (running.current === held) { running.current = null; inFlight.current = false } }
  }
  if (!permissions.read) return <Notice>Homashyo so‘rovini o‘qish uchun haqiqiy operator yoki manager doirasi va apparatus.queue.manage, raw_material.assign yoki admin.access ruxsati kerak.</Notice>
  if (orderId?.startsWith('training-')) return <Notice>Mashg‘ulot buyurtmalari homashyo ulash so‘roviga kirmaydi.</Notice>
  return <div className="space-y-2">
    <Button type="button" variant="outline" disabled={!client || demo} onClick={() => { setOpen(true); refresh() }}><Link2 />Homashyo ulash so‘rovlari</Button>
    {demo && <Notice>Ko‘rish rejimida homashyo so‘rovlari yuborilmaydi.</Notice>}
    {operation && !retained && <Notice>Shu buyurtmada avvalgi ishlab chiqarish amali bor. Uning natijasi aniqlanmaguncha yangi so‘rov qulflangan.</Notice>}
    {uncertain && <Notice>Avvalgi homashyo so‘rovi saqlangan. Yangi yuborish qulflangan; serverdagi natijani tekshiring.</Notice>}
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" onEscapeKeyDown={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>Homashyo ulash so‘rovlari</DialogTitle><DialogDescription>Haqiqiy apparat oldidagi bo‘sh rulonlar uchun so‘rov va saqlangan native qaror.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          {worker ? <>
            {snapshot.isPending && <Skeleton className="h-20 w-full" />}
            {choices.length > 0 ? <div className="space-y-2"><Label htmlFor={`${id}-apparatus`}>Biriktirilgan apparat</Label><Select value={apparatusId} disabled={blocked} onValueChange={value => change({ ...draft, apparatusId: value, barcodes: [] })}><SelectTrigger id={`${id}-apparatus`} className="w-full"><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{choices.map(value => <SelectItem key={value.apparatusId} value={value.apparatusId}>{value.label}</SelectItem>)}</SelectContent></Select>{context?.reason && <Notice>{context.reason}</Notice>}</div> : !snapshot.isPending && <Notice>Sessiyada biriktirilgan canonical apparat mavjud emas.</Notice>}
            {overview.isPending && apparatusId && <Skeleton className="h-20 w-full" />}
            {overview.data && !overview.isError && <>
              <Notice>Ro‘yxat ushbu buyurtma, apparat va operatorning oxirgi 50 ta so‘rovi bilan chegaralangan.</Notice>
              {overview.data.requests.map(request => <div key={request.request_id} className="space-y-2"><MaterialLinkRequestSummary request={request} />{request.status === 'pending' && <Button type="button" variant="outline" size="sm" disabled={blocked || !canOperate || !fresh} onClick={() => buildDecision(request, 'cancel')}>So‘rovni bekor qilish</Button>}</div>)}
              {!overview.data.requests.length && <Notice>Bu apparat uchun so‘rovlar mavjud emas.</Notice>}
              {overview.data.candidates.length ? <RollPicker values={overview.data.candidates} selected={draft.barcodes} disabled={blocked || !canOperate || !context?.create || overview.data.requests.some(value => value.status === 'pending')} onChange={barcodes => change({ ...draft, barcodes })} /> : <Notice>Apparat oldida ushbu buyurtmaga ulash mumkin bo‘lgan bo‘sh rulon yo‘q.</Notice>}
              {overview.data.requests.some(value => value.status === 'pending') && <Notice>Avvalgi so‘rov bo‘yicha tasdiq kutilmoqda. Yangi yaratish yopiq.</Notice>}
            </>}
          </> : <>
            <Notice>Manager uchun umumiy so‘rovlar ro‘yxati native APIda mavjud emas. Native karta yoki saqlangan qayddagi aniq identifikator orqali oching.</Notice>
            {!requestId && <div className="space-y-2"><Label htmlFor={`${id}-request`}>Native so‘rov identifikatori</Label><div className="flex gap-2"><Input id={`${id}-request`} value={draft.requestId} disabled={blocked} autoComplete="off" placeholder="material-link-…" onChange={event => change({ ...draft, requestId: event.target.value })} /><Button type="button" variant="outline" disabled={blocked || !client || !draft.requestId.trim()} onClick={lookup}><Search />Ochish</Button></div></div>}
            {detail.isPending && lookupId && <Skeleton className="h-24 w-full" />}
            {detail.data && !detail.isError && <>
              <MaterialLinkRequestSummary request={detail.data.request} />
              {detail.data.request.status === 'pending' && materialLinkCanAct(session, detail.data, 'approve') && <RollPicker values={detail.data.request.candidates} selected={draft.barcodes} disabled={blocked || !canOperate || !freshDetail} onChange={barcodes => change({ ...draft, barcodes })} />}
              {detail.data.request.status === 'pending' && !materialLinkCanAct(session, detail.data, 'approve') && !materialLinkCanAct(session, detail.data, 'reject') && !materialLinkCanAct(session, detail.data, 'cancel') && <Notice>Qaror uchun raw_material.assign va serverdagi haqiqiy manager doirasi kerak. admin.access bu ruxsatni almashtirmaydi.</Notice>}
              {detail.data.request.status === 'pending' && materialLinkCanAct(session, detail.data, 'reject') && !materialLinkCanAct(session, detail.data, 'approve') && <Notice>Rulon ulash uchun bu apparat haqiqiy biriktirish doirangizda bo‘lishi kerak.</Notice>}
              <div className="flex flex-wrap gap-2">
                {materialLinkCanAct(session, detail.data, 'approve') && <Button type="button" disabled={blocked || !canOperate || !freshDetail || !draft.barcodes.length} onClick={() => buildDecision(detail.data.request, 'approve')}>Tanlanganlarni ulash</Button>}
                {materialLinkCanAct(session, detail.data, 'reject') && <Button type="button" variant="outline" disabled={blocked || !canOperate || !freshDetail} onClick={() => buildDecision(detail.data.request, 'reject')}>So‘rovni rad etish</Button>}
                {materialLinkCanAct(session, detail.data, 'cancel') && <Button type="button" variant="outline" disabled={blocked || !canOperate || !freshDetail} onClick={() => buildDecision(detail.data.request, 'cancel')}>So‘rovni bekor qilish</Button>}
              </div>
            </>}
          </>}
          {[snapshot, overview, detail].filter(value => value.isError).map((value, index) => <Alert key={index} variant="destructive"><AlertDescription className="space-y-2"><p>{errorText(value.error)}</p><Button type="button" variant="outline" size="sm" onClick={() => void value.refetch()}>Qayta yuklash</Button></AlertDescription></Alert>)}
          {error || retained?.error ? <Alert variant="destructive"><AlertDescription>{error || retained?.error}</AlertDescription></Alert> : null}
          {pending && <p className="flex items-center gap-2 text-sm" aria-live="polite"><Loader2 className="size-4 animate-spin" />So‘rovning joriy native holati tekshirilmoqda…</p>}
          {uncertain && <div className="space-y-3"><PlanReview plan={retained.plan} /><Notice>{retained.plan.action === 'create' ? 'Kalitsiz yaratish qayta yuborilmaydi. Mos qaydlar kuzatuv sifatida ko‘rsatiladi; qisman yaratilgan yoki cheklangan ro‘yxatda yo‘q so‘rovlarni bu o‘qish bilan rad etib bo‘lmaydi.' : 'Aynan saqlangan so‘rov identifikatori tekshiriladi. Yakunlangan qaror asl xodimi va vaqti bilan ko‘rsatiladi.'}</Notice><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => void run(retained.plan, 'read')}><RefreshCw />Serverdagi so‘rovni tekshirish</Button>{retained.plan.action !== 'create' && <Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => setReview(retained.plan)}>Avvalgi qarorni ko‘rib chiqish</Button>}</div>{observed.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">Serverda kuzatilgan native identifikatorlar</p>{observed.map(request => <MaterialLinkRequestSummary key={request.request_id} request={request} />)}</div>}</div>}
          {review && <Alert><AlertDescription><PlanReview plan={review} /></AlertDescription></Alert>}
          {result && <div className="space-y-2"><p className="flex items-start gap-2 text-sm">{result.confirmed && <CheckCircle2 className="size-4 shrink-0" />}{result.message}</p>{result.requests.map(request => <MaterialLinkRequestSummary key={request.request_id} request={request} />)}</div>}
        </div>
        <DialogFooter className="flex-wrap"><Button type="button" variant="outline" onClick={() => close(false)}>Yopish</Button><Button type="button" variant="outline" disabled={pending} onClick={refresh}><RefreshCw />Holatni yangilash</Button>{review ? <Button type="button" disabled={!canOperate || pending || Boolean(operation && !uncertain)} onClick={() => void run(review, uncertain ? 'retry' : 'save')}>{uncertain ? 'Avvalgi qarorni aynan yuborish' : 'Tasdiqlash va yuborish'}</Button> : worker && !blocked && <Button type="button" disabled={!canOperate || !fresh || !context?.create || !draft.barcodes.length || overview.data?.requests.some(value => value.status === 'pending')} onClick={buildCreate}>Ulash uchun so‘rov</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
