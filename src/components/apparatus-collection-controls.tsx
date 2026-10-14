import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FolderCog, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { ApparatusCollectionsApi, CollectionConflict, CollectionUnknown, canReadCollections, canManageCollections, collectionError, collectionIntentLedger, createCollectionOperation, deleteCollectionOperation } from '@/lib/apparatus-collections'
import type { ApparatusCollection, CollectionInput, CollectionIntent, CollectionOperation, CollectionObservation } from '@/lib/apparatus-collections'
import type { GroupApparatus, GroupCatalog } from '@/lib/worker-groups'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'

function useCollections() {
  const context = useSession()
  const api = useMemo(() => context.client && context.session && !context.demo && canReadCollections(context.session) ? new ApparatusCollectionsApi(context.client, context.session) : null, [context.client, context.session, context.demo])
  const ledger = useMemo(() => collectionIntentLedger(context.scope), [context.scope])
  const intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  useEffect(() => {
    if (!intent) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [intent])
  return { ...context, api, ledger, intent, manage: canManageCollections(context.session) }
}
function ErrorNotice({ error }: { error: unknown }) { return error ? <Alert variant="destructive" role="alert"><AlertDescription>{collectionError(error)}</AlertDescription></Alert> : null }
function Loading({ label = 'Apparat guruhlari yuklanmoqda…' }: { label?: string }) { return <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{label}</p> }
function retryAllowed(error: unknown) { return !(error instanceof ApiError && [401, 403].includes(error.status)) }
function isConflict(error: unknown) { return error instanceof CollectionConflict || error instanceof ApiError && (error.status === 404 || error.status === 409 && error.code !== 'apparatus collection name already exists') }

export function ApparatusCollectionToolbar({ onSaved }: { onSaved?: () => void }) {
  const { session, scope, demo, intent } = useCollections(), [openScope, setOpenScope] = useState<string | null>(null), trigger = useRef<HTMLButtonElement>(null)
  if (!canReadCollections(session)) return null
  return <><Button ref={trigger} variant="outline" disabled={demo} title={demo ? 'Ko‘rish rejimida server guruhlari yuklanmaydi.' : undefined} onClick={() => setOpenScope(scope)}><FolderCog />Apparat guruhlari{intent && <Badge variant="secondary">{intent.status === 'unknown' ? 'Tekshirish kerak' : 'Saqlanmoqda'}</Badge>}</Button>
    {openScope === scope && <CollectionManager key={scope} onSaved={onSaved} onClose={() => setOpenScope(null)} onReturnFocus={() => trigger.current?.focus()} />}</>
}
export function CollectionMembers({ ids, names }: { ids: readonly string[]; names?: ReadonlyMap<string, string> }) {
  return ids.length ? <ul className="space-y-2" aria-label="Guruh apparatlari">{ids.map(id => <li key={id} className="min-w-0 rounded-md bg-muted px-3 py-2 text-sm"><p className="break-words font-medium">{names?.get(id) || 'Apparat nomi joriy ro‘yxatda yo‘q'}</p><p className="break-all text-xs text-muted-foreground">{id}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">Guruhga apparat qo‘shilmagan.</p>
}
export function CollectionList({ collections, names, search, manage, disabled, onEdit, onDelete }: { collections: readonly ApparatusCollection[]; names: ReadonlyMap<string, string>; search: string; manage: boolean; disabled: boolean; onEdit: (row: ApparatusCollection) => void; onDelete: (row: ApparatusCollection) => void }) {
  const q = search.trim().toLocaleLowerCase(), shown = collections.filter(row => [row.name, ...row.apparatus_ids, ...row.apparatus_ids.map(id => names.get(id) ?? '')].some(text => text.toLocaleLowerCase().includes(q)))
  if (!collections.length) return <div className="rounded-lg border border-dashed p-6 text-center"><FolderCog className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">Apparat guruhlari hali yo‘q.</p><p className="mt-1 text-sm text-muted-foreground">Apparatlarni kerakli nom ostida birlashtiring.</p></div>
  if (!shown.length) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Qidiruvga mos apparat guruhi topilmadi.</p>
  return <div className="space-y-3">{shown.map(row => <article key={row.id} className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 break-words font-semibold">{row.name}</h3><Badge variant="secondary">{row.apparatus_ids.length} apparat</Badge></div>
    <CollectionMembers ids={row.apparatus_ids} names={names} />
    {manage && <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" disabled={disabled} aria-label={`${row.name} guruhini tahrirlash`} onClick={() => onEdit(row)}><Pencil />Tahrirlash</Button><Button size="sm" variant="outline" disabled={disabled} aria-label={`${row.name} guruhini o‘chirish`} onClick={() => onDelete(row)}><Trash2 />O‘chirish</Button></div>}
  </article>)}</div>
}
function useCollectionWrite(onSaved?: () => void) {
  const { api, scope, ledger, connection, manage } = useCollections(), queryClient = useQueryClient(), leases = useMemo(() => new MutationScope(), []), busy = useRef(false)
  const [error, setError] = useState<unknown>(null), [checking, setChecking] = useState(false)
  useEffect(() => () => leases.cancelAll(), [leases])
  async function execute(operation: CollectionOperation, done: () => void) {
    if (!api || !manage || connection !== 'online' || busy.current || ledger.snapshot()) return
    busy.current = true; setError(null); ledger.begin(operation); const lease = leases.begin()
    try {
      const saved = await api.execute(operation, lease.controller.signal)
      if (!leases.isCurrent(lease)) { ledger.unknown(operation); return }
      ledger.finish(operation)
      queryClient.setQueryData<ApparatusCollection[]>(['apparatus-collections', scope], rows => saved ? [...(rows ?? []).filter(row => row.id !== saved.id), saved] : (rows ?? []).filter(row => row.id !== operation.baseline?.id))
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) }); onSaved?.(); done()
      toast.success(operation.kind === 'delete' ? 'Apparat guruhi o‘chirildi.' : 'Apparat guruhi saqlandi.')
    } catch (failure) {
      if (failure instanceof CollectionUnknown) ledger.unknown(operation); else ledger.finish(operation)
      if (leases.isCurrent(lease)) setError(failure)
    } finally { leases.finish(lease); busy.current = false }
  }
  async function observe(operation: CollectionOperation) {
    if (!api || connection !== 'online' || busy.current || ledger.snapshot()?.status !== 'unknown') return
    busy.current = true; setError(null); setChecking(true); const lease = leases.begin()
    try { const result = await api.observe(operation, lease.controller.signal); if (leases.isCurrent(lease)) { ledger.observe(operation, result); queryClient.setQueryData(['apparatus-collections', scope], result.collections) } }
    catch (failure) { if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (!lease.controller.signal.aborted) setChecking(false) }
  }
  return { execute, observe, error, setError, checking, online: connection === 'online' }
}
function CollectionManager({ onClose, onReturnFocus, onSaved }: { onClose: () => void; onReturnFocus: () => void; onSaved?: () => void }) {
  const { api, scope, manage, ledger, intent } = useCollections(), write = useCollectionWrite(onSaved), queryClient = useQueryClient()
  const groups = useQuery({ queryKey: ['apparatus-collections', scope], queryFn: ({ signal }) => api!.list(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const apparatus = useQuery({ queryKey: ['collection-apparatus', scope, ''], queryFn: ({ signal }) => api!.apparatus('', signal), enabled: !!api, retry: false, refetchOnWindowFocus: false })
  const names = new Map(apparatus.data?.items.map(row => [row.id, row.name]) ?? [])
  const [search, setSearch] = useState(''), [editor, setEditor] = useState<{ original?: ApparatusCollection } | null>(null), [deleting, setDeleting] = useState<ApparatusCollection | null>(null)
  const ready = groups.isFetchedAfterMount && !groups.isFetching && !groups.error && !!groups.data, pending = intent?.status === 'pending'
  function done() { setEditor(null); setDeleting(null); write.setError(null) }
  function restart(current: ApparatusCollection[]) { queryClient.setQueryData(['apparatus-collections', scope], current); done(); void groups.refetch() }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl" aria-busy={pending || write.checking} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus() }}>
    <DialogHeader><DialogTitle>{intent?.status === 'unknown' ? 'Guruh amali natijasini tekshirish' : deleting ? 'Apparat guruhini o‘chirish' : editor ? editor.original ? 'Apparat guruhini tahrirlash' : 'Yangi apparat guruhi' : 'Apparat guruhlari'}</DialogTitle><DialogDescription>Nomlangan guruhlar va ularga qo‘shilgan apparatlarni boshqaring.</DialogDescription></DialogHeader>
    {!api ? <ErrorNotice error={new Error('Bu sessiyada apparat guruhlarini ko‘rish mavjud emas.')} /> : intent?.status === 'unknown' ? <CollectionRecovery intent={intent} names={names} checking={write.checking} online={write.online} error={write.error instanceof CollectionUnknown ? null : write.error} onCheck={() => void write.observe(intent.operation)} onReviewed={() => { ledger.resolveReviewed(intent.operation); done(); void groups.refetch() }} />
      : deleting ? <CollectionDelete row={deleting} names={names} pending={pending} online={write.online && manage} error={write.error} onBack={done} onDelete={() => void write.execute(deleteCollectionOperation(deleting), done)} onRestart={restart} />
        : editor ? <CollectionEditor key={editor.original?.id ?? 'new'} original={editor.original} pending={pending} online={write.online && manage} error={write.error} onBack={done} onSubmit={operation => void write.execute(operation, done)} onRestart={restart} />
          : <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 sm:min-w-40" aria-label="Apparat guruhlarini qidirish" placeholder="Guruh yoki apparat qidirish…" value={search} onChange={event => setSearch(event.target.value)} /><Button variant="outline" size="icon" aria-label="Apparat guruhlarini yangilash" disabled={groups.isFetching || !!intent} onClick={() => void groups.refetch()}><RefreshCw className={groups.isFetching ? 'animate-spin' : ''} /></Button>{manage && <Button disabled={!ready || !!intent || !write.online} onClick={() => { write.setError(null); setEditor({}) }}><Plus />Apparat guruhi yaratish</Button>}</div>
            {groups.error ? <div className="space-y-3"><ErrorNotice error={groups.error} />{retryAllowed(groups.error) && <Button variant="outline" onClick={() => void groups.refetch()}>Guruhlarni qayta yuklash</Button>}</div> : !ready ? <Loading /> : <><p className="text-xs text-muted-foreground">{groups.data!.length} ta guruh · {new Set(groups.data!.flatMap(row => row.apparatus_ids)).size} ta turli apparat biriktirilgan</p><CollectionList collections={groups.data!} names={names} search={search} manage={manage} disabled={!!intent || !write.online} onEdit={original => { write.setError(null); setEditor({ original }) }} onDelete={row => { write.setError(null); setDeleting(row) }} /></>}
            {apparatus.error && <div className="space-y-2"><p className="text-xs text-muted-foreground">Apparat nomlari yuklanmadi. Guruhdagi ID lar saqlanib turibdi.</p>{retryAllowed(apparatus.error) && <Button variant="outline" size="sm" onClick={() => void apparatus.refetch()}>Nomlarni qayta yuklash</Button>}</div>}
            {!manage && <p className="text-sm text-muted-foreground">Guruhlarni ko‘rish mumkin. O‘zgartirish uchun ruxsat yetarli emas.</p>}
            <p className="text-xs text-muted-foreground">Bitta apparat bir nechta guruhga kirishi mumkin. Guruh tuzish apparatning sozlamalari yoki kirish ruxsatlarini o‘zgartirmaydi.</p>
          </div>}
    {!write.online && <Alert><AlertDescription>Ulanish tiklangach saqlash va joriy holatni tekshirish mumkin.</AlertDescription></Alert>}
    <DialogFooter><Button variant="outline" onClick={onClose}>Oynani yopish</Button></DialogFooter>
  </DialogContent></Dialog>
}
function ConflictRestart({ error, onRestart }: { error: unknown; onRestart: (rows: ApparatusCollection[]) => void }) {
  const { api, scope } = useCollections(), mounted = useRef(true)
  const fresh = useQuery({ queryKey: ['apparatus-collections', scope], queryFn: ({ signal }) => api!.list(signal), enabled: false, retry: false, refetchOnWindowFocus: false })
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!isConflict(error)) return null
  async function restart() {
    if (error instanceof CollectionConflict) { onRestart(error.current); return }
    const result = await fresh.refetch()
    if (mounted.current && !result.error && result.data) onRestart(result.data)
  }
  return <div className="space-y-2"><ErrorNotice error={fresh.error} /><Button type="button" variant="outline" disabled={fresh.isFetching || !api} onClick={() => void restart()}>Joriy guruhlarni ko‘rib qayta boshlash</Button></div>
}
function CollectionEditor({ original, pending, online, error, onBack, onSubmit, onRestart }: { original?: ApparatusCollection; pending: boolean; online: boolean; error: unknown; onBack: () => void; onSubmit: (operation: CollectionOperation) => void; onRestart: (rows: ApparatusCollection[]) => void }) {
  const { api, scope } = useCollections(), id = useId(), [form, setForm] = useState<CollectionInput>(() => ({ name: original?.name ?? '', apparatus_ids: [...(original?.apparatus_ids ?? [])] }))
  const [search, setSearch] = useState(''), [validation, setValidation] = useState(''), q = useDeferredValue(search.trim())
  const catalog = useQuery({ queryKey: ['collection-apparatus', scope, q], queryFn: ({ signal }) => api!.apparatus(q, signal), enabled: !!api, retry: false, refetchOnWindowFocus: false })
  const [known, setKnown] = useState<GroupApparatus[]>([])
  useEffect(() => { if (catalog.data) setKnown(previous => [...new Map([...previous, ...catalog.data.items].map(row => [row.id, row])).values()]) }, [catalog.data])
  const blocked = pending || isConflict(error), ready = !!catalog.data && !catalog.error && !catalog.isFetching
  function submit(event: FormEvent) { event.preventDefault(); if (blocked || !online || !ready) return; try { const op = createCollectionOperation(form, original); setValidation(''); onSubmit(op) } catch (failure) { setValidation(collectionError(failure)) } }
  return <form className="space-y-4" onSubmit={submit}>
    <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onBack}><ArrowLeft />Guruhlarga qaytish</Button>
    <fieldset disabled={blocked} className="space-y-4">
      <div className="space-y-2"><Label htmlFor={`${id}-name`}>Apparat guruhi nomi</Label><Input id={`${id}-name`} required autoComplete="off" value={form.name} placeholder="Masalan, Bosma apparatlari" onChange={event => setForm(previous => ({ ...previous, name: event.target.value }))} /><p className="text-xs text-muted-foreground">80 tagacha belgi. Har bir guruh nomi alohida bo‘lishi kerak.</p></div>
      <div className="space-y-2"><div className="flex items-center justify-between gap-2"><Label htmlFor={`${id}-search`}>Guruhga apparat qo‘shish</Label><Badge variant="secondary">{form.apparatus_ids.length} tanlangan</Badge></div><Input id={`${id}-search`} placeholder="Faol apparatni qidirish…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      {form.apparatus_ids.length > 0 && <div className="space-y-2 rounded-lg border p-3"><p className="text-xs font-medium">Tanlangan apparatlar</p>{form.apparatus_ids.map(appId => <div key={appId} className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="break-words text-sm">{known.find(row => row.id === appId)?.name ?? 'Tanlangan apparat'}</p><p className="break-all text-xs text-muted-foreground">{appId}</p></div><Button type="button" size="icon-sm" variant="ghost" aria-label={`${appId}ni guruhdan olib tashlash`} disabled={blocked} onClick={() => setForm(previous => ({ ...previous, apparatus_ids: previous.apparatus_ids.filter(value => value !== appId) }))}><X /></Button></div>)}</div>}
      {catalog.isPending ? <Loading label="Faol apparatlar yuklanmoqda…" /> : catalog.error ? <div className="space-y-2"><ErrorNotice error={catalog.error} />{retryAllowed(catalog.error) && <Button type="button" variant="outline" onClick={() => void catalog.refetch()}>Apparatlarni qayta yuklash</Button>}</div> : <CollectionChoices catalog={catalog.data} selected={form.apparatus_ids} disabled={blocked || catalog.isFetching} onChange={apparatus_ids => setForm(previous => ({ ...previous, apparatus_ids }))} />}
    </fieldset>
    <ErrorNotice error={validation ? new Error(validation) : error} /><ConflictRestart error={error} onRestart={onRestart} />
    <p className="text-xs text-muted-foreground">Bo‘sh guruh ham saqlanishi mumkin. Saqlashda har bir tanlangan apparatning faol holati qayta tekshiriladi.</p>
    {pending && <Alert><AlertDescription>Amal yuborilmoqda. Oynani yopish serverdagi saqlashni bekor qilishini kafolatlamaydi.</AlertDescription></Alert>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={onBack}>Bekor qilish</Button><Button type="submit" disabled={blocked || !online || !ready || !form.name.trim()}>{pending && <Loader2 className="animate-spin" />}{pending ? 'Saqlanmoqda…' : 'Apparat guruhini saqlash'}</Button></div>
  </form>
}
export function CollectionChoices({ catalog, selected, disabled, onChange }: { catalog?: GroupCatalog<GroupApparatus>; selected: readonly string[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const id = useId()
  return <div className="space-y-2"><div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border p-2" aria-label="Guruh uchun faol apparatlar">
    {!catalog?.items.length && <p className="p-2 text-sm text-muted-foreground">Qidiruvga mos faol apparat topilmadi.</p>}
    {catalog?.items.map((row, index) => <Label key={row.id} htmlFor={`${id}-${index}`} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"><Checkbox id={`${id}-${index}`} checked={selected.includes(row.id)} disabled={disabled} onCheckedChange={next => onChange(next === true ? [...new Set([...selected, row.id])] : selected.filter(value => value !== row.id))} /><span className="min-w-0"><span className="block break-words">{row.name}</span><span className="block break-all text-xs text-muted-foreground">{row.id}</span></span></Label>)}
  </div>{catalog?.bounded && <p className="text-xs text-muted-foreground">Ko‘pi bilan 500 ta apparat yuklandi. Qolganlarini qidiruv bilan toping; tanlangan apparatlar saqlanib turadi.</p>}</div>
}
export function CollectionDelete({ row, names, pending, online, error, onBack, onDelete, onRestart }: { row: ApparatusCollection; names: ReadonlyMap<string, string>; pending: boolean; online: boolean; error: unknown; onBack: () => void; onDelete: () => void; onRestart: (rows: ApparatusCollection[]) => void }) {
  const conflict = isConflict(error)
  return <div className="space-y-4"><p className="break-words font-semibold">{row.name}</p><CollectionMembers ids={row.apparatus_ids} names={names} /><Alert><AlertDescription>Bu guruh yozuvi o‘chiriladi. Apparatlar va ularning sozlamalari saqlanib qoladi.</AlertDescription></Alert><ErrorNotice error={error} /><ConflictRestart error={error} onRestart={onRestart} />{pending && <Loading label="Guruhni o‘chirish yakuni kutilmoqda…" />}<div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={onBack}>Bekor qilish</Button><Button variant="destructive" disabled={pending || conflict || !online} onClick={onDelete}><Trash2 />Guruhni o‘chirish</Button></div></div>
}
export function CollectionObservationView({ observation, names }: { observation: CollectionObservation; names: ReadonlyMap<string, string> }) {
  return <section className="space-y-3 rounded-lg border bg-muted/30 p-4"><h3 className="font-semibold">Serverdagi joriy holat</h3><p className="text-sm">{observation.state === 'matches' ? 'Joriy qiymatlar avval yuborilgan tanlovga mos. Bu asl so‘rov natijasini tasdiqlamaydi.' : observation.state === 'different' ? 'Guruh mavjud, ammo joriy qiymatlar avvalgi tanlovdan farq qiladi.' : 'Guruh joriy ro‘yxatda topilmadi. Bu asl so‘rov natijasini tasdiqlamaydi.'}</p>{observation.target && <><p className="break-words font-medium">{observation.target.name}</p><CollectionMembers ids={observation.target.apparatus_ids} names={names} /></>}</section>
}
export function CollectionRecovery({ intent, names, checking, online, error, onCheck, onReviewed }: { intent: CollectionIntent; names: ReadonlyMap<string, string>; checking: boolean; online: boolean; error: unknown; onCheck: () => void; onReviewed: () => void }) {
  const id = useId(), [reviewed, setReviewed] = useState(false)
  useEffect(() => setReviewed(false), [intent.observation])
  return <div className="space-y-4"><ErrorNotice error={new CollectionUnknown(intent.operation)} /><section className="space-y-3 rounded-lg border p-4"><h3 className="break-words font-semibold">Avvalgi amal: {intent.operation.kind === 'delete' ? 'O‘chirish' : intent.operation.kind === 'update' ? 'Tahrirlash' : 'Yaratish'} · {intent.operation.input.name}</h3><CollectionMembers ids={intent.operation.input.apparatus_ids} names={names} /></section><p className="text-sm text-muted-foreground">Tekshirish faqat joriy ma’lumotni yuklaydi. Asl so‘rov qayta yuborilmaydi.</p><p className="text-xs text-muted-foreground">Avvalgi tanlov shu sessiya xotirasida saqlanmoqda. Sahifani to‘liq yangilash yoki hisobdan chiqish bu tanlovni yo‘qotadi; avval joriy holatni ko‘rib chiqing.</p><Button variant="outline" disabled={checking || !online} onClick={onCheck}><RefreshCw className={checking ? 'animate-spin' : ''} />Serverdagi guruh holatini tekshirish</Button><ErrorNotice error={error} />{intent.observation && <><CollectionObservationView observation={intent.observation} names={names} /><Label htmlFor={`${id}-reviewed`} className="flex items-start gap-3"><Checkbox id={`${id}-reviewed`} checked={reviewed} disabled={checking} onCheckedChange={next => setReviewed(next === true)} /><span className="text-sm leading-relaxed">Avvalgi tanlov va joriy holatni ko‘rdim. Asl so‘rov natijasi tasdiqlanmaganini tushunaman.</span></Label><Button variant="outline" disabled={!reviewed || checking} onClick={onReviewed}>Guruh tekshiruvini yakunlash</Button></>}</div>
}
