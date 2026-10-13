import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardCheck, Loader2, Play, RefreshCw, Route, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, isRecord, text } from '@/lib/api'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { MutationScope } from '@/lib/mutation-scope'
import { canViewPage } from '@/lib/permissions'
import { productionControlOrderId } from '@/lib/production-controls'
import { checkProductionAssignmentInputs, executeProductionAssignment, ProductionAssignmentError, productionAssignmentAttempts, productionAssignmentCommand, productionAssignmentLabels, productionAssignmentPolicies, readProductionAssignmentOutcome } from '@/lib/production-assignment'
import type { ProductionAssignmentAction, ProductionAssignmentAttemptLease, ProductionAssignmentCommand, ProductionAssignmentInput, ProductionAssignmentPolicy, ProductionAssignmentProof } from '@/lib/production-assignment'
import { useSession } from '@/lib/session'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

interface Form { action: ProductionAssignmentAction; policy: ProductionAssignmentPolicy; snapshot: ProductionSnapshot; apparatusRows: Row[] }
interface Review { plan: ProductionAssignmentCommand; proof: ProductionAssignmentProof }
const message = (error: unknown) => error instanceof Error ? error.message : 'Amal yoki kirish ma’lumotlari tasdiqlanmadi.'
const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)

export function ProductionAssignmentControls({ row }: { row: Row }) {
  const { scope } = useSession(), orderId = productionControlOrderId(row)
  productionAssignmentAttempts.activate(scope)
  return <AssignmentPanel key={`${scope}:${orderId}`} row={row} orderId={orderId} />
}
function AssignmentPanel({ row, orderId }: { row: Row; orderId: string }) {
  const { client, session, scope, demo, connection, reconnect } = useSession()
  const queryClient = useQueryClient(), queryKey = [scope, 'production-snapshot']
  const snapshot = useQuery({ queryKey, queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'orders'))), retry: false, staleTime: 5000, refetchInterval: demo ? false : 15000 })
  const apparatus = useQuery({ queryKey: [scope, 'production-control-apparatus'], queryFn: ({ signal }) => demo ? Promise.resolve(getDemoPage('apparatus', { limit: 500 })) : client!.listSnapshot('apparatus', { limit: 500 }, signal),
    enabled: Boolean(orderId && (demo || client && canViewPage(session, 'apparatus'))), retry: false, staleTime: 60000 })
  const mutationScope = useMemo(() => new MutationScope(), []), pending = useRef(false), identity = useRef({ client, session, scope, orderId })
  const activeAttempt = useRef<ProductionAssignmentAttemptLease | null>(null)
  useSyncExternalStore(productionAssignmentAttempts.subscribe, productionAssignmentAttempts.getRevision, productionAssignmentAttempts.getRevision)
  const attempt = productionAssignmentAttempts.get(scope, orderId), uncertain = attempt?.phase === 'uncertain' ? attempt : null
  const orderAttempt = productionOperationLedger.get(scope, orderId)
  identity.current = { client, session, scope, orderId }
  const [busy, setBusy] = useState(false), [form, setForm] = useState<Form | null>(null), [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState(''), [blocked, setBlocked] = useState(false), [draft, setDraft] = useState<ProductionAssignmentInput>({})
  const [materials, setMaterials] = useState(''), [qolips, setQolips] = useState('')
  useEffect(() => () => {
    mutationScope.cancelAll()
    if (activeAttempt.current) productionAssignmentAttempts.interrupt(activeAttempt.current)
    activeAttempt.current = null
  }, [mutationScope])
  useEffect(() => {
    mutationScope.cancelAll()
    if (activeAttempt.current) productionAssignmentAttempts.interrupt(activeAttempt.current)
    activeAttempt.current = null
    pending.current = false; setBusy(false); setForm(null); setReview(null)
    // Reconnect replaces the verified session/client and cancels the old read
    // lease. Its previous permission refusal must not keep this panel locked;
    // the order ledger still retains every dispatched unresolved command.
    setBlocked(false)
  }, [client, session, mutationScope])
  const policies = productionAssignmentPolicies(snapshot.data, orderId, session, apparatus.data?.items)
  const fresh = Boolean(snapshot.data && !snapshot.isError && Date.now() - snapshot.dataUpdatedAt < 30000)
  const canChange = !demo && Boolean(client) && fresh && !snapshot.isFetching && !apparatus.isError && !apparatus.isFetching && !busy && !orderAttempt && !blocked && connection !== 'offline'
  const displayedError = uncertain?.error || error
  const map = isRecord(row.map) ? row.map : row, orderLabel = text(map.order_number || map.code || orderId)
  function change(field: keyof ProductionAssignmentInput, value: string) { setDraft(before => ({ ...before, [field]: value })); setReview(null) }
  function open(policy: ProductionAssignmentPolicy, action: ProductionAssignmentAction) {
    if (!canChange || !snapshot.data) return
    setForm({ action, policy, snapshot: snapshot.data, apparatusRows: apparatus.data?.items ?? [] }); setReview(null); setDraft({}); setMaterials(''); setQolips(''); setError('')
  }
  async function publish(value: ProductionSnapshot | undefined, current: () => boolean) {
    if (!value || !current()) return
    await queryClient.cancelQueries({ queryKey, exact: true }); if (!current()) return
    queryClient.setQueryData<ProductionSnapshot>(queryKey, before => before && (before.epoch !== value.epoch || before.scope !== value.scope || before.rev > value.rev) ? before : value)
  }
  function invalidate() { void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) && query.queryKey.some(part => typeof part === 'string' && ['production-snapshot', 'orders', 'maps', 'wip', 'raw-materials', 'dashboard', 'manufacturing-batches', 'manufacturing-report'].includes(part)) }) }
  async function refresh() {
    if (busy) return
    const lease = mutationScope.begin()
    try {
      if (connection === 'offline' || blocked) await reconnect()
      if (!mutationScope.isCurrent(lease)) return
      const result = await snapshot.refetch(); if (!mutationScope.isCurrent(lease)) return
      void apparatus.refetch()
      if (result.isSuccess) { setError(''); setBlocked(false); setReview(null); setForm(null) }
    } finally { mutationScope.finish(lease) }
  }
  async function prepare() {
    if (!client || demo || !form || pending.current || !canChange) return
    let plan: ProductionAssignmentCommand
    let attemptLease: ProductionAssignmentAttemptLease
    try {
      plan = productionAssignmentCommand(form.snapshot, orderId, session, form.apparatusRows, form.policy.apparatusId, form.action, { ...draft, materialBarcodes: lines(materials), qolipCodes: lines(qolips) })
      attemptLease = productionAssignmentAttempts.begin(scope, plan, { summary: [], sessionId: '', batchId: '' })
    }
    catch (failure) { setError(message(failure)); return }
    activeAttempt.current = attemptLease
    const lease = mutationScope.begin(), captured = identity.current
    const current = () => mutationScope.isCurrent(lease) && identity.current.client === captured.client && identity.current.session === captured.session && identity.current.scope === captured.scope && identity.current.orderId === captured.orderId
    pending.current = true; setBusy(true); setError('')
    try { const proof = await checkProductionAssignmentInputs(client, plan, lease.controller.signal, current); if (current()) setReview({ plan, proof }) }
    catch (failure) { if (current()) { setError(message(failure)); if (failure instanceof ApiError && failure.status === 403) setBlocked(true) } }
    finally {
      // This validation phase has not sent a business mutation. Releasing its
      // reservation leaves a reviewed draft; confirmation reserves afresh.
      productionAssignmentAttempts.interrupt(attemptLease)
      if (activeAttempt.current === attemptLease) activeAttempt.current = null
      if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }
      mutationScope.finish(lease)
    }
  }
  async function run(recovery?: Review) {
    const chosen = recovery ?? review
    if (!client || demo || !chosen || pending.current || connection === 'offline' || blocked || !recovery && !canChange) return
    let attemptLease: ProductionAssignmentAttemptLease
    try { attemptLease = productionAssignmentAttempts.begin(scope, chosen.plan, chosen.proof, Boolean(recovery)) }
    catch (failure) { setError(message(failure)); return }
    activeAttempt.current = attemptLease
    const lease = mutationScope.begin(), captured = identity.current
    const current = () => mutationScope.isCurrent(lease) && identity.current.client === captured.client && identity.current.session === captured.session && identity.current.scope === captured.scope && identity.current.orderId === captured.orderId
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await executeProductionAssignment(client, session, chosen.plan, lease.controller.signal, current, recovery?.proof, () => {
        if (!productionAssignmentAttempts.dispatched(attemptLease)) throw new DOMException('Amalning buyurtma doirasi o‘zgargan.', 'AbortError')
      })
      productionAssignmentAttempts.finish(attemptLease, { confirmed: true })
      if (!current()) return
      await publish(result.snapshot, current); if (!current()) return
      setForm(null); setReview(null); toast.success(result.message); invalidate()
      if (!result.snapshot) setError('Amal tasdiqlandi. Joriy holat hali olinmadi; ma’lumotlarni yangilang.')
    } catch (failure) {
      if (!current()) { productionAssignmentAttempts.interrupt(attemptLease); return }
      productionAssignmentAttempts.finish(attemptLease, { error: message(failure), uncertain: failure instanceof ProductionAssignmentError && failure.kind === 'uncertain' || !(failure instanceof ApiError || failure instanceof ProductionAssignmentError) })
      if (failure instanceof ProductionAssignmentError) await publish(failure.snapshot, current)
      if (!current()) return
      setError(message(failure))
      if (failure instanceof ProductionAssignmentError && failure.kind === 'uncertain') { setForm(null); setReview(null) }
      if (failure instanceof ApiError && failure.status === 409 || failure instanceof ProductionAssignmentError && failure.kind === 'conflict') { setForm(null); setReview(null); invalidate() }
      if (failure instanceof ApiError && failure.status === 403 || failure instanceof ProductionAssignmentError && failure.kind === 'forbidden') { setBlocked(true); setForm(null); setReview(null) }
    } finally {
      productionAssignmentAttempts.interrupt(attemptLease)
      if (activeAttempt.current === attemptLease) activeAttempt.current = null
      if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }
      mutationScope.finish(lease)
    }
  }
  async function observe() {
    if (!client || demo || !uncertain || pending.current || connection === 'offline' || blocked) return
    let attemptLease: ProductionAssignmentAttemptLease
    try { attemptLease = productionAssignmentAttempts.begin(scope, uncertain.plan, uncertain.proof, true) }
    catch (failure) { setError(message(failure)); return }
    activeAttempt.current = attemptLease
    const lease = mutationScope.begin(), captured = identity.current
    const current = () => mutationScope.isCurrent(lease) && identity.current.client === captured.client && identity.current.session === captured.session && identity.current.scope === captured.scope && identity.current.orderId === captured.orderId
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await readProductionAssignmentOutcome(client, session, uncertain.plan, uncertain.proof, lease.controller.signal, current)
      if (result) {
        productionAssignmentAttempts.finish(attemptLease, { confirmed: true })
        if (!current()) return
        await publish(result.snapshot, current); if (!current()) return
        toast.success(result.message); invalidate()
      } else productionAssignmentAttempts.finish(attemptLease, { uncertain: true, error: uncertain.plan.action === 'handoff' ? 'Joriy ro‘yxat topshirish hisoboti va aniq miqdorlarni qayta tasdiqlamaydi. Avvalgi amal saqlanmoqda; yangi topshirish yuborilmadi.' : 'Joriy server holati aynan avvalgi amal natijasini tasdiqlamadi. Buyruq saqlanmoqda; yangi amal yuborilmadi.' })
    } catch (failure) {
      productionAssignmentAttempts.finish(attemptLease, { uncertain: true, error: message(failure) })
      if (current() && failure instanceof ApiError && failure.status === 403) setBlocked(true)
    } finally {
      productionAssignmentAttempts.interrupt(attemptLease)
      if (activeAttempt.current === attemptLease) activeAttempt.current = null
      if (mutationScope.isCurrent(lease)) { pending.current = false; setBusy(false) }
      mutationScope.finish(lease)
    }
  }
  const interaction = form && isRecord(form.policy.control.interaction) ? form.policy.control.interaction : {}
  const moving = form?.action === 'assign' || form?.action === 'transfer', start = form?.action === 'start', handoff = form?.action === 'handoff'
  const inputWip = start && (interaction.previous_wip_mode === 'scan_required' || interaction.opening_wip_mode === 'scan_required')
  return <section aria-label="Bosqichni tayyorlash va ishni boshlash" className="space-y-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h3 className="text-sm font-semibold">Bosqichni tayyorlash va ishni boshlash</h3><p className="text-xs text-muted-foreground">Buyurtma № {orderLabel}. Amallar server ko‘rsatgan uskuna va aniq bosqichga tegishli.</p></div><Button variant="outline" size="sm" disabled={busy || snapshot.isFetching} onClick={() => void refresh()}><RefreshCw className={snapshot.isFetching ? 'animate-spin' : undefined} />Yangilash</Button></div>
    {displayedError && <Alert variant={uncertain ? 'default' : 'destructive'}><TriangleAlert /><AlertTitle>{uncertain ? 'Amal natijasi noaniq' : 'Ma’lumot yoki amal tasdiqlanmadi'}</AlertTitle><AlertDescription>{displayedError}{uncertain && <><span>{productionAssignmentLabels[uncertain.plan.action]} · {uncertain.plan.policy.stageTitle} · {uncertain.plan.policy.name}</span><Button className="mt-2 self-start" variant="outline" size="sm" disabled={busy || blocked || connection === 'offline'} onClick={() => uncertain.plan.replayable ? void run(uncertain) : void observe()}>{uncertain.plan.replayable ? 'Bir xil buyruq natijasini tekshirish' : 'Holatni qayta tekshirish'}</Button><span>Oddiy yangilash yoki oynani yopish avvalgi buyruqni bekor qilmaydi.</span></>}</AlertDescription></Alert>}
    {attempt?.phase === 'pending' && <p role="status" className="text-xs text-muted-foreground">Bosqich amali tekshirilmoqda. Shu buyurtmani boshlash, topshirish va uskunani almashtirish amallari natija aniqlanguncha yopiq.</p>}
    {orderAttempt && orderAttempt.channel !== 'assignment' && <Alert><AlertDescription>Shu buyurtmaning boshqa ishlab chiqarish amali natijasi kutilmoqda. Boshlash, topshirish va uskuna almashtirish avvalgi natija aniqlanguncha yopiq.</AlertDescription></Alert>}
    {(snapshot.isError || apparatus.isError || connection === 'offline') && <Alert><AlertDescription>{connection === 'offline' ? 'Aloqa uzilgan. Joriy holat yangilangach amallar ochiladi.' : message(snapshot.error || apparatus.error)}</AlertDescription></Alert>}
    {demo && <p className="text-xs text-muted-foreground">Namuna rejimida ishlab chiqarish amallari yuborilmaydi.</p>}
    {snapshot.isPending || apparatus.isPending ? <Skeleton className="h-20" /> : policies.length ? <div className="space-y-3">{policies.map(policy => <div key={policy.apparatusId} className="space-y-3 rounded-md bg-muted/30 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-medium">{policy.stageTitle}</p><p className="mt-1 text-xs text-muted-foreground">{policy.name} · {policy.stageNodeId}</p></div><Badge variant="outline">{policy.statusLabel}</Badge></div><div className="flex flex-wrap gap-2">{policy.actions.map(action => <Button key={action} variant={action === 'start' ? 'secondary' : 'outline'} size="sm" disabled={!canChange} onClick={() => open(policy, action)}>{action === 'start' ? <Play /> : action === 'assign' || action === 'transfer' ? <Route /> : <ClipboardCheck />}{productionAssignmentLabels[action]}</Button>)}</div>{policy.reason && <p className="text-xs text-muted-foreground">{policy.reason}</p>}{!policy.actions.length && !policy.reason && <p className="text-xs text-muted-foreground">Server shu bosqich uchun boshlash yoki ko‘chirish amalini bermagan.</p>}</div>)}</div> : <p className="text-sm text-muted-foreground">Tanlangan buyurtmaning boshqariladigan bosqichlari olinmagan.</p>}
    <Dialog open={Boolean(form)} onOpenChange={opened => { if (!opened && !busy) { setForm(null); setReview(null) } }}><DialogContent className="max-h-[90svh] overflow-y-auto" showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader><DialogTitle>{form ? productionAssignmentLabels[form.action] : 'Amalni tekshirish'}</DialogTitle><DialogDescription>Buyurtma № {orderLabel} · {form?.policy.stageTitle} · {form?.policy.name}. {moving ? form.action === 'transfer' ? 'To‘xtatilgan ish bilan birga sessiya, WIP va material biriktirish holati ko‘chadi. Ishni davom ettirish alohida amal.' : 'Boshlanmagan bosqichning uskuna biriktirishi o‘zgaradi. Bosqichlar va bog‘lanishlar saqlanadi.' : handoff ? 'Ulangan kirish WIP uskunada qoladi. Ish pauzaga o‘tadi; keyingi operator davom ettirish oqimidan foydalanadi.' : start ? 'Haqiqiy material, qolip va kirish WIP talablarini tekshiring. Boshlashda server ularni yana tekshiradi.' : 'Rang sinovi ishlab chiqarish materiali va qolip skanini talab qilmaydi. Sinov natijasini haqiqiy tekshiruvga ko‘ra tasdiqlang.'}</DialogDescription></DialogHeader>
      {moving && <div className="space-y-2"><Label htmlFor="assignment-target">Yangi uskuna nomzodi</Label><Select value={draft.targetId ?? ''} onValueChange={value => change('targetId', value)} disabled={busy}><SelectTrigger id="assignment-target" className="w-full"><SelectValue placeholder="Uskunani tanlang" /></SelectTrigger><SelectContent>{(form?.action === 'assign' ? form.policy.targets : form?.policy.transferTargets ?? []).map(target => <SelectItem key={target.id} value={target.id}>{target.name}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Buyurtmaning o‘lcham va texnologiyaga mosligini server yakuniy amal vaqtida tekshiradi.</p></div>}
      {(form?.action === 'transfer' || handoff || inputWip) && <div className="space-y-2"><Label htmlFor="assignment-batch">{handoff ? 'Ulangan kirish WIP partiyasi' : form?.action === 'transfer' ? 'To‘xtatish hisobotining WIP partiyasi' : 'Kirish WIP partiyasi (QR bo‘lsa ixtiyoriy)'}</Label><Input id="assignment-batch" value={draft.batchId ?? ''} onChange={event => change('batchId', event.target.value)} maxLength={512} disabled={busy} /></div>}
      {inputWip && <div className="space-y-2"><Label htmlFor="assignment-qr">{interaction.opening_wip_mode === 'scan_required' ? 'Boshlang‘ich WIP QR kodi' : 'Kirish WIP QR kodi (partiya IDsi bo‘lsa ixtiyoriy)'}</Label><Textarea id="assignment-qr" value={draft.qr ?? ''} onChange={event => change('qr', event.target.value)} maxLength={8192} disabled={busy} /></div>}
      {start && interaction.material_scan_required === true && <div className="space-y-2"><Label htmlFor="assignment-materials">Xomashyo shtrixkodlari · har qatorda bittadan</Label><Textarea id="assignment-materials" value={materials} onChange={event => { setMaterials(event.target.value); setReview(null) }} disabled={busy} /></div>}
      {start && interaction.qolip_mode === 'scan_required' && <div className="space-y-2"><Label htmlFor="assignment-qolips">Qolip kodlari · har qatorda bittadan</Label><Textarea id="assignment-qolips" value={qolips} onChange={event => { setQolips(event.target.value); setReview(null) }} disabled={busy} /></div>}
      {handoff && <fieldset className="space-y-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">Laminatsiya topshirish hisoboti</legend><div className="grid gap-3 sm:grid-cols-2">{([['printLeftover', 'Bosma qoldiq rulonlari'], ['filmLeftover', 'Plyonka qoldiq rulonlari'], ['totalWaste', 'Umumiy chiqindi, kg']] as const).map(([field, label]) => <div key={field} className="space-y-2"><Label htmlFor={`assignment-${field}`}>{label}</Label><Input id={`assignment-${field}`} type="number" step="any" min="0" value={draft[field] ?? ''} onChange={event => change(field, event.target.value)} disabled={busy} /></div>)}</div><p className="text-xs text-muted-foreground">Nol haqiqiy natija bo‘lsa, uni aniq kiriting. Bo‘sh maydon nol sifatida yuborilmaydi.</p></fieldset>}
      {(form?.action === 'transfer' || handoff) && <div className="space-y-2"><Label htmlFor="assignment-reason">{handoff ? 'Izoh (ixtiyoriy)' : 'Ko‘chirish sababi'}</Label><Textarea id="assignment-reason" value={draft.reason ?? ''} onChange={event => change('reason', event.target.value)} disabled={busy} maxLength={4000} /></div>}
      {review && <Alert><Check /><AlertTitle>Kirish ma’lumotlari tekshirildi</AlertTitle><AlertDescription>{review.proof.summary.length ? <ul className="space-y-1">{review.proof.summary.map(value => <li key={value}>{value}</li>)}</ul> : 'Tanlangan amal va uskuna qayta ko‘rib chiqishga tayyor.'} Yakuniy tasdiqda server holat va ruxsatlarni yana tekshiradi.</AlertDescription></Alert>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setForm(null); setReview(null) }}>Bekor qilish</Button><Button disabled={busy || blocked || connection === 'offline' || !canChange} onClick={() => review ? void run() : void prepare()}>{busy && <Loader2 className="animate-spin" />}{busy ? 'Server tekshirmoqda…' : review ? 'Tasdiqlash' : 'Kirish ma’lumotlarini tekshirish'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
