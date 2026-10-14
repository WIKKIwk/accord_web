import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { PaddonManagementApi, PaddonManagementConflict, PaddonManagementUnknown, canManagePaddonManagement, canReadPaddonManagement, freeMovementOperation, paddonManagementError, paddonManagementIntentLedger } from '@/lib/paddon-management'
import type { PaddonManagementIntent, PaddonManagementOperation, PaddonManagementSettings } from '@/lib/paddon-management'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'

const movementImpact = 'Erkin harakat mavjud ko‘rinish doirasida omborga qabul qilinmagan, ko‘chirishga yaroqli rulonlarni paddonlar orasida o‘tkazishga imkon beradi; qabul qilingan mahsulotlar ko‘chirilmaydi.'
const emptyIntent = (): PaddonManagementIntent | null => null
const noSubscribe = (): (() => void) => () => {}
const valueLabel = (enabled: boolean): string => enabled ? 'Yoqilgan' : 'O‘chirilgan'
const denied = (error: unknown): boolean => error instanceof ApiError && [401, 403].includes(error.status)
function canEdit(session: Session | null | undefined): boolean { return canManagePaddonManagement(session) && !!session?.profile.ref?.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') }
function ManagementError({ error }: { error: unknown }) { return error ? <Alert variant="destructive"><AlertDescription>{paddonManagementError(error)}</AlertDescription></Alert> : null }

export function PaddonManagementToolbar() {
  const { session, scope, demo } = useSession(), [openScope, setOpenScope] = useState<string | null>(null), trigger = useRef<HTMLButtonElement>(null)
  const ledger = useMemo(() => scope && canReadPaddonManagement(session) ? paddonManagementIntentLedger(scope) : null, [scope, session])
  const intent = useSyncExternalStore(ledger?.subscribe ?? noSubscribe, ledger?.snapshot ?? emptyIntent, ledger?.snapshot ?? emptyIntent)
  useEffect(() => {
    if (!intent?.dispatched) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [intent?.dispatched, scope])
  if (!ledger || !canReadPaddonManagement(session)) return null
  return <><Button ref={trigger} variant="outline" disabled={demo} title={demo ? 'Ko‘rish rejimida paddon sozlamalari o‘zgarmaydi.' : undefined} onClick={() => setOpenScope(scope)}><Settings2 />Paddon sozlamalari{intent && <Badge variant="secondary">{intent.status === 'unknown' ? 'Tekshirish kerak' : 'Saqlanmoqda'}</Badge>}</Button>{openScope === scope && !demo && <PaddonManagementDialog key={scope} onClose={() => setOpenScope(null)} onReturnFocus={() => trigger.current?.focus()} />}</>
}

export function PaddonManagementStateView({ settings, title = 'Serverdagi joriy holat' }: { settings: PaddonManagementSettings; title?: string }) {
  return <section className="space-y-3 rounded-lg border bg-muted/20 p-3" aria-label={title}><h3 className="text-sm font-semibold">{title}</h3><dl className="space-y-2 text-sm"><div className="flex items-center justify-between gap-3"><dt>Erkin harakat</dt><dd><Badge variant="outline">{valueLabel(settings.free_movement_enabled)}</Badge></dd></div><div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><dt>Ishchi ko‘rinishi (faqat ma’lumot)</dt><dd>{valueLabel(settings.worker_visibility_enabled)}</dd></div></dl></section>
}

export function PaddonManagementReadState({ loading, settings, error, canRetry, refreshing, onRetry }: { loading: boolean; settings?: PaddonManagementSettings; error: unknown; canRetry: boolean; refreshing: boolean; onRetry: () => void }) {
  if (loading) return <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Paddon sozlamalari yuklanmoqda…</p>
  if (!error && settings) return <PaddonManagementStateView settings={settings} />
  return <div className="space-y-3"><ManagementError error={error} />{!error && <p className="text-sm text-muted-foreground">Paddon sozlamalari kelmadi. Joriy holatni qayta yuklang.</p>}{canRetry && !denied(error) && <Button variant="outline" disabled={refreshing} onClick={onRetry}><RefreshCw className={refreshing ? 'animate-spin' : ''} />Sozlamalarni qayta yuklash</Button>}</div>
}

export function PaddonFreeMovementReview({ settings, editable, desired, reviewed, disabled, onDesired, onReviewed }: { settings: PaddonManagementSettings; editable: boolean; desired: boolean; reviewed: boolean; disabled: boolean; onDesired: (enabled: boolean) => void; onReviewed: (reviewed: boolean) => void }) {
  const id = useId(), changed = desired !== settings.free_movement_enabled
  const changeImpact = desired ? 'Yoqish mavjud ko‘rinish va yozish ruxsatlari doirasida qabul qilinmagan bosilgan paddonlarni tahrirlash va qulf egasi bo‘lmasdan ochishga imkon beradi.' : 'O‘chirish bosilgan paddonlarni erkin tahrirlashni to‘xtatadi; qulfni ochish odatiy administrator yoki qulf egasi qoidalariga qaytadi.'
  return <section className="space-y-4"><p id={`${id}-impact`} className="text-sm leading-relaxed text-muted-foreground">{movementImpact}</p>{editable ? <><Label htmlFor={`${id}-movement`} className="flex items-start gap-3 rounded-lg border p-3"><Checkbox id={`${id}-movement`} checked={desired} disabled={disabled} aria-describedby={`${id}-impact`} onCheckedChange={next => onDesired(next === true)} /><span className="text-sm">Erkin harakatni yoqish</span></Label>{changed && <><p className="text-sm">{changeImpact}</p><Label htmlFor={`${id}-review`} className="flex items-start gap-3"><Checkbox id={`${id}-review`} checked={reviewed} disabled={disabled} onCheckedChange={next => onReviewed(next === true)} /><span className="text-sm leading-relaxed">Ko‘chirish, tahrirlash va qulfni ochish ta’sirini ko‘rdim va erkin harakatni {desired ? 'yoqishni' : 'o‘chirishni'} tasdiqlayman.</span></Label></>}</> : <p className="text-xs text-muted-foreground">Bu hisobda faqat ko‘rish mumkin. O‘zgartirish uchun administrator hisobi va ruxsati kerak.</p>}</section>
}

export function PaddonManagementRecovery({ intent, checking, canCheck, error, reviewed, onReviewed, onCheck }: { intent: PaddonManagementIntent; checking: boolean; canCheck: boolean; error: unknown; reviewed: boolean; onReviewed: (reviewed: boolean) => void; onCheck: () => void }) {
  const id = useId(), observation = intent.observation
  return <div className="space-y-4"><ManagementError error={new PaddonManagementUnknown(intent.operation)} /><section className="space-y-2 rounded-lg border p-3"><h3 className="text-sm font-semibold">Avval yuborilgan erkin harakat qiymati</h3><Badge variant="outline">{valueLabel(intent.operation.input.free_movement_enabled)}</Badge><p className="text-xs text-muted-foreground">Avvalgi erkin harakat: {valueLabel(intent.operation.baseline.free_movement_enabled)}</p></section><p className="text-sm text-muted-foreground">Asl so‘rov qayta yuborilmaydi. Tekshirish faqat serverdagi joriy holatni o‘qiydi.</p><p className="text-xs text-muted-foreground">Avvalgi amal shu sessiya xotirasida saqlanmoqda. Sahifani to‘liq yangilash yoki hisobdan chiqish bu ma’lumotni yo‘qotadi.</p><Button variant="outline" disabled={checking || !canCheck} onClick={onCheck}>{checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}{checking ? 'Tekshirilmoqda…' : 'Serverdagi joriy holatni tekshirish'}</Button><ManagementError error={error} />{observation && <><PaddonManagementStateView settings={observation.settings} /><p className="text-sm">{observation.state === 'matches' ? 'Joriy erkin harakat qiymati yuborilgan qiymatga mos.' : 'Joriy erkin harakat qiymati yuborilgan qiymatdan farq qiladi.'} Bu asl so‘rov natijasini yoki uni kim bajarganini tasdiqlamaydi.</p><Label htmlFor={`${id}-reviewed`} className="flex items-start gap-3"><Checkbox id={`${id}-reviewed`} checked={reviewed} disabled={checking || !!error} onCheckedChange={next => onReviewed(next === true)} /><span className="text-sm leading-relaxed">Avvalgi amal va joriy holatni ko‘rdim. Asl javob tasdiqlanmaganini tushunaman.</span></Label></>}</div>
}

export function PaddonManagementDialog({ onClose, onReturnFocus }: { onClose: () => void; onReturnFocus: () => void }) {
  const context = useSession(), { client, session, scope, demo, connection } = context, queryClient = useQueryClient()
  const live = useRef(true), current = useRef(context); current.current = context
  const api = useMemo(() => client && session && !demo && canReadPaddonManagement(session) ? new PaddonManagementApi(client, session, () => live.current && current.current.scope === scope && current.current.client === client && current.current.session === session && !current.current.demo) : null, [client, session, scope, demo])
  const ledger = useMemo(() => paddonManagementIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  const leases = useMemo(() => new MutationScope(), []), busy = useRef(false), activeOperation = useRef<PaddonManagementOperation | null>(null)
  const [desired, setDesired] = useState<boolean | null>(null), [reviewed, setReviewed] = useState(false), [recoveryReviewed, setRecoveryReviewed] = useState(false), [error, setError] = useState<unknown>(null), [checking, setChecking] = useState(false)
  const query = useQuery({ queryKey: ['paddon-management', scope], queryFn: ({ signal }) => api!.settings(signal), enabled: !!api && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false, networkMode: 'always' })
  useEffect(() => { live.current = true; return () => { live.current = false; if (activeOperation.current) ledger.interrupt(activeOperation.current); leases.cancelAll() } }, [ledger, leases])
  useEffect(() => { setDesired(null); setReviewed(false) }, [query.data])
  useEffect(() => setRecoveryReviewed(false), [intent?.observation])
  const pending = intent?.status === 'pending', recovery = intent?.status === 'unknown', editable = !demo && canEdit(session)
  const ready = !!api && !!query.data && query.isFetchedAfterMount && !query.isFetching && !query.isPending && !query.error
  const selected = desired ?? query.data?.free_movement_enabled ?? false, changed = !!query.data && selected !== query.data.free_movement_enabled
  const blocked = !ready || !!intent || !!error || connection !== 'online' || !editable
  const recoveryError = error instanceof PaddonManagementUnknown ? null : error
  const currentLease = (lease: ReturnType<MutationScope['begin']>): boolean => live.current && current.current.scope === scope && leases.isCurrent(lease)
  async function refresh() {
    if (!api || busy.current || pending || recovery || denied(query.error) || denied(error)) return
    setDesired(null); setReviewed(false); setError(null); await query.refetch()
  }
  async function save() {
    if (!api || blocked || busy.current || !changed || !reviewed || !query.data || ledger.snapshot()) return
    const operation = freeMovementOperation(query.data, selected), lease = leases.begin()
    busy.current = true; activeOperation.current = operation; setError(null)
    try {
      ledger.begin(operation)
      const saved = await api.execute(operation, lease.controller.signal, () => {
        if (!currentLease(lease) || current.current.connection !== 'online' || current.current.demo || !canEdit(current.current.session)) return false
        return ledger.dispatched(operation)
      })
      const retained = ledger.snapshot()
      if (!currentLease(lease) || retained?.operation !== operation || retained.status !== 'pending') { ledger.unknown(operation); return }
      ledger.finish(operation); setDesired(null); setReviewed(false)
      queryClient.setQueryData(['paddon-management', scope], saved)
      void queryClient.invalidateQueries({ predicate: candidate => candidate.queryKey.includes(scope) && ['paddons', 'paddon-detail', 'handoff-selectable'].includes(String(candidate.queryKey[0])) })
      toast.success('Erkin harakat sozlamasi saqlandi.')
    } catch (failure) {
      if (failure instanceof PaddonManagementUnknown) ledger.unknown(operation); else ledger.finish(operation)
      if (currentLease(lease)) { setError(failure); setReviewed(false); if (failure instanceof PaddonManagementConflict) queryClient.setQueryData(['paddon-management', scope], failure.current) }
    } finally { leases.finish(lease); busy.current = false; if (activeOperation.current === operation) activeOperation.current = null }
  }
  async function observe() {
    const retained = ledger.snapshot()
    if (!api || busy.current || connection === 'checking' || denied(recoveryError) || retained?.status !== 'unknown') return
    busy.current = true; setChecking(true); setRecoveryReviewed(false); setError(null); const lease = leases.begin()
    try { const observation = await api.observe(retained.operation, lease.controller.signal); if (currentLease(lease)) ledger.observe(retained.operation, observation) }
    catch (failure) { if (currentLease(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (live.current && !lease.controller.signal.aborted) setChecking(false) }
  }
  function resolveReviewed() {
    if (intent?.status !== 'unknown' || !intent.observation || !recoveryReviewed || checking || recoveryError) return
    ledger.resolveReviewed(intent.operation); queryClient.setQueryData(['paddon-management', scope], intent.observation.settings)
    setError(null); setDesired(null); setReviewed(false); setRecoveryReviewed(false); void query.refetch()
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg" aria-busy={pending || checking} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus() }}>
    <DialogHeader className="shrink-0 border-b p-4 pr-12"><DialogTitle>{recovery ? 'Paddon sozlamasi natijasini tekshirish' : 'Paddon sozlamalari'}</DialogTitle><DialogDescription>{recovery ? 'Avvalgi amal va serverdagi joriy holatni ko‘ring.' : 'Paddonlar o‘rtasida ko‘chirish holati.'}</DialogDescription></DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4" data-paddon-management-scroll>
      {!api ? <ManagementError error={new ApiError(403, 'forbidden')} /> : recovery && intent ? <PaddonManagementRecovery intent={intent} checking={checking} canCheck={connection !== 'checking' && !denied(recoveryError)} error={recoveryError} reviewed={recoveryReviewed} onReviewed={setRecoveryReviewed} onCheck={() => void observe()} /> : <>
        <PaddonManagementReadState loading={query.isPending} settings={query.data} error={query.error} canRetry={!pending} refreshing={query.isFetching} onRetry={() => void refresh()} />
        <ManagementError error={error} />
        {query.data && !query.error && <PaddonFreeMovementReview settings={query.data} editable={editable} desired={selected} reviewed={reviewed} disabled={blocked} onDesired={enabled => { setDesired(enabled); setReviewed(false); setError(null) }} onReviewed={setReviewed} />}
        {pending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{intent.dispatched ? 'Erkin harakat sozlamasi yuborilmoqda…' : 'Joriy sozlama saqlashdan oldin tekshirilmoqda…'}</p>}
        {connection === 'offline' && editable && <p className="text-xs text-muted-foreground">Ulanish yo‘q. Joriy holatni o‘qishga urinishingiz mumkin; saqlash ulanish tiklanganda ochiladi.</p>}
      </>}
    </div>
    <DialogFooter className="m-0 shrink-0 flex-row flex-wrap items-center justify-end gap-2 p-4" data-paddon-management-footer>
      <Button variant="ghost" onClick={onClose}>Yopish</Button>
      {recovery ? <Button variant="outline" disabled={!intent?.observation || !recoveryReviewed || checking || !!recoveryError} onClick={resolveReviewed}>Tekshiruvni yakunlash</Button> : <>
        {api && query.data && !query.error && !denied(error) && <Button variant="outline" disabled={pending || query.isFetching} onClick={() => void refresh()}><RefreshCw className={query.isFetching ? 'animate-spin' : ''} />Yangilash</Button>}
        {editable && query.data && <Button disabled={blocked || !changed || !reviewed} onClick={() => void save()}>{pending ? <Loader2 className="animate-spin" /> : null}{pending ? 'Saqlanmoqda…' : 'O‘zgarishni saqlash'}</Button>}
      </>}
    </DialogFooter>
  </DialogContent></Dialog>
}
