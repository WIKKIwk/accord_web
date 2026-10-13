import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { ProductionSnapshot, Row } from '@/lib/api-types'
import {
  APPARATUS_PLANNING_API_LIMITATIONS, ApparatusPlanningApi, PlanningConflict, PlanningSaveUnknown,
  apparatusPlanningError, apparatusPlanningPermissions, planningApparatusId, planningCapacityForm,
  planningCapacityInput, planningDowntimeOperation, planningInteger, planningMinuteLabel, planningOrderId,
  planningOrderPolicy, planningPatchOperation, planningPolicyLabels, planningQueuePolicyLocked, planningReservedMinutes,
  planningScheduleOperation, planningUtcInput, planningWeekdays, planningWindowLabel,
} from '@/lib/apparatus-planning'
import type {
  ApparatusPlanningSnapshot, PlanningApparatus, PlanningCapacityForm, PlanningDiscipline, PlanningDowntime,
  PlanningOperation, PlanningScheduleOperation, PlanningScheduleResult,
} from '@/lib/apparatus-planning'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

type SavedCallback = () => void
type WriteResult = ApparatusPlanningSnapshot | PlanningDowntime | PlanningScheduleResult
// A record swap/unmount cannot silently discard an interrupted write's request key.
// Keys contain SessionManager's epoch and never a token; another session cannot see them.
const interruptedWrites = new Map<string, PlanningOperation>()
function usePlanningApi() {
  const session = useSession()
  const api = useMemo(() => session.client && session.session && !session.demo ? new ApparatusPlanningApi(session.client, session.session) : null, [session.client, session.session, session.demo])
  return { ...session, api, permissions: apparatusPlanningPermissions(session.session) }
}
function usePlanningWrite(identity: string, onSaved?: SavedCallback) {
  const { api, scope, connection, permissions } = usePlanningApi(), queryClient = useQueryClient()
  const context = `${scope}:${identity}`, current = useRef(context), busy = useRef(false), mutations = useMemo(() => new MutationScope(), [])
  current.current = context
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(() => interruptedWrites.has(context) ? new PlanningSaveUnknown(interruptedWrites.get(context)!) : null)
  const unknown = error instanceof PlanningSaveUnknown ? error : null
  useEffect(() => {
    busy.current = false; setPending(false)
    const interrupted = interruptedWrites.get(context)
    if (interrupted) setError(new PlanningSaveUnknown(interrupted))
    return () => mutations.cancelAll()
  }, [mutations, api, context])
  async function run(operation: PlanningOperation, execute: (api: ApparatusPlanningApi, signal: AbortSignal) => Promise<WriteResult>, done: (result: WriteResult) => void, recovery = false) {
    if (busy.current || !api || !permissions.write || connection !== 'online' || !recovery && interruptedWrites.has(context)) return
    busy.current = true; setPending(true); setError(null)
    interruptedWrites.set(context, structuredClone(operation))
    const lease = mutations.begin(), key = context
    try {
      const result = await execute(api, lease.controller.signal)
      if (key !== current.current || !mutations.isCurrent(lease)) return
      interruptedWrites.delete(key)
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
      onSaved?.(); done(result)
      toast.success(operation.kind === 'schedule' || operation.kind === 'cancel' ? 'Serverdagi jadval bandi tasdiqlandi.' : 'Serverdagi yozuv tasdiqlandi.')
    } catch (failure) {
      if (key !== current.current || !mutations.isCurrent(lease)) return
      const currentPatchKnown = failure instanceof PlanningConflict && failure.current && (operation.kind === 'capacity' || operation.kind === 'policy')
      const preserved = recovery && !currentPatchKnown && !(failure instanceof PlanningSaveUnknown) ? new PlanningSaveUnknown(operation, `${apparatusPlanningError(failure)} Oldingi so‘rov natijasi tasdiqlanmadi.`) : failure
      if (!(preserved instanceof PlanningSaveUnknown)) interruptedWrites.delete(key)
      setError(preserved)
    } finally {
      mutations.finish(lease)
      if (key === current.current && mutations.isCurrent(lease)) { busy.current = false; setPending(false) }
    }
  }
  return { pending, error, unknown, run, clear: () => { if (!unknown && !pending) setError(null) }, canWrite: permissions.write && Boolean(api) && connection === 'online' && !pending && !unknown && !interruptedWrites.has(context), online: connection === 'online' }
}
function PlanningError({ error }: { error: unknown }) { return error ? <Alert variant="destructive"><AlertDescription>{apparatusPlanningError(error)}</AlertDescription></Alert> : null }
function ReadState({ loading, error, retry, children }: { loading: boolean; error: unknown; retry: () => void; children: ReactNode }) {
  if (loading) return <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Rejalashtirish ma’lumotlari yuklanmoqda…</p>
  if (error) return <div className="space-y-3"><PlanningError error={error} />{!(error instanceof ApiError && [401, 403].includes(error.status)) && <Button variant="outline" onClick={retry}>Qayta yuklash</Button>}</div>
  return children
}
function PlanningDialog({ title, description, onClose, locked = false, children }: { title: string; description: string; onClose: () => void; locked?: boolean; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose() }}><DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-3xl" onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onPointerDownOutside={event => { if (locked) event.preventDefault() }}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>
}
function SaveLabel({ pending, label = 'Ko‘rib chiqish' }: { pending: boolean; label?: string }) { return <>{pending && <Loader2 className="size-4 animate-spin" />}{pending ? 'Server tekshirilmoqda…' : label}</> }
function operationLabel(operation: PlanningOperation): string { return operation.kind === 'capacity' ? 'Quvvat profilini saqlash' : operation.kind === 'policy' ? 'Navbat siyosatini saqlash' : operation.kind === 'downtime' ? 'Ish to‘xtashini saqlash' : operation.kind === 'schedule' ? 'Jadvalga band qilish' : 'Jadval bandini bekor qilish' }
function OperationSummary({ operation }: { operation: PlanningOperation }) {
  if (operation.kind === 'capacity') { const profile = operation.capacity!; return <dl className="grid grid-cols-2 gap-2 text-sm"><dt>Parallel joylar</dt><dd>{profile.capacity_slots}</dd><dt>Tayyorlash / tozalash</dt><dd>{profile.setup_minutes} / {profile.cleanup_minutes} daqiqa</dd><dt>Samaradorlik</dt><dd>{profile.efficiency_percent}%</dd><dt>Bandlikni cheklash</dt><dd>{profile.finite_capacity ? 'Ha' : 'Yo‘q'}</dd><dt>Ish vaqti (UTC)</dt><dd>{profile.availability.mode === 'always' ? 'Har doim' : profile.availability.working_windows.map((window, index) => <p key={index}>{planningWeekdays[window.weekday - 1]} {planningMinuteLabel(window.start_minute)}–{planningMinuteLabel(window.end_minute)}</p>)}</dd><dt>Asos revision</dt><dd>{operation.expectedRevision}</dd></dl> }
  if (operation.kind === 'policy') return <div className="space-y-2 text-sm"><p>{planningPolicyLabels[operation.discipline!]}</p><p>Asos revision: {operation.expectedRevision}</p><p className="text-muted-foreground">Siyosat saqlanishi ish boshlash yoki buyurtmalarni qayta tartiblashni bajarmaydi.</p></div>
  if (operation.kind === 'downtime') return <div className="space-y-2 text-sm"><p>{planningWindowLabel(operation.body.starts_at_unix, operation.body.ends_at_unix)}</p><p>{operation.body.reason}</p><p>Bandlik: {operation.body.active ? 'Faol' : 'Faolsiz'}</p><p className="break-all text-xs text-muted-foreground">Yozuv: {operation.body.id}</p><p className="text-muted-foreground">Bu amal revision shartisiz saqlanadi. API tarixni qaytarmaydi.</p></div>
  if (operation.kind === 'cancel') return <div className="space-y-2 text-sm"><p>Buyurtma: {operation.original.reservation.order_id}</p><p>{operation.original.reservation.apparatus}</p><p>{planningWindowLabel(operation.original.reservation.starts_at_unix, operation.original.reservation.ends_at_unix)}</p><p className="break-all text-xs">Band: {operation.original.reservation.reservation_id}</p><p>{operation.reason || 'Sabab kiritilmagan.'}</p></div>
  if (operation.kind !== 'schedule') return null
  return <div className="space-y-2 text-sm"><p>Buyurtma: {operation.body.order_id}</p><p>{operation.body.apparatus}</p><p>{planningWindowLabel(operation.body.earliest_start_unix, operation.body.latest_end_unix)}</p><p>So‘ralgan ish: {operation.body.duration_minutes} daqiqa · Jami bandlik: {operation.expectedReservedMinutes} daqiqa · Ustuvorlik: {operation.body.priority}</p><p>{operation.body.reason}</p><Alert><AlertDescription>{APPARATUS_PLANNING_API_LIMITATIONS[1]} Band yaratish ishni boshlamaydi.</AlertDescription></Alert></div>
}
function Confirmation({ operation, write, onConfirm, onClose, onRecover, onCurrent }: { operation: PlanningOperation; write: ReturnType<typeof usePlanningWrite>; onConfirm: () => void; onClose: () => void; onRecover: (operation: PlanningOperation) => void; onCurrent?: (current: ApparatusPlanningSnapshot) => void }) {
  const current = write.error instanceof PlanningConflict ? write.error.current : undefined
  return <PlanningDialog title={operationLabel(operation)} description="Tanlangan apparat va qiymatlarni tekshirib, saqlashni tasdiqlang." onClose={onClose} locked={write.pending || Boolean(write.unknown)}><OperationSummary operation={operation} /><PlanningError error={write.error} />
    {write.unknown && <div className="space-y-2"><p className="text-xs text-muted-foreground">Natija aniqlanmaguncha yangi so‘rov yuborilmaydi. Saqlash avtomatik takrorlanmaydi.</p>{operation.kind === 'schedule' && <p className="text-xs text-muted-foreground">Avvalgi so‘rov kaliti va qiymatlari saqlanadi. Qayta tasdiqlash avvalgi bandni qaytaradi yoki oldingi so‘rov saqlanmagan bo‘lsa aynan shu rejani yaratadi.</p>}<Button variant="outline" disabled={write.pending || !write.online} onClick={() => onRecover(write.unknown!.operation)}>{operation.kind === 'downtime' ? 'Aynan shu yozuvni qayta saqlash' : operation.kind === 'schedule' ? 'Aynan shu rejani qayta tasdiqlash' : 'Aynan shu amal natijasini tekshirish'}</Button></div>}
    {current && onCurrent && <Button variant="outline" disabled={write.pending} onClick={() => onCurrent(current)}>Joriy nusxani yuklash</Button>}
    <DialogFooter><Button variant="outline" disabled={write.pending || Boolean(write.unknown)} onClick={onClose}>Yopish</Button><Button disabled={!write.canWrite || Boolean(write.error)} onClick={onConfirm}><SaveLabel pending={write.pending} label="Tasdiqlash va saqlash" /></Button></DialogFooter>
  </PlanningDialog>
}

/** Apparatus detail entry point. Reads canonical configuration when opened. */
export function ApparatusPlanningControls({ row, onSaved }: { row: Row; onSaved?: SavedCallback }) {
  const { scope, permissions, demo } = usePlanningApi(), id = planningApparatusId(row)
  if (!id || !permissions.read) return null
  return <ApparatusPlanningEntry key={`${scope}:${id}`} apparatusId={id} demo={demo} onSaved={onSaved} />
}
function ApparatusPlanningEntry({ apparatusId, demo, onSaved }: { apparatusId: string; demo: boolean; onSaved?: SavedCallback }) {
  const [open, setOpen] = useState(false)
  return <div className="space-y-2 border-t pt-4"><Button variant="outline" className="w-full" disabled={demo} onClick={() => setOpen(true)}><CalendarClock />Quvvat, navbat va ish vaqti</Button>{demo && <p className="text-xs text-muted-foreground">Rejalashtirish profili ulangan serverda ochiladi.</p>}{open && <ApparatusPlanningDialog apparatusId={apparatusId} onSaved={onSaved} onClose={() => setOpen(false)} />}</div>
}
function ApparatusPlanningDialog({ apparatusId, onSaved, onClose }: { apparatusId: string; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = usePlanningApi()
  const query = useQuery({ queryKey: ['apparatus-planning', scope, apparatusId], queryFn: ({ signal }) => api!.read(apparatusId, signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  return <PlanningDialog title="Apparat quvvati va navbati" description="Amaldagi canonical profil, ish vaqti va server tasdiqlagan ish to‘xtashlari." onClose={onClose}><ReadState loading={query.isPending || query.isFetching && !query.data} error={query.error} retry={() => void query.refetch()}>{query.data && <ApparatusPlanningEditor initial={query.data} onSaved={onSaved} />}</ReadState></PlanningDialog>
}
function CapacityFields({ form, setForm, disabled }: { form: PlanningCapacityForm; setForm: (form: PlanningCapacityForm) => void; disabled: boolean }) {
  const id = useId(), counter = useRef(0)
  const fields = [['slots', 'Parallel joylar', '1–64'], ['efficiency', 'Samaradorlik, %', '1–200'], ['setup', 'Tayyorlash, daqiqa', '0'], ['cleanup', 'Tozalash, daqiqa', '0']] as const
  return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2">{fields.map(([key, label, placeholder]) => <div key={key} className="space-y-2"><Label htmlFor={`${id}-${key}`}>{label}</Label><Input id={`${id}-${key}`} inputMode="numeric" value={form[key]} placeholder={placeholder} disabled={disabled} onChange={event => setForm({ ...form, [key]: event.target.value })} /></div>)}</div>
    <Label className="flex items-center gap-2" htmlFor={`${id}-finite`}><Checkbox id={`${id}-finite`} checked={form.finite} disabled={disabled} onCheckedChange={value => setForm({ ...form, finite: value === true })} />Parallel joylar bo‘yicha bandlikni cheklash</Label>
    <div className="space-y-2"><Label htmlFor={`${id}-availability`}>Ish vaqti</Label><Select value={form.scheduled ? 'scheduled' : 'always'} disabled={disabled} onValueChange={value => setForm({ ...form, scheduled: value === 'scheduled' })}><SelectTrigger id={`${id}-availability`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="always">Har doim</SelectItem><SelectItem value="scheduled">Haftalik ish vaqtlari (UTC)</SelectItem></SelectContent></Select></div>
    {form.scheduled && <div className="space-y-3"><p className="text-xs text-muted-foreground">Kun va vaqtlar UTC bo‘yicha. Tugash uchun 24:00 mumkin. Yarim tundan o‘tgan smenani ikki kunga ajrating.</p>{form.windows.map((window, index) => <div key={window.key} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-lg border p-3 sm:grid-cols-[1.6fr_1fr_1fr_auto]"><div className="col-span-3 space-y-2 sm:col-span-1"><Label htmlFor={`${id}-day-${index}`}>Hafta kuni</Label><Select value={window.weekday} disabled={disabled} onValueChange={weekday => setForm({ ...form, windows: form.windows.map(row => row.key === window.key ? { ...row, weekday } : row) })}><SelectTrigger id={`${id}-day-${index}`}><SelectValue /></SelectTrigger><SelectContent>{planningWeekdays.map((day, i) => <SelectItem key={day} value={String(i + 1)}>{day}</SelectItem>)}</SelectContent></Select></div>{(['start', 'end'] as const).map(key => <div key={key} className="space-y-2"><Label htmlFor={`${id}-${key}-${index}`}>{key === 'start' ? 'Boshlanish' : 'Tugash'}</Label><Input id={`${id}-${key}-${index}`} placeholder="HH:mm" value={window[key]} disabled={disabled} onChange={event => setForm({ ...form, windows: form.windows.map(row => row.key === window.key ? { ...row, [key]: event.target.value } : row) })} /></div>)}<Button className="self-end" type="button" variant="ghost" size="icon" aria-label={`${planningWeekdays[Number(window.weekday) - 1]} ish vaqtini olib tashlash`} disabled={disabled} onClick={() => setForm({ ...form, windows: form.windows.filter(row => row.key !== window.key) })}><X /></Button></div>)}<Button type="button" variant="outline" disabled={disabled} onClick={() => setForm({ ...form, windows: [...form.windows, { key: `new-${counter.current++}`, weekday: '1', start: '08:00', end: '17:00' }] })}><Plus />Ish vaqtini qo‘shish</Button></div>}
  </div>
}
function ApparatusPlanningEditor({ initial, onSaved }: { initial: ApparatusPlanningSnapshot; onSaved?: SavedCallback }) {
  const { permissions } = usePlanningApi(), write = usePlanningWrite(`apparatus-planning:${initial.apparatus.apparatus_id}`, onSaved)
  const [baseline, setBaseline] = useState(initial), [form, setForm] = useState(() => planningCapacityForm(initial.capacity)), [discipline, setDiscipline] = useState<PlanningDiscipline>(initial.policy.discipline)
  const [confirm, setConfirm] = useState<PlanningOperation | null>(() => write.unknown?.operation ?? null), [validation, setValidation] = useState('')
  const [downtimes, setDowntimes] = useState<PlanningDowntime[]>([]), [editing, setEditing] = useState<PlanningDowntime | undefined>()
  const now = Math.ceil(Date.now() / 60_000) * 60, [start, setStart] = useState(() => planningUtcInput(now)), [end, setEnd] = useState(() => planningUtcInput(now + 3600)), [reason, setReason] = useState('')
  const id = useId(), canWrite = write.canWrite && baseline.apparatus.active, policyLocked = planningQueuePolicyLocked(baseline.apparatus)
  function review(build: () => PlanningOperation) { if (!canWrite) return; try { setConfirm(build()); setValidation(''); write.clear() } catch (error) { setValidation(apparatusPlanningError(error)) } }
  function loadCurrent(current: ApparatusPlanningSnapshot) { setBaseline(current); setForm(planningCapacityForm(current.capacity)); setDiscipline(current.policy.discipline); setConfirm(null); write.clear(); setValidation('') }
  function done(result: WriteResult) {
    if ('capacity' in result) { setBaseline(result); setForm(planningCapacityForm(result.capacity)); setDiscipline(result.policy.discipline) }
    else if ('id' in result) { setDowntimes(values => [...values.filter(row => row.id !== result.id), result]); setEditing(undefined); setReason('') }
    setConfirm(null)
  }
  function execute(operation: PlanningOperation, recover = false) {
    void write.run(operation, (api, signal) => operation.kind === 'capacity' || operation.kind === 'policy' ? recover ? api.recoverPatch(operation, signal) : api.patch(operation, signal) : operation.kind === 'downtime' ? api.downtime(operation, signal) : Promise.reject(new Error('Bu apparat oynasi boshqa amalni yubormaydi.')), done, recover)
  }
  return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{baseline.apparatus.name}</p><p className="break-all text-xs text-muted-foreground">{baseline.apparatus.apparatus_id}</p></div><Badge variant={baseline.apparatus.active ? 'secondary' : 'destructive'}>{baseline.apparatus.active ? 'Faol' : 'Foydalanishdan chiqarilgan'} · Revision {baseline.apparatus.source_revision}</Badge></div>
    {!permissions.write && <Alert><AlertDescription>Profilni ko‘rish mumkin. O‘zgartirish uchun admin.access yoki production.map.manage ruxsati kerak.</AlertDescription></Alert>}
    {!write.online && <Alert><AlertDescription>Sessiya yoki ulanish tasdiqlanmagan. Saqlash uchun ulanishni tiklang.</AlertDescription></Alert>}
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); review(() => planningPatchOperation(baseline, planningCapacityInput(form))) }} className="space-y-4"><p className="text-sm font-medium">Quvvat va ish vaqti</p><CapacityFields form={form} setForm={setForm} disabled={!canWrite} />{permissions.write && <Button type="submit" disabled={!canWrite}><SaveLabel pending={write.pending} label="Quvvat profilini ko‘rib chiqish" /></Button>}</form>
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); review(() => planningPatchOperation(baseline, discipline)) }} className="space-y-3 border-t pt-4"><Label htmlFor={`${id}-policy`}>Navbat siyosati</Label><Select value={discipline} disabled={!canWrite || policyLocked} onValueChange={value => setDiscipline(value as PlanningDiscipline)}><SelectTrigger id={`${id}-policy`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(planningPolicyLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Qat’iy navbatda saqlangan ketma-ketlik kuzatiladi. Erkin tanlashda tayyor buyurtma tanlanadi. Siyosat ishni avtomatik boshlamaydi.</p>{policyLocked && <p className="text-xs text-muted-foreground">Bosma apparat navbat siyosati mobil qoidaga ko‘ra qulflangan. Bu yerda serverdagi haqiqiy saqlangan siyosat ko‘rsatiladi.</p>}{permissions.write && !policyLocked && <Button type="submit" variant="outline" disabled={!canWrite}>Navbat siyosatini ko‘rib chiqish</Button>}</form>
    {permissions.write && <form className="space-y-4 border-t pt-4" onSubmit={(event: FormEvent) => { event.preventDefault(); review(() => planningDowntimeOperation(baseline, { start, end, reason }, editing)) }}><p className="text-sm font-medium">{editing ? 'Ish to‘xtashini tahrirlash' : 'Ish to‘xtashini qo‘shish'}</p><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-downtime-start`}>Boshlanish, UTC</Label><Input id={`${id}-downtime-start`} type="datetime-local" value={start} disabled={!canWrite} onChange={event => setStart(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-downtime-end`}>Tugash, UTC</Label><Input id={`${id}-downtime-end`} type="datetime-local" value={end} disabled={!canWrite} onChange={event => setEnd(event.target.value)} /></div></div><div className="space-y-2"><Label htmlFor={`${id}-downtime-reason`}>Ish to‘xtashi sababi</Label><Textarea id={`${id}-downtime-reason`} value={reason} disabled={!canWrite} onChange={event => setReason(event.target.value)} /></div><div className="flex flex-wrap gap-2"><Button type="submit" variant="outline" disabled={!canWrite}>Ish to‘xtashini ko‘rib chiqish</Button>{editing && <Button type="button" variant="ghost" disabled={!canWrite} onClick={() => { setEditing(undefined); setReason('') }}>Tahrirni yopish</Button>}</div></form>}
    <div className="space-y-2"><p className="text-sm font-medium">Shu oynada server tasdiqlagan ish to‘xtashlari</p><p className="text-xs text-muted-foreground">{APPARATUS_PLANNING_API_LIMITATIONS[0]}</p>{downtimes.length ? <Table><TableHeader><TableRow><TableHead>Vaqt (UTC)</TableHead><TableHead>Sabab / holat</TableHead><TableHead>Amal</TableHead></TableRow></TableHeader><TableBody>{downtimes.map(downtime => <TableRow key={downtime.id}><TableCell className="text-xs">{planningWindowLabel(downtime.starts_at_unix, downtime.ends_at_unix)}</TableCell><TableCell><p>{downtime.reason}</p><Badge variant="secondary">{downtime.active ? 'Faol' : 'Faolsiz'}</Badge></TableCell><TableCell>{canWrite && <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={() => { setEditing(downtime); setStart(planningUtcInput(downtime.starts_at_unix)); setEnd(planningUtcInput(downtime.ends_at_unix)); setReason(downtime.reason) }}>Tahrirlash</Button>{downtime.active && <Button size="sm" variant="ghost" onClick={() => review(() => ({ kind: 'downtime', method: 'PUT', body: { ...downtime, active: false, actor: { role: '', ref: '', display_name: '' } } }))}>Faolsizlantirish</Button>}</div>}</TableCell></TableRow>)}</TableBody></Table> : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Bu oynada hali tasdiqlangan yozuv yo‘q. Bu serverda ish to‘xtashlari yo‘q degani emas.</p>}</div>
    <PlanningError error={validation ? new Error(validation) : null} />{!confirm && <PlanningError error={write.error} />}
    <p className="text-xs text-muted-foreground">{APPARATUS_PLANNING_API_LIMITATIONS[3]}</p>
    {confirm && <Confirmation operation={confirm} write={write} onConfirm={() => execute(confirm)} onClose={() => { setConfirm(null); write.clear() }} onRecover={operation => execute(operation, true)} onCurrent={loadCurrent} />}
  </div>
}

/** Existing order detail entry point. No free-text order identity or automatic execution. */
export function OrderSchedulingControls({ row, onSaved }: { row: Row; onSaved?: SavedCallback }) {
  const { scope, demo, permissions } = usePlanningApi(), orderId = planningOrderId(row)
  if (!orderId || !permissions.write) return null
  return <OrderSchedulingEntry key={`${scope}:${orderId}`} orderId={orderId} demo={demo} onSaved={onSaved} />
}
function OrderSchedulingEntry({ orderId, demo, onSaved }: { orderId: string; demo: boolean; onSaved?: SavedCallback }) {
  const [open, setOpen] = useState(false), [entries, setEntries] = useState<PlanningScheduleResult[]>([])
  const write = usePlanningWrite(`order-planning:${orderId}`, onSaved)
  const [confirm, setConfirm] = useState<PlanningOperation | null>(() => write.unknown?.operation ?? null), [cancelReason, setCancelReason] = useState('')
  function done(result: WriteResult) { if ('reservation' in result) setEntries(values => [...values.filter(value => value.reservation.reservation_id !== result.reservation.reservation_id), result]); setConfirm(null); setOpen(false) }
  function execute(operation: PlanningOperation, recover = false) {
    void write.run(operation, (api, signal) => operation.kind === 'schedule' ? api.schedule(operation, signal, recover) : operation.kind === 'cancel' ? recover ? api.schedule(operation.original.operation, signal, true) : api.cancel(operation, signal) : Promise.reject(new Error('Bu buyurtma oynasi boshqa amalni yubormaydi.')), done, recover)
  }
  return <div className="space-y-3 border-t pt-4"><Button variant="outline" className="w-full" disabled={demo || !write.canWrite} onClick={() => { setOpen(true); write.clear() }}><CalendarClock />Apparat vaqtini rejalashtirish</Button>
    {!write.online && !demo && <p className="text-xs text-muted-foreground">Reja yaratish uchun sessiya va ulanishni tiklang.</p>}
    {!!entries.length && <div className="space-y-2"><p className="text-sm font-medium">Shu oynada server tasdiqlagan jadval bandlari</p><Table><TableHeader><TableRow><TableHead>Apparat / vaqt</TableHead><TableHead>Holat</TableHead><TableHead>Amal</TableHead></TableRow></TableHeader><TableBody>{entries.map(entry => <TableRow key={entry.reservation.reservation_id}><TableCell><p>{entry.reservation.apparatus}</p><p className="text-xs text-muted-foreground">{planningWindowLabel(entry.reservation.starts_at_unix, entry.reservation.ends_at_unix)}</p><p className="text-xs">{entry.reservation.reserved_duration_minutes} daqiqa band qilingan</p><p className="break-all text-xs text-muted-foreground">{entry.reservation.reservation_id}</p>{entry.conflicts.map(conflict => <p key={conflict.reservation_id} className="text-xs text-destructive">{conflict.order_id}: {conflict.detail} · {planningWindowLabel(conflict.starts_at_unix, conflict.ends_at_unix)}</p>)}</TableCell><TableCell><Badge variant="secondary">{entry.reservation.status}</Badge></TableCell><TableCell>{entry.reservation.status === 'planned' && <Button size="sm" variant="outline" disabled={!write.canWrite} onClick={() => { setCancelReason(''); setConfirm({ kind: 'cancel', original: entry, reason: '' }); write.clear() }}>Bandni bekor qilish</Button>}</TableCell></TableRow>)}</TableBody></Table></div>}
    <p className="text-xs text-muted-foreground">{APPARATUS_PLANNING_API_LIMITATIONS[0]}</p>{!confirm && <PlanningError error={write.error} />}
    {open && <OrderScheduleDialog orderId={orderId} onClose={() => setOpen(false)} onReview={operation => { write.clear(); setConfirm(operation) }} disabled={!write.canWrite} />}
    {confirm && confirm.kind === 'cancel' && !write.unknown && <PlanningDialog title="Jadval bandini bekor qilish" description="Faqat ko‘rsatilgan, server qaytargan planned band bekor qilinadi." locked={write.pending} onClose={() => { setConfirm(null); write.clear() }}><OperationSummary operation={confirm} /><div className="space-y-2"><Label htmlFor="planning-cancel-reason">Bekor qilish sababi</Label><Textarea id="planning-cancel-reason" value={cancelReason} disabled={write.pending} onChange={event => setCancelReason(event.target.value)} /></div><PlanningError error={write.error} /><DialogFooter><Button variant="outline" disabled={write.pending} onClick={() => { setConfirm(null); write.clear() }}>Yopish</Button><Button disabled={!write.canWrite || Boolean(write.error)} onClick={() => execute({ ...confirm, reason: cancelReason })}><SaveLabel pending={write.pending} label="Bandni bekor qilishni tasdiqlash" /></Button></DialogFooter></PlanningDialog>}
    {confirm && (confirm.kind !== 'cancel' || write.unknown) && <Confirmation operation={confirm} write={write} onConfirm={() => execute(confirm)} onClose={() => { setConfirm(null); write.clear() }} onRecover={operation => execute(operation, true)} />}
  </div>
}
function OrderScheduleDialog({ orderId, onReview, onClose, disabled }: { orderId: string; onReview: (operation: PlanningScheduleOperation) => void; onClose: () => void; disabled: boolean }) {
  const { api, scope } = usePlanningApi()
  const orders = useQuery({ queryKey: ['order-planning-source', scope, orderId], queryFn: ({ signal }) => api!.orders(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const apparatus = useQuery({ queryKey: ['order-planning-apparatus', scope], queryFn: ({ signal }) => api!.apparatus(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  return <PlanningDialog title="Buyurtma uchun apparat vaqtini rejalashtirish" description={`Buyurtma: ${orderId}. Band yaratish ishlab chiqarishni avtomatik boshlamaydi.`} onClose={onClose}><ReadState loading={orders.isPending || apparatus.isPending} error={orders.error || apparatus.error} retry={() => { void orders.refetch(); void apparatus.refetch() }}>{orders.data && apparatus.data && <OrderScheduleForm orders={orders.data} apparatus={apparatus.data} orderId={orderId} disabled={disabled || orders.isFetching || apparatus.isFetching} onReview={onReview} />}</ReadState></PlanningDialog>
}
function OrderScheduleForm({ orders, apparatus, orderId, disabled, onReview }: { orders: ProductionSnapshot; apparatus: PlanningApparatus[]; orderId: string; disabled: boolean; onReview: (operation: PlanningScheduleOperation) => void }) {
  const { api, scope } = usePlanningApi(), id = useId(), policy = planningOrderPolicy(orders, orderId)
  const choices = apparatus.filter(item => item.active && policy.apparatusIds.includes(item.apparatus_id)), [selected, setSelected] = useState('')
  const config = useQuery({ queryKey: ['schedule-planning-config', scope, selected], queryFn: ({ signal }) => api!.read(selected, signal), enabled: Boolean(api && selected), retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const now = Math.ceil(Date.now() / 60_000) * 60, [start, setStart] = useState(() => planningUtcInput(now)), [end, setEnd] = useState(() => planningUtcInput(now + 3600))
  const [duration, setDuration] = useState('60'), [priority, setPriority] = useState('0'), [reason, setReason] = useState(''), [requirements, setRequirements] = useState<Record<string, string>>({}), [validation, setValidation] = useState('')
  const blocked = disabled || !selected || config.isPending || config.isFetching || config.isError || !config.data?.apparatus.active || !choices.some(item => item.apparatus_id === selected)
  function submit(event: FormEvent) { event.preventDefault(); if (blocked || !config.data) return; try { const operation = planningScheduleOperation(config.data, orders, { orderId, start, end, duration, priority, reason, requirements: Object.entries(requirements).map(([code, level]) => ({ code, min_level: planningInteger(level, `${code} darajasi`, 1, config.data!.apparatus.capabilities[code]) })) }); setValidation(''); onReview(operation) } catch (error) { setValidation(apparatusPlanningError(error)) } }
  let total: number | null = null
  try { if (config.data) total = planningReservedMinutes(config.data.capacity, planningInteger(duration, 'Davomiylik', 1, 43_200)) } catch { /* Invalid draft has no estimated total. */ }
  return <form onSubmit={submit} noValidate className="space-y-5"><div className="space-y-2"><Label htmlFor={`${id}-apparatus`}>Buyurtma xaritasidagi apparat</Label><Select value={selected} disabled={disabled || !choices.length} onValueChange={value => { setSelected(value); setRequirements({}); setValidation('') }}><SelectTrigger id={`${id}-apparatus`}><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{choices.map(item => <SelectItem key={item.apparatus_id} value={item.apparatus_id}>{item.name}</SelectItem>)}</SelectContent></Select>{(!choices.length || policy.reason) && <p className="text-sm text-muted-foreground">{policy.reason || 'Buyurtma xaritasidagi faol apparatlar ro‘yxatda topilmadi.'}</p>}{apparatus.length >= 500 && <p className="text-xs text-muted-foreground">Apparatlar ro‘yxati API cheklovi bo‘yicha eng ko‘p 500 yozuvdan iborat.</p>}</div>
    {selected && <ReadState loading={config.isPending} error={config.error} retry={() => void config.refetch()}>{config.data && <p className="text-xs text-muted-foreground">Revision {config.data.apparatus.source_revision} · {config.data.capacity.capacity_slots} parallel joy · {config.data.capacity.efficiency_percent}% samaradorlik</p>}</ReadState>}
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-start`}>Eng erta boshlanish, UTC</Label><Input id={`${id}-start`} type="datetime-local" value={start} disabled={disabled} onChange={event => setStart(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-end`}>Eng kech tugash, UTC</Label><Input id={`${id}-end`} type="datetime-local" value={end} disabled={disabled} onChange={event => setEnd(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-duration`}>Ish davomiyligi, daqiqa</Label><Input id={`${id}-duration`} inputMode="numeric" value={duration} disabled={disabled} onChange={event => setDuration(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-priority`}>Ustuvorlik</Label><Input id={`${id}-priority`} inputMode="numeric" value={priority} disabled={disabled} onChange={event => setPriority(event.target.value)} /></div></div>
    {total !== null && <p className="text-xs text-muted-foreground">Tayyorlash, tozalash va samaradorlik bilan jami {total} daqiqa. Bandning aniq vaqtini server qaytaradi.</p>}
    {config.data && Object.keys(config.data.apparatus.capabilities).length > 0 && <div className="space-y-2"><p className="text-sm font-medium">Imkoniyat talablari (ixtiyoriy)</p>{Object.entries(config.data.apparatus.capabilities).map(([code, maximum]) => <div key={code} className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><Label className="flex flex-1 items-center gap-2" htmlFor={`${id}-require-${code}`}><Checkbox id={`${id}-require-${code}`} checked={code in requirements} disabled={disabled} onCheckedChange={value => setRequirements(previous => { const next = { ...previous }; if (value === true) next[code] = '1'; else delete next[code]; return next })} />{code} · mavjud daraja {maximum}</Label>{code in requirements && <div className="flex items-center gap-2"><Label htmlFor={`${id}-level-${code}`}>Eng kam daraja</Label><Input id={`${id}-level-${code}`} className="w-20" inputMode="numeric" value={requirements[code]} disabled={disabled} onChange={event => setRequirements({ ...requirements, [code]: event.target.value })} /></div>}</div>)}</div>}
    <div className="space-y-2"><Label htmlFor={`${id}-reason`}>Rejalashtirish sababi</Label><Textarea id={`${id}-reason`} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} /></div><Alert><AlertDescription>{APPARATUS_PLANNING_API_LIMITATIONS[1]}</AlertDescription></Alert><PlanningError error={validation ? new Error(validation) : null} /><DialogFooter><Button type="submit" disabled={blocked}><CheckCircle2 />Rejani ko‘rib chiqish</Button></DialogFooter>
  </form>
}
