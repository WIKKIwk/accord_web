import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Pencil, Plus, RefreshCw, UsersRound } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import {
  WorkerGroupConflict, WorkerGroupUnknown, WorkerGroupsApi, assignedWorkerGroups, createWorkerGroupOperation,
  workerGroupError, workerGroupIdentity, workerGroupIntentLedger, workerGroupStartDays, workerGroupsAllowed,
} from '@/lib/worker-groups'
import type { GroupCatalog, GroupWorker, WorkerGroup, WorkerGroupInput, WorkerGroupIntent, WorkerGroupIntentLedger, WorkerGroupOperation, WorkerGroupObservation } from '@/lib/worker-groups'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { WorkerGroupOverview } from './worker-group-overview'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

type SavedCallback = () => void
export const groupDayLabels = { monday: 'Dushanba', tuesday: 'Seshanba', wednesday: 'Chorshanba', thursday: 'Payshanba', friday: 'Juma', saturday: 'Shanba', sunday: 'Yakshanba' }
function useGroupContext() {
  const context = useSession()
  const api = useMemo(() => context.client && context.session && !context.demo && workerGroupsAllowed(context.session)
    ? new WorkerGroupsApi(context.client, context.session) : null, [context.client, context.session, context.demo])
  const ledger = useMemo(() => workerGroupIntentLedger(context.scope), [context.scope])
  const intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  useEffect(() => {
    if (!intent) return
    const retain = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', retain)
    return () => window.removeEventListener('beforeunload', retain)
  }, [intent])
  return { ...context, api, ledger, intent }
}
function ErrorNotice({ error }: { error: unknown }) {
  return error ? <Alert variant="destructive" role="alert"><AlertDescription>{workerGroupError(error)}</AlertDescription></Alert> : null
}
function LoadingNotice({ label = 'Ishchi guruhlari yuklanmoqda…' }: { label?: string }) {
  return <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{label}</p>
}
function canRetryRead(error: unknown): boolean { return !(error instanceof ApiError && [401, 403].includes(error.status)) }
function BoundNotice({ bounded }: { bounded?: boolean }) {
  return bounded ? <p className="text-xs text-muted-foreground">Ko‘pi bilan 500 ta natija yuklandi. Qolgan tanlovlarni qidiruv bilan toping.</p> : null
}
export function WorkerGroupSummary({ group }: { group: WorkerGroupInput }) {
  return <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[130px_1fr]">
    <dt className="text-muted-foreground">Apparat</dt><dd className="min-w-0"><p>{group.apparatus || 'Apparat nomi mavjud emas'}</p><p className="break-all text-xs text-muted-foreground">{group.apparatus_id}</p></dd>
    <dt className="text-muted-foreground">Smena / vaqt</dt><dd>{group.shift} · {group.start_time} – {group.end_time}</dd>
    <dt className="text-muted-foreground">Ish kunlari</dt><dd>Haftada {group.work_days_per_week} kun · {groupDayLabels[group.start_day]}dan</dd>
    <dt className="text-muted-foreground">Hisoblash</dt><dd>{group.accounting_enabled ? 'Yoqilgan' : 'O‘chirilgan'}</dd>
    <dt className="text-muted-foreground">A’zolar</dt><dd>{group.worker_ids.length} ta ishchi</dd>
  </dl>
}
export function WorkerGroupList({ groups, search, onEdit, disabled = false }: { groups: WorkerGroup[]; search: string; onEdit: (group: WorkerGroup) => void; disabled?: boolean }) {
  const q = search.trim().toLocaleLowerCase(), matching = groups.filter(group => [group.group_code, group.apparatus, group.apparatus_id,
    ...group.worker_ids, ...group.workers.map(worker => `${worker.name} ${worker.id}`)].some(value => value.toLocaleLowerCase().includes(q)))
  if (!groups.length) return <div className="rounded-lg border border-dashed p-6 text-center"><UsersRound className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">Ishchi guruhlari hali yo‘q.</p><p className="mt-1 text-sm text-muted-foreground">Faol apparatni tanlab, birinchi guruhni yarating.</p></div>
  if (!matching.length) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Qidiruvga mos guruh topilmadi. Qidiruvni o‘zgartiring.</p>
  return <div className="space-y-3">{matching.map(group => <article key={workerGroupIdentity(group)} className="space-y-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 break-words font-semibold">{group.group_code}</h3><Badge variant="secondary">{group.worker_ids.length} ishchi</Badge><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onEdit(group)} aria-label={`${group.group_code} guruhini tahrirlash`}><Pencil />Tahrirlash</Button></div>
    <WorkerGroupSummary group={group} />
    {group.worker_ids.length ? <ul className="flex flex-wrap gap-2" aria-label={`${group.group_code} a’zolari`}>{group.worker_ids.map(id => { const worker = group.workers.find(item => item.id === id); return <li key={id} className="rounded-md bg-muted px-2 py-1 text-xs">{worker ? `${worker.name} · ${worker.level}` : `${id} · ishchi tafsiloti mavjud emas`}</li> })}</ul> : <p className="text-xs text-muted-foreground">Guruhga ishchi biriktirilmagan.</p>}
  </article>)}</div>
}

/** Mount in /app/workers. The manager uses only native group, apparatus and worker reads. */
export function WorkerGroupToolbar({ onSaved }: { onSaved?: SavedCallback }) {
  const { session, demo, scope, intent } = useGroupContext()
  const [openScope, setOpenScope] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  if (!workerGroupsAllowed(session)) return null
  return <><Button ref={trigger} variant="outline" disabled={demo} title={demo ? 'Ko‘rish rejimida guruhlar o‘zgartirilmaydi.' : undefined} onClick={() => setOpenScope(scope)}><UsersRound />Ishchi guruhlari{intent && <Badge variant="secondary">{intent.status === 'pending' ? 'Saqlanmoqda' : 'Tekshirish kerak'}</Badge>}</Button>
    {openScope === scope && <WorkerGroupManager key={scope} onSaved={onSaved} onClose={() => setOpenScope(null)} onReturnFocus={() => trigger.current?.focus()} />}
  </>
}
function useGroupWrite(ledger: WorkerGroupIntentLedger, onSaved?: SavedCallback) {
  const { api, scope, connection } = useGroupContext(), queryClient = useQueryClient()
  const leases = useMemo(() => new MutationScope(), []), current = useRef(scope), busy = useRef(false)
  current.current = scope
  const [error, setError] = useState<unknown>(null), [checking, setChecking] = useState(false)
  useEffect(() => () => leases.cancelAll(), [scope, leases])
  async function run(operation: WorkerGroupOperation, done: () => void): Promise<void> {
    if (busy.current || !api || connection !== 'online' || ledger.snapshot()) return
    busy.current = true; setError(null); ledger.begin(operation)
    const lease = leases.begin(), requestScope = scope
    try {
      const result = await api.execute(operation, lease.controller.signal)
      if (requestScope !== current.current || !leases.isCurrent(lease)) { ledger.unknown(operation); return }
      ledger.finish(operation)
      queryClient.setQueryData<WorkerGroup[]>(['worker-groups', requestScope], previous => [
        ...(previous ?? []).filter(group => workerGroupIdentity(group) !== workerGroupIdentity(result)
          && (!operation.baseline || workerGroupIdentity(group) !== workerGroupIdentity(operation.baseline))), result,
      ])
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(requestScope) })
      onSaved?.(); done(); toast.success('Ishchi guruhi saqlandi.')
    } catch (failure) {
      if (failure instanceof WorkerGroupUnknown) ledger.unknown(operation)
      else ledger.finish(operation)
      if (requestScope === current.current && leases.isCurrent(lease)) setError(failure)
    } finally { leases.finish(lease); busy.current = false }
  }
  async function observe(operation: WorkerGroupOperation): Promise<void> {
    if (busy.current || !api || connection !== 'online' || ledger.snapshot()?.status !== 'unknown') return
    busy.current = true; setChecking(true); setError(null)
    const lease = leases.begin(), requestScope = scope
    try {
      const observation = await api.observe(operation, lease.controller.signal)
      if (requestScope !== current.current || !leases.isCurrent(lease)) return
      ledger.observe(operation, observation)
      queryClient.setQueryData(['worker-groups', requestScope], observation.groups)
    } catch (failure) { if (requestScope === current.current && leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (requestScope === current.current && !lease.controller.signal.aborted) setChecking(false) }
  }
  return { run, observe, error, setError, checking, online: connection === 'online' }
}
function WorkerGroupManager({ onSaved, onClose, onReturnFocus }: { onSaved?: SavedCallback; onClose: () => void; onReturnFocus: () => void }) {
  const { api, scope, ledger, intent } = useGroupContext(), write = useGroupWrite(ledger, onSaved)
  const queryClient = useQueryClient()
  const groups = useQuery({ queryKey: ['worker-groups', scope], queryFn: ({ signal }) => api!.groups(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const [search, setSearch] = useState(''), [editor, setEditor] = useState<{ original?: WorkerGroup } | null>(null)
  const ready = groups.isFetchedAfterMount && !groups.isFetching && !groups.error && !!groups.data
  const editing = Boolean(editor) && intent?.status !== 'unknown'
  function done() { setEditor(null); write.setError(null) }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl" aria-busy={intent?.status === 'pending' || write.checking} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus() }}>
    <DialogHeader><DialogTitle>{intent?.status === 'unknown' ? 'Saqlash natijasini tekshirish' : editing ? editor?.original ? 'Ishchi guruhini tahrirlash' : 'Yangi ishchi guruhi' : 'Ishchi guruhlari'}</DialogTitle><DialogDescription>{intent?.status === 'unknown' ? 'Avvalgi tanlov va serverdagi joriy holatni birga ko‘ring.' : 'Apparat, smena, haftalik jadval va guruh a’zolarini boshqaring.'}</DialogDescription></DialogHeader>
    {!api ? <ErrorNotice error={new Error('Bu sessiyada guruhlarni boshqarish mavjud emas.')} /> : intent?.status === 'unknown'
      ? <WorkerGroupRecoveryView intent={intent} error={write.error instanceof WorkerGroupUnknown ? null : write.error} checking={write.checking} online={write.online}
        onCheck={() => void write.observe(intent.operation)} onReviewed={() => { ledger.resolveReviewed(intent.operation); done(); void groups.refetch() }} />
      : editing ? <WorkerGroupEditor key={editor?.original ? workerGroupIdentity(editor.original) : 'new'} original={editor?.original} groups={groups.data ?? []}
        pending={intent?.status === 'pending'} error={write.error} online={write.online} onBack={done}
        onSubmit={operation => void write.run(operation, done)} onLoadCurrent={currentGroups => { queryClient.setQueryData(['worker-groups', scope], currentGroups); done(); void groups.refetch() }} />
      : <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 sm:min-w-48" aria-label="Guruhlarni qidirish" placeholder="Guruh, apparat yoki ishchi qidirish…" value={search} onChange={event => setSearch(event.target.value)} /><Button variant="outline" size="icon" aria-label="Guruhlarni yangilash" disabled={groups.isFetching || !!intent} onClick={() => void groups.refetch()}><RefreshCw className={groups.isFetching ? 'animate-spin' : ''} /></Button><Button disabled={!ready || !!intent || !write.online} onClick={() => { write.setError(null); setEditor({}) }}><Plus />Guruh yaratish</Button></div>
        {groups.error ? <div className="space-y-3"><ErrorNotice error={groups.error} />{canRetryRead(groups.error) && <Button variant="outline" onClick={() => void groups.refetch()}>Qayta yuklash</Button>}</div> : !ready ? <LoadingNotice /> : <><WorkerGroupOverview groups={groups.data!} /><WorkerGroupList groups={groups.data!} search={search} disabled={!!intent || !write.online} onEdit={original => { write.setError(null); setEditor({ original }) }} /></>}
        {intent?.status === 'pending' && <LoadingNotice label="Avvalgi saqlash yakuni kutilmoqda…" />}
        <p className="text-xs text-muted-foreground">Ishchi faqat bitta guruhga biriktiriladi. Guruh a’zoligi ishchining apparatga kirish ruxsatini o‘zgartirmaydi.</p>
        <p className="text-xs text-muted-foreground">Guruhni o‘chirish amali mavjud emas. A’zolarni olib tashlash va hisoblashni o‘chirish mumkin.</p>
      </div>}
    {!write.online && <Alert><AlertDescription>Serverga ulanish tiklangach saqlash va natijani tekshirish mumkin.</AlertDescription></Alert>}
    <DialogFooter><Button variant="outline" onClick={onClose}>Oynani yopish</Button></DialogFooter>
  </DialogContent></Dialog>

}
function initialGroup(original?: WorkerGroup): WorkerGroupInput {
  return original ? { ...original, worker_ids: [...original.worker_ids] } : { apparatus_id: '', apparatus: '', group_code: '', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: [] }
}
function WorkerGroupEditor({ original, groups, pending, error, online, onBack, onSubmit, onLoadCurrent }: {
  original?: WorkerGroup; groups: WorkerGroup[]; pending: boolean; error: unknown; online: boolean; onBack: () => void;
  onSubmit: (operation: WorkerGroupOperation) => void; onLoadCurrent: (groups: WorkerGroup[]) => void;
}) {
  const { api, scope } = useGroupContext(), id = useId()
  const [form, setForm] = useState<WorkerGroupInput>(() => initialGroup(original)), [validation, setValidation] = useState('')
  const [apparatusSearch, setApparatusSearch] = useState(''), [workerSearch, setWorkerSearch] = useState('')
  const apparatusQ = useDeferredValue(apparatusSearch.trim()), workerQ = useDeferredValue(workerSearch.trim())
  const apparatus = useQuery({ queryKey: ['worker-group-apparatus', scope, apparatusQ], queryFn: ({ signal }) => api!.apparatus(apparatusQ, signal), enabled: !!api, retry: false, refetchOnWindowFocus: false })
  const workers = useQuery({ queryKey: ['worker-group-workers', scope, workerQ], queryFn: ({ signal }) => api!.workers(workerQ, signal), enabled: !!api, retry: false, refetchOnWindowFocus: false })
  const [knownWorkers, setKnownWorkers] = useState<GroupWorker[]>(original?.workers ?? [])
  useEffect(() => { if (workers.data) setKnownWorkers(previous => [...new Map([...previous, ...workers.data.items].map(worker => [worker.id, worker])).values()]) }, [workers.data])
  const selectedApparatus = apparatus.data?.items.find(item => item.id === form.apparatus_id)
  useEffect(() => { if (selectedApparatus && !pending) setForm(previous => previous.apparatus_id === selectedApparatus.id ? { ...previous, apparatus: selectedApparatus.name } : previous) }, [selectedApparatus, pending])
  const conflicting = error instanceof WorkerGroupConflict, blocked = pending || conflicting
  const catalogsReady = !apparatus.isFetching && !apparatus.error && !!apparatus.data && !workers.isFetching && !workers.error && !!workers.data
  const assigned = assignedWorkerGroups(groups, original)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (blocked || !online || !catalogsReady) return
    try { const operation = createWorkerGroupOperation(form, original); setValidation(''); onSubmit(operation) } catch (failure) { setValidation(workerGroupError(failure)) }
  }
  return <form onSubmit={submit} className="space-y-5">
    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onBack}><ArrowLeft />Guruhlarga qaytish</Button>
    <fieldset disabled={blocked} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-name`}>Guruh nomi</Label><Input id={`${id}-name`} autoComplete="off" required value={form.group_code} placeholder="Masalan, A GURUH" onChange={event => setForm(previous => ({ ...previous, group_code: event.target.value }))} /><p className="text-xs text-muted-foreground">Harflar, raqamlar va bo‘shliq; saqlanganda katta harfga o‘tadi.</p></div><div className="space-y-2"><Label htmlFor={`${id}-shift`}>Smena</Label><Input id={`${id}-shift`} value={form.shift} placeholder="kunduz yoki tun" onChange={event => setForm(previous => ({ ...previous, shift: event.target.value }))} /></div></div>
      <div className="space-y-2"><Label htmlFor={`${id}-apparatus-search`}>Apparatni qidirish</Label><Input id={`${id}-apparatus-search`} placeholder="Faol apparat nomi…" value={apparatusSearch} onChange={event => setApparatusSearch(event.target.value)} /><Label htmlFor={`${id}-apparatus`}>Apparat</Label><Select value={form.apparatus_id || undefined} disabled={blocked || apparatus.isFetching || !!apparatus.error} onValueChange={value => { const choice = apparatus.data?.items.find(item => item.id === value); if (choice) setForm(previous => ({ ...previous, apparatus_id: choice.id, apparatus: choice.name })) }}><SelectTrigger id={`${id}-apparatus`} className="w-full"><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{form.apparatus_id && !selectedApparatus && <SelectItem value={form.apparatus_id} disabled>{form.apparatus || form.apparatus_id} · qayta tekshiriladi</SelectItem>}{apparatus.data?.items.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
        {apparatus.isPending && <LoadingNotice label="Apparatlar yuklanmoqda…" />}{apparatus.error && <div className="space-y-2"><ErrorNotice error={apparatus.error} />{canRetryRead(apparatus.error) && <Button type="button" variant="outline" onClick={() => void apparatus.refetch()}>Apparatlarni qayta yuklash</Button>}</div>}{apparatus.data && !apparatus.data.items.length && <p className="text-sm text-muted-foreground">Qidiruvga mos faol apparat yo‘q.</p>}<BoundNotice bounded={apparatus.data?.bounded} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-start`}>Boshlanish vaqti</Label><Input id={`${id}-start`} type="time" required value={form.start_time} onChange={event => setForm(previous => ({ ...previous, start_time: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor={`${id}-end`}>Tugash vaqti</Label><Input id={`${id}-end`} type="time" required value={form.end_time} onChange={event => setForm(previous => ({ ...previous, end_time: event.target.value }))} /></div></div>
      <p className="text-xs text-muted-foreground">Tungi smena keyingi kunda tugashi mumkin.</p>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-days`}>Haftadagi ish kunlari</Label><Select value={String(form.work_days_per_week)} disabled={blocked} onValueChange={value => setForm(previous => ({ ...previous, work_days_per_week: Number(value) }))}><SelectTrigger id={`${id}-days`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{[1, 2, 3, 4, 5, 6, 7].map(day => <SelectItem key={day} value={String(day)}>{day} kun</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label htmlFor={`${id}-day`}>Hafta boshlanish kuni</Label><Select value={form.start_day} disabled={blocked} onValueChange={value => setForm(previous => ({ ...previous, start_day: value as WorkerGroupInput['start_day'] }))}><SelectTrigger id={`${id}-day`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{workerGroupStartDays.map(day => <SelectItem key={day} value={day}>{groupDayLabels[day]}</SelectItem>)}</SelectContent></Select></div></div>
      <Label htmlFor={`${id}-accounting`} className="flex items-start gap-3 rounded-lg border p-3"><Checkbox id={`${id}-accounting`} checked={form.accounting_enabled} disabled={blocked} onCheckedChange={checked => setForm(previous => ({ ...previous, accounting_enabled: checked === true }))} /><span>Guruh uchun hisoblashni yoqish</span></Label>
      <div className="space-y-3"><div className="flex items-center justify-between gap-2"><Label htmlFor={`${id}-worker-search`}>Guruh a’zolari</Label><Badge variant="secondary">{form.worker_ids.length} tanlangan</Badge></div><Input id={`${id}-worker-search`} value={workerSearch} placeholder="Ishchi ismi yoki telefoni…" onChange={event => setWorkerSearch(event.target.value)} />
        {form.worker_ids.length > 0 && <div className="space-y-2 rounded-lg border p-3"><p className="text-xs font-medium">Tanlangan ishchilar</p>{form.worker_ids.map(workerId => { const worker = knownWorkers.find(item => item.id === workerId); return <div key={workerId} className="flex items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm">{worker?.name ?? workerId}<span className="ml-2 text-xs text-muted-foreground">{worker?.level ?? 'Joriy a’zo, qayta tekshiriladi'}</span></span><Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => setForm(previous => ({ ...previous, worker_ids: previous.worker_ids.filter(value => value !== workerId) }))} aria-label={`${worker?.name ?? workerId}ni guruhdan olib tashlash`}>Olib tashlash</Button></div> })}</div>}
        {workers.isPending ? <LoadingNotice label="Ishchilar yuklanmoqda…" /> : workers.error ? <div className="space-y-2"><ErrorNotice error={workers.error} />{canRetryRead(workers.error) && <Button type="button" variant="outline" onClick={() => void workers.refetch()}>Ishchilarni qayta yuklash</Button>}</div> : <WorkerGroupWorkerChoices catalog={workers.data} selected={form.worker_ids} assigned={assigned} disabled={blocked || workers.isFetching} onChange={worker_ids => setForm(previous => ({ ...previous, worker_ids }))} />}
      </div>
    </fieldset>
    <ErrorNotice error={validation ? new Error(validation) : error} />
    {error instanceof WorkerGroupConflict && <Button type="button" variant="outline" onClick={() => onLoadCurrent(error.current)}>Joriy guruhlarni ko‘rib qayta boshlash</Button>}
    <p className="text-xs text-muted-foreground">Bir vaqtda boshqa administrator ham tahrirlasa, oxirgi saqlangan qiymatlar qolishi mumkin.</p>
    {pending && <Alert><AlertDescription>Saqlash tekshirilmoqda. Oynani yopish serverdagi amalni bekor qilishini kafolatlamaydi.</AlertDescription></Alert>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={onBack}>Bekor qilish</Button><Button type="submit" disabled={blocked || !online || !catalogsReady || !form.apparatus_id || !form.group_code.trim()}>{pending && <Loader2 className="animate-spin" />}{pending ? 'Saqlanmoqda…' : 'Guruhni saqlash'}</Button></div>
  </form>
}
export function WorkerGroupWorkerChoices({ catalog, selected, assigned, disabled, onChange }: { catalog?: GroupCatalog<GroupWorker>; selected: string[]; assigned: Map<string, WorkerGroup>; disabled: boolean; onChange: (ids: string[]) => void }) {
  const id = useId()
  return <div className="space-y-2"><div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2" aria-label="Biriktirish uchun ishchilar">
    {!catalog?.items.length && <p className="p-2 text-sm text-muted-foreground">Qidiruvga mos faol ishchi topilmadi.</p>}
    {catalog?.items.map((worker, index) => { const other = assigned.get(worker.id.toLowerCase()), checked = selected.includes(worker.id); return <Label key={worker.id} htmlFor={`${id}-${index}`} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"><Checkbox id={`${id}-${index}`} checked={checked} disabled={disabled || !!other && !checked} onCheckedChange={next => onChange(next === true ? [...new Set([...selected, worker.id])] : selected.filter(value => value !== worker.id))} /><span className="min-w-0"><span className="block break-words">{worker.name}</span><span className="block text-xs text-muted-foreground">{worker.level}{other && ` · ${other.group_code} / ${other.apparatus || other.apparatus_id} guruhiga biriktirilgan`}</span></span></Label> })}
  </div><BoundNotice bounded={catalog?.bounded} /></div>
}
export function WorkerGroupRecoveryView({ intent, error, checking, online, onCheck, onReviewed }: {
  intent: WorkerGroupIntent; error: unknown; checking: boolean; online: boolean; onCheck: () => void; onReviewed: () => void;
}) {
  const id = useId(), [reviewed, setReviewed] = useState(false), observation = intent.observation
  useEffect(() => setReviewed(false), [observation])
  return <div className="space-y-4">
    <ErrorNotice error={new WorkerGroupUnknown(intent.operation)} />
    <section className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">Avval yuborilgan tanlov: {intent.operation.input.group_code}</h3><WorkerGroupSummary group={intent.operation.input} /><p className="break-words text-xs text-muted-foreground">Ishchi ID lari: {intent.operation.input.worker_ids.join(', ') || 'A’zo yo‘q'}</p>{intent.operation.baseline && <p className="break-all text-xs text-muted-foreground">Avvalgi guruh: {intent.operation.baseline.group_code} · {intent.operation.baseline.apparatus_id}</p>}</section>
    <p className="text-sm text-muted-foreground">Tekshirish faqat joriy ma’lumotni yuklaydi. Mos qiymatlar avvalgi so‘rov saqlanganini yoki uni kim saqlaganini tasdiqlamaydi.</p>
    <p className="text-xs text-muted-foreground">Avvalgi tanlov shu sessiya xotirasida saqlanmoqda. Sahifani to‘liq yangilash yoki hisobdan chiqish bu tanlovni yo‘qotadi; avval joriy holatni ko‘rib chiqing.</p>
    <Button type="button" variant="outline" disabled={checking || !online} onClick={onCheck}>{checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}{checking ? 'Tekshirilmoqda…' : 'Serverdagi joriy holatni tekshirish'}</Button>
    <ErrorNotice error={error} />
    {observation && <WorkerGroupObservationView observation={observation} />}
    {observation && <div className="space-y-3"><Label htmlFor={`${id}-reviewed`} className="flex items-start gap-3"><Checkbox id={`${id}-reviewed`} checked={reviewed} disabled={checking} onCheckedChange={value => setReviewed(value === true)} /><span className="text-sm leading-relaxed">Avvalgi tanlov va joriy holatni ko‘rdim. Avvalgi so‘rov natijasi tasdiqlanmaganini tushunaman.</span></Label><Button type="button" variant="outline" disabled={!reviewed || checking} onClick={onReviewed}>Tekshiruvni yakunlash</Button></div>}
  </div>
}
export function WorkerGroupObservationView({ observation }: { observation: WorkerGroupObservation }) {
  return <section className="space-y-3 rounded-lg border bg-muted/30 p-4"><h3 className="font-semibold">Serverdagi joriy holat</h3><p className="text-sm">{observation.state === 'matches' ? 'Joriy qiymatlar yuborilgan tanlovga mos. Avvalgi so‘rov natijasi hali tasdiqlanmagan.' : observation.state === 'different' ? 'Guruh mavjud, ammo joriy qiymatlar yuborilgan tanlovdan farq qiladi.' : 'Yuborilgan apparat va guruh nomi bilan guruh topilmadi. Bu so‘rov bajarilmaganini isbotlamaydi.'}</p>
    {observation.target && <><WorkerGroupSummary group={observation.target} /><p className="break-words text-xs text-muted-foreground">Joriy ishchi ID lari: {observation.target.worker_ids.join(', ') || 'A’zo yo‘q'}</p></>}
    {observation.previous && observation.previous !== observation.target && <div className="space-y-2 border-t pt-3"><p className="text-sm font-medium">Avvalgi guruh nomi bilan yozuv: {observation.previous.group_code}</p><WorkerGroupSummary group={observation.previous} /></div>}
  </section>
}
