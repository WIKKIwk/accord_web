import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardCheck, Loader2, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, isRecord, text } from '@/lib/api'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { MutationScope } from '@/lib/mutation-scope'
import { canViewPage } from '@/lib/permissions'
import { productionControlOrderId } from '@/lib/production-controls'
import { productionAssignmentAttempts } from '@/lib/production-assignment'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import type { ProductionOperationLease } from '@/lib/production-operation-ledger'
import { checkProductionCompletion, emptyCompletionFrame, emptyProductionCompletionDraft, executeProductionCompletion, ProductionCompletionError, productionCompletionAttempts, productionCompletionCommand, productionCompletionDraftMatches, productionCompletionPolicies, readProductionCompletionContext, recoverProductionCompletion } from '@/lib/production-completion'
import type { CompletionContext, CompletionPaintField, ProductionCompletionCommand, ProductionCompletionDraft, ProductionCompletionPolicy, ProductionCompletionProof, ProductionCompletionResult } from '@/lib/production-completion'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

interface Form { policy: ProductionCompletionPolicy; snapshot: ProductionSnapshot; rows: Row[]; context: CompletionContext }
interface Review { plan: ProductionCompletionCommand; proof: ProductionCompletionProof }
const message = (error: unknown) => error instanceof Error ? error.message : 'Hisobot yoki kirish ma’lumotlari tasdiqlanmadi.'
const field = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : ''

/** The confirmed business receipt remains visible when labels fail or stay USB-pending. */
export function ProductionCompletionResultView({ result }: { result: ProductionCompletionResult }) {
  const hasLabels = result.batches.length > 0 || result.remainders.some(value => typeof value.qr_payload === 'string' && value.qr_payload.trim())
  return <div className="space-y-3 rounded-md border p-3"><div className="flex flex-wrap items-start gap-2"><Badge variant="outline">{result.kind === 'approval_requested' ? 'Tasdiqlash kutilmoqda' : result.kind === 'partial' ? 'Joriy rulon qayd etildi' : 'Bosqich hisoboti saqlandi'}</Badge><p className="text-sm">{result.message}</p></div>
    {result.batches.map(batch => <div key={text(batch.batch_id)} className="space-y-1 text-xs"><p className="font-medium">WIP · {text(batch.batch_id)}</p><p className="text-muted-foreground">{text(batch.finished_goods_meter)} m · {text(batch.finished_goods_kg)} kg</p><code className="block break-all text-muted-foreground">{text(batch.qr_payload)}</code></div>)}
    {result.remainders.length > 0 && <div className="space-y-2"><p className="text-xs text-muted-foreground">Qatlam qoldig‘i yozuvlari: {result.remainders.length}</p>{result.remainders.map(value => <div key={text(value.operation_id)} className="space-y-1 rounded-md border p-2 text-xs"><p className="break-all">{text(value.source_kind)} · {text(value.source_id)} → {text(value.remaining_net_kg)} kg</p><p className="break-all text-muted-foreground">Qayd: {text(value.operation_id)}</p>{typeof value.qr_payload === 'string' && value.qr_payload.trim() ? <code className="block break-all text-muted-foreground">{value.qr_payload}</code> : <p className="text-muted-foreground">Qoldiq 0; yangi yorliq QRi mavjud emas.</p>}</div>)}</div>}
    {result.prints.some(print => print.ok !== true) && <Alert><AlertDescription>Hisobot saqlandi, ayrim yorliqlar tayyorlanmadi. Hisobot qayta yuborilmaydi. Qayta bosishda aynan yuqoridagi saqlangan WIP yoki qoldiq QRidan foydalaning.</AlertDescription></Alert>}
    {result.prints.some(print => print.ok === true && print.status === 'prepared') && <p className="text-xs text-muted-foreground">Yorliq ma’lumotlari offline tayyorlangan. client_usb_pending fizik bosma tasdig‘i emas; web USB bosmani bajarmaydi.</p>}
    {hasLabels && result.prints.length === 0 && <p className="text-xs text-muted-foreground">Biznes hisobot tasdiqlandi. Ushbu javobda yorliq/printer holati tasdiqlanmagan; saqlangan QR saqlanadi.</p>}
  </div>
}

export function ProductionCompletionControls({ row }: { row: Row }) {
  const { scope, session } = useSession(), orderId = productionControlOrderId(row)
  if (!orderId || !session?.token || !canViewPage(session, 'orders')) return null
  productionCompletionAttempts.activate(scope)
  return <CompletionPanel key={`${scope}:${orderId}`} row={row} orderId={orderId} />
}
function CompletionPanel({ row, orderId }: { row: Row; orderId: string }) {
  const { client, session, scope, demo, connection, reconnect } = useSession()
  const queryClient = useQueryClient(), queryKey = [scope, 'production-snapshot']
  const snapshot = useQuery({ queryKey, queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'orders'))), retry: false, staleTime: 5000, refetchInterval: demo ? false : 15000 })
  const apparatus = useQuery({ queryKey: [scope, 'production-control-apparatus'], queryFn: ({ signal }) => demo ? Promise.resolve(getDemoPage('apparatus', { limit: 500 })) : client!.listSnapshot('apparatus', { limit: 500 }, signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'apparatus'))), retry: false, staleTime: 60000 })
  useSyncExternalStore(productionCompletionAttempts.subscribe, productionCompletionAttempts.getRevision, productionCompletionAttempts.getRevision)
  const operation = productionOperationLedger.get(scope, orderId), attempt = productionCompletionAttempts.get(scope, orderId)
  const mutationScope = useMemo(() => new MutationScope(), []), activeOperation = useRef<ProductionOperationLease | null>(null), pending = useRef(false)
  const identity = useRef({ client, session, scope, orderId }); identity.current = { client, session, scope, orderId }
  const [busy, setBusy] = useState(false), [form, setForm] = useState<Form | null>(null), [draft, setDraft] = useState(emptyProductionCompletionDraft), [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [blocked, setBlocked] = useState(false), [result, setResult] = useState<ProductionCompletionResult | null>(null)
  useEffect(() => () => {
    mutationScope.cancelAll()
    if (activeOperation.current) productionCompletionAttempts.interrupt(activeOperation.current)
    activeOperation.current = null
  }, [mutationScope])
  useEffect(() => {
    mutationScope.cancelAll()
    if (activeOperation.current) productionCompletionAttempts.interrupt(activeOperation.current)
    activeOperation.current = null; pending.current = false
    setBusy(false); setForm(null); setReview(null); setResult(null)
  }, [client, session, mutationScope])
  const policies = productionCompletionPolicies(snapshot.data, orderId, session, apparatus.data?.items)
  const fresh = Boolean(snapshot.data && !snapshot.isError && Date.now() - snapshot.dataUpdatedAt < 30000)
  const canOpen = !demo && Boolean(client) && fresh && !snapshot.isFetching && !apparatus.isError && !apparatus.isFetching && !busy && !operation && !blocked && connection === 'online'
  const map = isRecord(row.map) ? row.map : row, orderLabel = text(map.order_number || map.code || orderId)
  const displayedError = attempt?.phase === 'uncertain' ? attempt.error || 'Avvalgi tugatish hisoboti natijasi aniqlanmagan.' : error
  function releaseReview() { if (activeOperation.current) productionCompletionAttempts.interrupt(activeOperation.current); activeOperation.current = null; setReview(null) }
  function close() { if (busy) return; releaseReview(); setForm(null); setError(''); setNotice('') }
  function change(next: ProductionCompletionDraft) {
    if (busy || !form) return
    releaseReview(); setDraft(next); setError('')
    productionCompletionAttempts.saveDraft(scope, orderId, { policy: form.policy, context: form.context, draft: next })
  }
  function leaseCurrent(lease: ReturnType<MutationScope['begin']>, captured: typeof identity.current) {
    return () => mutationScope.isCurrent(lease) && identity.current.client === captured.client && identity.current.session === captured.session && identity.current.scope === captured.scope && identity.current.orderId === captured.orderId
  }
  async function publish(value: ProductionSnapshot | undefined, current: () => boolean) {
    if (!value || !current()) return
    await queryClient.cancelQueries({ queryKey, exact: true }); if (!current()) return
    queryClient.setQueryData<ProductionSnapshot>(queryKey, before => before && (before.epoch !== value.epoch || before.scope !== value.scope || before.rev > value.rev) ? before : value)
  }
  function invalidate() { void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) && query.queryKey.some(part => typeof part === 'string' && ['production-snapshot', 'orders', 'maps', 'wip', 'completed', 'closed', 'completion', 'raw-materials', 'dashboard', 'manufacturing-batches', 'manufacturing-report'].includes(part)) }) }
  async function refresh() {
    if (busy) return
    const lease = mutationScope.begin(), current = leaseCurrent(lease, identity.current)
    try {
      if (connection === 'offline' || blocked) await reconnect()
      if (!current()) return
      const loaded = await snapshot.refetch(); if (!current()) return
      void apparatus.refetch()
      if (loaded.isSuccess) { setBlocked(false); setError('') }
    } finally { mutationScope.finish(lease) }
  }
  async function open(policy: ProductionCompletionPolicy) {
    if (!client || !snapshot.data || !canOpen || pending.current || productionOperationLedger.get(scope, orderId) || productionAssignmentAttempts.get(scope, orderId)) return
    const lease = mutationScope.begin(), current = leaseCurrent(lease, identity.current), before = snapshot.data
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const context = await readProductionCompletionContext(client, policy, orderId, lease.controller.signal, current)
      if (!current()) return
      const saved = productionCompletionAttempts.getDraft(scope, orderId, policy), next = saved && productionCompletionDraftMatches(saved, policy, context) ? saved.draft : emptyProductionCompletionDraft()
      if (policy.operation === 'cut') next.frames = context.cut!.counts.map((_, index) => {
        const slot = context.cut!.saved.find(value => value.frame_index === index + 1), input = slot && isRecord(slot.input) ? slot.input : null
        return input ? { metres: field(input.finished_goods_meter ?? input.produced_qty), grossKg: field(input.gross_qty ?? input.finished_goods_kg), tareKg: field(input.bobina_kg), diameter: field(input.diameter), issueNote: text(input.issue_note, '') } : next.frames[index] ?? emptyCompletionFrame()
      })
      setForm({ policy, snapshot: before, rows: apparatus.data?.items ?? [], context }); setDraft(next); setReview(null)
      if (saved) setNotice(productionCompletionDraftMatches(saved, policy, context) ? 'Avvalgi qoralama shu sessiya va kirish manbalariga tiklandi.' : 'Avvalgi qoralama boshqa sessiya yoki kirish manbalariga tegishli. Yangi hisobot maydonlari qayta kiritiladi.')
    } catch (failure) { if (current()) { setError(message(failure)); if (failure instanceof ApiError && failure.status === 403) setBlocked(true) } }
    finally { if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }; mutationScope.finish(lease) }
  }
  async function prepare() {
    if (!client || !form || pending.current || demo || connection !== 'online' || blocked || productionOperationLedger.get(scope, orderId) || productionAssignmentAttempts.get(scope, orderId)) return
    let plan: ProductionCompletionCommand, operationLease: ProductionOperationLease
    try {
      plan = productionCompletionCommand(form.snapshot, orderId, session, form.rows, form.policy.apparatusId, scope, form.context, draft)
      operationLease = productionCompletionAttempts.begin(scope, plan)
    } catch (failure) { setError(message(failure)); return }
    activeOperation.current = operationLease
    const lease = mutationScope.begin(), current = leaseCurrent(lease, identity.current)
    pending.current = true; setBusy(true); setError('')
    try { const proof = await checkProductionCompletion(client, plan, lease.controller.signal, current); if (current()) setReview({ plan, proof }) }
    catch (failure) {
      productionCompletionAttempts.finish(operationLease, { error: message(failure), uncertain: false }); activeOperation.current = null
      if (current()) { setError(message(failure)); if (failure instanceof ApiError && failure.status === 403) setBlocked(true) }
    } finally {
      if (!current()) { productionCompletionAttempts.interrupt(operationLease); activeOperation.current = null }
      if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }; mutationScope.finish(lease)
    }
  }
  async function submit(recover = false) {
    const plan = recover ? attempt?.plan : review?.plan
    if (!client || !plan || demo || pending.current || blocked || connection !== 'online') return
    let operationLease: ProductionOperationLease
    try {
      if (recover) operationLease = productionCompletionAttempts.begin(scope, plan, true)
      else {
        if (!activeOperation.current || productionOperationLedger.get(scope, orderId)?.channel !== 'completion') return
        operationLease = activeOperation.current
      }
    } catch (failure) { setError(message(failure)); return }
    activeOperation.current = operationLease
    const lease = mutationScope.begin(), current = leaseCurrent(lease, identity.current)
    pending.current = true; setBusy(true); setError('')
    try {
      const onDispatch = () => productionCompletionAttempts.dispatched(operationLease)
      const saved = recover ? await recoverProductionCompletion(client, session, plan, lease.controller.signal, current, true, onDispatch) : await executeProductionCompletion(client, session, plan, lease.controller.signal, current, onDispatch)
      if (!saved) throw new ProductionCompletionError('uncertain', 'Aynan shu native hisobot natijasi hali topilmadi. Avvalgi so‘rov saqlanmoqda.')
      productionCompletionAttempts.finish(operationLease, { confirmed: true }); activeOperation.current = null
      productionCompletionAttempts.clearDraft(scope, orderId, plan.policy)
      if (!current()) return
      await publish(saved.snapshot, current); if (!current()) return
      setResult(saved); setForm(null); setReview(null); setNotice(''); toast.success(saved.message); invalidate()
      if (!saved.snapshot) setNotice('Hisobot tasdiqlandi. Joriy navbat hali olinmadi; ma’lumotlarni yangilang.')
    } catch (failure) {
      if (!current()) { productionCompletionAttempts.interrupt(operationLease); return }
      productionCompletionAttempts.finish(operationLease, { error: message(failure), uncertain: failure instanceof ProductionCompletionError && failure.kind === 'uncertain' || !(failure instanceof ApiError || failure instanceof ProductionCompletionError) })
      activeOperation.current = null
      if (failure instanceof ProductionCompletionError) await publish(failure.snapshot, current)
      if (!current()) return
      setError(message(failure)); setReview(null)
      if (productionCompletionAttempts.get(scope, orderId)?.phase === 'uncertain') setForm(null)
      if (failure instanceof ApiError && failure.status === 403 || failure instanceof ProductionCompletionError && failure.kind === 'forbidden') { setBlocked(true); setForm(null) }
      if (failure instanceof ProductionCompletionError && failure.kind === 'conflict' || failure instanceof ApiError && failure.status === 409) invalidate()
    } finally {
      productionCompletionAttempts.interrupt(operationLease)
      if (activeOperation.current === operationLease) activeOperation.current = null
      if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }; mutationScope.finish(lease)
    }
  }
  const policy = form?.policy, atomic = policy?.operation === 'laminate' && policy.fullReport, cut = policy?.operation === 'cut', closing = Boolean(policy?.closingBatchId)
  const output = policy && !cut && !closing, waste = policy?.operation === 'print' || atomic || cut && (policy.fullReport || policy.cutWasteOnly)
  const needsInput = policy && !atomic && !closing && (cut && !(Array.isArray(policy.control.rezka_input_lineage) && policy.control.rezka_input_lineage.length) || Boolean(policy.control.previous_stage) && policy.operation === 'print')
  return <section aria-label="Bosqichni tugatish hisoboti" className="space-y-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h3 className="text-sm font-semibold">Bosqichni tugatish hisoboti</h3><p className="text-xs text-muted-foreground">Buyurtma № {orderLabel}. Natijalar serverning aniq bosqich va rulon oqimiga yoziladi.</p></div><Button variant="outline" size="sm" disabled={busy || snapshot.isFetching} onClick={() => void refresh()}><RefreshCw className={snapshot.isFetching ? 'animate-spin' : undefined} />Yangilash</Button></div>
    {displayedError && <Alert variant={attempt?.phase === 'uncertain' ? 'default' : 'destructive'}><TriangleAlert /><AlertTitle>{attempt?.phase === 'uncertain' ? 'Tugatish hisoboti natijasi noaniq' : 'Hisobot tasdiqlanmadi'}</AlertTitle><AlertDescription>{displayedError}{attempt?.phase === 'uncertain' && <><span>{attempt.plan.policy.title} · {attempt.plan.policy.name}</span>{attempt.plan.keyed && <Button variant="outline" size="sm" className="mt-2 self-start" disabled={busy || blocked || connection !== 'online'} onClick={() => void submit(true)}>Aynan shu hisobotni tiklash</Button>}<span>Oddiy yangilash yoki oynani yopish avvalgi so‘rovni bekor qilmaydi.</span></>}</AlertDescription></Alert>}
    {operation && operation.channel !== 'completion' && <Alert><AlertDescription>Shu buyurtmada boshqa ishlab chiqarish amali tekshirilmoqda. Uning natijasi aniqlanguncha tugatish hisoboti yopiq.</AlertDescription></Alert>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {(snapshot.isError || apparatus.isError || connection === 'offline') && <Alert><AlertDescription>{connection === 'offline' ? 'Aloqa uzilgan. Server holati yangilangach hisobot ochiladi.' : message(snapshot.error || apparatus.error)}</AlertDescription></Alert>}
    {demo && <p className="text-xs text-muted-foreground">Namuna rejimida tugatish hisoboti yuborilmaydi.</p>}
    {snapshot.isPending || apparatus.isPending ? <Skeleton className="h-20" /> : policies.length ? <div className="space-y-3">{policies.map(value => <div key={value.apparatusId} className="flex flex-wrap items-start justify-between gap-3 rounded-md bg-muted/30 p-3"><div className="space-y-1"><p className="text-sm font-medium">{value.title}</p><p className="text-xs text-muted-foreground">{value.name} · {value.stageNodeId}</p><p className="text-xs text-muted-foreground">{value.reason || (value.closingBatchId ? 'Oldin saqlangan Bosma chiqishi uchun yopish hisobi' : value.fullReport ? 'Chiqish va yakuniy sarf hisobi talab qilinmoqda' : 'Hozirgi rulon chiqishini qayd etish; oldingi bosqichda WIP hali davom etishi mumkin')}</p></div><Button variant="outline" size="sm" disabled={!canOpen || !value.allowed} onClick={() => void open(value)}><ClipboardCheck />{value.closingBatchId ? 'Bosma yopish hisobi' : 'Tugatish hisobotini kiritish'}</Button></div>)}</div> : <p className="text-sm text-muted-foreground">Tanlangan buyurtmaning hisobot bosqichlari to‘liq olinmagan.</p>}
    {result && <ProductionCompletionResultView result={result} />}
    <Dialog open={Boolean(form)} onOpenChange={opened => { if (!opened) close() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader><DialogTitle>{closing ? 'Bosma yopish hisobi' : 'Bosqichni tugatish hisoboti'}</DialogTitle><DialogDescription>Buyurtma № {orderLabel} · {policy?.title} · {policy?.name}. {closing ? 'Hisob oldin saqlangan chiqishga bog‘lanadi; yangi rulon yaratilmaydi.' : atomic ? 'Har bir jismoniy qatlam qoldig‘i va chiqish hisoboti native atomik amal bilan saqlanadi.' : cut ? 'Slotlar va oldin saqlangan rulonlar aynan joriy server sikliga tegishli.' : 'Haqiqiy chiqish va sarf miqdorlarini kiriting. Buyurtmaning umumiy tugashi server holatida alohida ko‘rsatiladi.'}</DialogDescription></DialogHeader>
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {output && <div className="grid gap-3 sm:grid-cols-3">{([['metres', 'Rulon uzunligi, m'], ['grossKg', 'Brutto og‘irligi, kg'], ['tareKg', 'Bobina og‘irligi, kg']] as const).map(([key, label]) => <div key={key} className="space-y-2"><Label htmlFor={`completion-${key}`}>{label}</Label><Input id={`completion-${key}`} type="number" min="0" step="any" value={draft[key]} disabled={busy} onChange={event => change({ ...draft, [key]: event.target.value })} /></div>)}</div>}
      {waste && <div className="space-y-2"><Label htmlFor="completion-waste">Umumiy chiqindi, kg</Label><Input id="completion-waste" type="number" min="0" step="any" value={draft.waste} disabled={busy} onChange={event => change({ ...draft, waste: event.target.value })} /><p className="text-xs text-muted-foreground">Bo‘sh maydon nol sifatida yuborilmaydi. Bosmaning oddiy tugatishida haqiqiy nol chiqindi izoh va tasdiqlash so‘rovi orqali qayd etiladi.</p></div>}
      {needsInput && <div className="space-y-2"><Label htmlFor="completion-input">Ulangan kirish WIP partiyasi</Label><Input id="completion-input" value={draft.inputBatchId} maxLength={512} disabled={busy} onChange={event => change({ ...draft, inputBatchId: event.target.value })} /></div>}
      {policy?.operation === 'print' && <fieldset className="space-y-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">Bo‘yoq sarfi va qoldig‘i</legend><p className="text-xs text-muted-foreground">Rasxot va astatka uchun kamida uchtadan haqiqiy qiymat talab qilinadi. Qiymatlar kilogrammda yoziladi.</p>{draft.paint.map((paint, index) => <div key={index} className="space-y-2 rounded-md border p-2"><div className="flex items-center justify-between"><Badge variant="outline">{paint.usage === 'rasxot' ? 'Rasxot' : 'Astatka'}</Badge><Button variant="ghost" size="icon-sm" aria-label={`${index + 1}-bo‘yoq maydonini olib tashlash`} disabled={busy} onClick={() => change({ ...draft, paint: draft.paint.filter((_, at) => at !== index) })}><X /></Button></div><div className="grid gap-2 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor={`paint-category-${index}`}>Kategoriya</Label><Select value={paint.category} disabled={busy} onValueChange={value => change({ ...draft, paint: draft.paint.map((entry, at) => at === index ? { ...entry, category: value as CompletionPaintField['category'] } : entry) })}><SelectTrigger id={`paint-category-${index}`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="colors">Bo‘yoq</SelectItem><SelectItem value="lacquers">Lak</SelectItem><SelectItem value="solvents">Erituvchi</SelectItem></SelectContent></Select></div>{([['name', 'Nomi'], ['label', 'Qiymat yorlig‘i'], ['value', 'Miqdor, kg']] as const).map(([key, label]) => <div key={key} className="space-y-1"><Label htmlFor={`paint-${key}-${index}`}>{label}</Label><Input id={`paint-${key}-${index}`} value={paint[key]} disabled={busy} maxLength={key === 'value' ? 48 : 200} onChange={event => change({ ...draft, paint: draft.paint.map((entry, at) => at === index ? { ...entry, [key]: event.target.value } : entry) })} /></div>)}</div></div>)}<div className="flex flex-wrap gap-2">{(['rasxot', 'astatka'] as const).map(usage => <Button key={usage} type="button" size="sm" variant="outline" disabled={busy || draft.paint.length >= 128} onClick={() => change({ ...draft, paint: [...draft.paint, { usage, category: 'colors', name: '', label: '', value: '' }] })}><Plus />{usage === 'rasxot' ? 'Rasxot maydoni' : 'Astatka maydoni'}</Button>)}</div></fieldset>}
      {atomic && <fieldset className="space-y-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">Jismoniy qatlamlar qoldig‘i</legend>{form?.context.sources.map(source => { const key = `${source.source_kind}:${source.source_id}`; return <div key={key} className="space-y-2"><Label htmlFor={`layer-${key}`}>{text(source.item_name || source.source_id)} · {source.source_net_kg} kg kirish</Label><Input id={`layer-${key}`} type="number" min="0" max={source.source_net_kg} step="any" value={draft.layers[key] ?? ''} disabled={busy} onChange={event => change({ ...draft, layers: { ...draft.layers, [key]: event.target.value } })} /><p className="text-xs text-muted-foreground">{source.source_kind === 'progress_batch' ? 'Bosma WIP' : 'Xomashyo'} · {source.source_id}. Qoldiq yo‘q bo‘lsa, aniq 0 kiriting.</p></div> })}</fieldset>}
      {cut && <div className="space-y-3">{draft.frames.map((frame, index) => { const saved = form?.context.cut?.saved.find(slot => slot.frame_index === index + 1); return <fieldset key={index} className="space-y-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">{index + 1}-chiqish ruloni · {form?.context.cut?.counts[index]} kadr</legend>{saved && <p className="text-xs text-muted-foreground">Oldin saqlangan slot · {text(saved.batch_id || 'muammo qaydi')}. Asl miqdor va QR saqlanadi.</p>}<div className="grid gap-3 sm:grid-cols-2">{([['metres', 'Uzunligi, m'], ['grossKg', 'Brutto, kg'], ['tareKg', 'Bobina, kg'], ['diameter', 'Diametr']] as const).map(([key, label]) => <div key={key} className="space-y-1"><Label htmlFor={`completion-frame-${index}-${key}`}>{label}</Label><Input id={`completion-frame-${index}-${key}`} type="number" min="0" step="any" value={frame[key]} disabled={busy || Boolean(saved)} onChange={event => change({ ...draft, frames: draft.frames.map((entry, at) => at === index ? { ...entry, [key]: event.target.value } : entry) })} /></div>)}</div><div className="space-y-2"><Label htmlFor={`completion-frame-${index}-issue`}>Mahsulot chiqmagan slot uchun izoh</Label><Textarea id={`completion-frame-${index}-issue`} value={frame.issueNote} disabled={busy || Boolean(saved)} maxLength={2000} onChange={event => change({ ...draft, frames: draft.frames.map((entry, at) => at === index ? { ...entry, issueNote: event.target.value } : entry) })} /><p className="text-xs text-muted-foreground">Muammoli slotda miqdor maydonlarini bo‘sh qoldiring. Unga soxta nol rulon yozilmaydi.</p></div></fieldset> })}</div>}
      <div className="space-y-2"><Label htmlFor="completion-description">Hisobot izohi{draft.waste === '0' && policy?.operation === 'print' && !closing ? ' · majburiy' : ' (ixtiyoriy)'}</Label><Textarea id="completion-description" value={draft.description} disabled={busy} maxLength={2000} onChange={event => change({ ...draft, description: event.target.value })} /></div>
      {review && <Alert><Check /><AlertTitle>Hisobot tekshirildi</AlertTitle><AlertDescription><ul className="space-y-1">{review.proof.summary.map(value => <li key={value}>{value}</li>)}</ul>{review.plan.expectedApproval && <span>Yakuniy tasdiqda ishlab chiqarish tugatilmaydi; tasdiqlash so‘rovi yaratiladi.</span>}<span>Yorliq ma’lumotlari biznes hisobot saqlangach tayyorlanadi.</span></AlertDescription></Alert>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Keyinroq davom ettirish</Button><Button disabled={busy || blocked || connection !== 'online'} onClick={() => review ? void submit() : void prepare()}>{busy && <Loader2 className="animate-spin" />}{busy ? 'Server tekshirmoqda…' : review ? review.plan.expectedApproval ? 'Tasdiqlash so‘rovini yuborish' : 'Hisobotni saqlash' : 'Hisobotni tekshirish'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
