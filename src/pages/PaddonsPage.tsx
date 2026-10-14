import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, Plus, RefreshCw, Trash2, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { PaddonsApi, PaddonConflict, PaddonUnknown, canReadPaddons, canManagePaddons, createPaddonOperation, deletePaddonOperation, paddonItemsOperation, unlockPaddonOperation, paddonIntentLedger } from '@/lib/paddons'
import type { PaddonOperation, PaddonSnapshot, PaddonSummary } from '@/lib/paddons'
import { PaddonCreateForm, PaddonDestructiveReview, PaddonError, PaddonItems, PaddonList, PaddonLoading, PaddonRecovery, PaddonSummaryView } from '@/components/paddon-controls'
import { PaddonHandoffToolbar } from '@/components/paddon-handoff-controls'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function PaddonsPage() { const { scope } = useSession(); return <PaddonsContent key={scope} /> }
const retryAllowed = (error: unknown) => !(error instanceof ApiError && [401, 403].includes(error.status))
type View = { kind: 'create' | 'recovery' } | { kind: 'detail'; code: string }
function PaddonsContent() {
  const { session, client, demo, scope, connection } = useSession(), queryClient = useQueryClient()
  const api = useMemo(() => session && client && !demo && canReadPaddons(session) ? new PaddonsApi(client, session) : null, [session, client, demo])
  const manage = canManagePaddons(session), online = connection === 'online'
  const ledger = useMemo(() => paddonIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  const leases = useMemo(() => new MutationScope(), []), busy = useRef(false)
  const [search, setSearch] = useState(''), [code, setCode] = useState(''), [view, setView] = useState<View | null>(null), [error, setError] = useState<unknown>(null), [checking, setChecking] = useState(false)
  const list = useQuery({ queryKey: ['paddons', scope], queryFn: ({ signal }) => api!.list(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => () => leases.cancelAll(), [leases])
  useEffect(() => { if (!intent) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [intent])
  function open(code: string) { if (intent || busy.current) return; const trimmed = code.trim(); if (!trimmed) return; setError(null); setView({ kind: 'detail', code: trimmed }) }
  function lookup(event: FormEvent) { event.preventDefault(); open(code) }
  async function execute(operation: PaddonOperation, done: (result: PaddonSummary | PaddonSnapshot | null) => void) {
    if (!api || !manage || !online || busy.current || ledger.snapshot()) return
    busy.current = true; setError(null); ledger.begin(operation); const lease = leases.begin()
    try {
      const saved = await api.execute(operation, lease.controller.signal)
      if (!leases.isCurrent(lease)) { ledger.unknown(operation); return }
      ledger.finish(operation); void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) }); done(saved)
      toast.success({ create: 'Paddon yaratildi.', delete: 'Paddon o‘chirildi.', add: 'Partiyalar paddonga qo‘shildi.', remove: 'Partiyalar paddondan olindi.', unlock: 'Paddon qayta ochildi.' }[operation.kind])
    } catch (failure) { if (failure instanceof PaddonUnknown) ledger.unknown(operation); else ledger.finish(operation); if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false }
  }
  async function observe() {
    const current = ledger.snapshot(); if (!api || connection === 'checking' || busy.current || current?.status !== 'unknown') return
    busy.current = true; setError(null); setChecking(true); const lease = leases.begin()
    try { const observation = await api.observe(current.operation, lease.controller.signal); if (leases.isCurrent(lease)) { ledger.observe(current.operation, observation); if (observation.state === 'listed') queryClient.setQueryData(['paddons', scope], { items: observation.paddons, bounded: observation.bounded }) } }
    catch (failure) { if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (!lease.controller.signal.aborted) setChecking(false) }
  }
  const pending = intent?.status === 'pending', recovery = intent?.status === 'unknown' && !!view
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Box className="size-4" />Ish jarayoni</div><h1 className="text-2xl font-semibold tracking-tight">Paddonlar</h1><p className="max-w-2xl text-sm text-muted-foreground">Mahsulot partiyalarini birlashtiring, tarkibni tekshiring va ruxsat berilgan paddonlarni boshqaring.</p></div><div className="flex flex-wrap gap-2"><PaddonHandoffToolbar /><Button variant="outline" disabled={!api || list.isFetching || !!intent} onClick={() => void list.refetch()}><RefreshCw className={list.isFetching ? 'animate-spin' : ''} />Yangilash</Button>{manage && <Button disabled={!api || !online || !!intent} onClick={() => { setError(null); setView({ kind: 'create' }) }}><Plus />Yangi paddon</Button>}</div></header>
    {demo && <Alert><AlertDescription>Ko‘rish rejimida paddon serveri ishlatilmaydi. Paddonlarni boshqarish uchun ERP serveriga kiring.</AlertDescription></Alert>}
    {!manage && <p className="text-sm text-muted-foreground">Paddonni o‘zgartirish uchun ruxsat yetarli emas.</p>}
    {intent && <Alert><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{pending ? 'Paddon amali yuborilmoqda. Sahifani yopish serverdagi amalni bekor qilishini kafolatlamaydi.' : 'Avvalgi paddon amali natijasi noma’lum. Yangi amal boshlashdan oldin joriy holatni tekshiring.'}</span><Button size="sm" variant="outline" disabled={pending} onClick={() => { setError(null); setView({ kind: 'recovery' }) }}>Natijani tekshirish</Button></AlertDescription></Alert>}
    {api && <section className="space-y-4 rounded-xl border bg-muted/10 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Serverdan yuklangan paddonlar</h2>{list.data && <Badge variant="outline">{list.data.items.length} ta yuklangan</Badge>}</div><div className="grid items-end gap-4 lg:grid-cols-2"><div className="space-y-2"><Label htmlFor="paddon-search">Yuklangan paddonlarni qidirish</Label><Input id="paddon-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Kod, joylashuv yoki muallif" /></div><form onSubmit={lookup} className="space-y-2"><Label htmlFor="paddon-code">Paddon kodi</Label><div className="flex gap-2"><Input id="paddon-code" value={code} onChange={event => setCode(event.target.value)} placeholder="Kod bilan to‘g‘ridan-to‘g‘ri ochish" /><Button type="submit" variant="outline" disabled={!code.trim() || !!intent || !online}>Ochish</Button></div></form></div><p className="text-xs text-muted-foreground">Eng so‘nggi 200 tagacha ko‘rinadigan paddon yuklanadi. Qidiruv shu ro‘yxatda ishlaydi; eski paddonni kodi bilan oching.</p>{list.data?.bounded && <p className="text-xs text-muted-foreground">200 ta paddon chegarasiga yetildi. Serverda boshqa paddonlar ham bo‘lishi mumkin.</p>}</section>}
    {api && list.isPending ? <PaddonLoading /> : api && list.error ? <div className="space-y-3"><PaddonError error={list.error} />{retryAllowed(list.error) && <Button variant="outline" onClick={() => void list.refetch()}>Paddonlarni qayta yuklash</Button>}</div> : list.data && <PaddonList rows={list.data.items} search={search} disabled={!!intent || !online || list.isFetching} onOpen={open} />}
    <Dialog open={!!view} onOpenChange={open => { if (!open) setView(null) }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{recovery ? 'Paddon amali natijasini tekshirish' : view?.kind === 'create' ? 'Yangi paddon' : view?.kind === 'detail' ? view.code : 'Paddon amali'}</DialogTitle><DialogDescription>{recovery ? 'Avval yuborilgan tanlov va serverdagi joriy ma’lumotni ko‘rib chiqing.' : 'Ma’lumot va ruxsatlar ulangan ERP serveridan olinadi.'}</DialogDescription></DialogHeader>
      {recovery && intent ? <PaddonRecovery key={intent.operation.code + intent.operation.kind} intent={intent} checking={checking} online={connection !== 'checking'} error={error instanceof PaddonUnknown ? null : error} onCheck={() => void observe()} onReviewed={() => { ledger.resolveReviewed(intent.operation); setError(null); setView(null); void list.refetch() }} /> : view?.kind === 'create' ? <PaddonCreateForm pending={pending} online={online} error={error} onCancel={() => setView(null)} onCreate={input => { try { void execute(createPaddonOperation(input), saved => { if (saved && 'code' in saved) setView(current => current?.kind === 'create' ? { kind: 'detail', code: saved.code } : current) }) } catch (failure) { setError(failure) } }} /> : view?.kind === 'detail' && api ? <PaddonDetail key={view.code} code={view.code} api={api} scope={scope} manage={manage} pending={pending} online={online} error={error} clearError={() => setError(null)} execute={execute} close={() => setView(null)} /> : null}
      <DialogFooter><Button variant="outline" onClick={() => setView(null)}>Oynani yopish</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>
}
function PaddonDetail({ code, api, scope, manage, pending, online, error, clearError, execute, close }: { code: string; api: PaddonsApi; scope: string; manage: boolean; pending: boolean; online: boolean; error: unknown; clearError: () => void; execute: (op: PaddonOperation, done: (result: PaddonSummary | PaddonSnapshot | null) => void) => Promise<void>; close: () => void }) {
  const queryClient = useQueryClient(), [mode, setMode] = useState<'assigned' | 'available'>('assigned'), [selected, setSelected] = useState<string[]>([]), [review, setReview] = useState<'delete' | 'unlock' | null>(null)
  const query = useQuery({ queryKey: ['paddon-detail', scope, code], queryFn: ({ signal }) => api.detail(code, signal), retry: false, staleTime: 0, refetchOnWindowFocus: false }), snapshot = query.data
  const ready = query.isFetchedAfterMount && !query.isFetching && !query.error, blocked = pending || !online || !ready || !!error
  function done(saved: PaddonSummary | PaddonSnapshot | null) { if (saved && 'paddon' in saved) queryClient.setQueryData(['paddon-detail', scope, code], saved); setSelected([]); setReview(null); if (!saved) close() }
  async function reload() { const result = await query.refetch(); if (!result.error) { clearError(); setSelected([]); setReview(null) } }
  if (query.isPending) return <PaddonLoading label="Paddon tarkibi yuklanmoqda…" />
  if (query.error || !snapshot) return <div className="space-y-3"><PaddonError error={query.error} />{retryAllowed(query.error) && <Button variant="outline" onClick={() => void reload()}>Paddonni qayta yuklash</Button>}</div>
  const writable = manage && snapshot.can_manage_items, rows = mode === 'assigned' ? snapshot.items : snapshot.available_items
  return <div className="space-y-5"><PaddonSummaryView snapshot={snapshot} />
    {review ? <PaddonDestructiveReview snapshot={snapshot} kind={review} pending={pending} online={online && !blocked} error={error} onBack={() => setReview(null)} onSubmit={() => { if (blocked) return; void execute(review === 'delete' ? deletePaddonOperation(snapshot.paddon) : unlockPaddonOperation(snapshot), done) }} /> : <>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-2" aria-label="Paddon tarkibi ko‘rinishi"><Button variant={mode === 'assigned' ? 'default' : 'outline'} disabled={pending} onClick={() => { setMode('assigned'); setSelected([]) }}>Tarkib · {snapshot.items.length}</Button>{writable && <Button variant={mode === 'available' ? 'default' : 'outline'} disabled={pending} onClick={() => { setMode('available'); setSelected([]) }}>Qo‘shish uchun partiyalar</Button>}</div><Button variant="ghost" disabled={pending || query.isFetching} onClick={() => void reload()}><RefreshCw className={query.isFetching ? 'animate-spin' : ''} />Tarkibni yangilash</Button></div>
      {mode === 'available' && <><p className="text-sm text-muted-foreground">{snapshot.free_movement_enabled ? 'Server ko‘chirishga ruxsat bergan partiyalar ko‘rsatilgan. Tanlangan partiyalar boshqa paddondan ko‘chishi mumkin.' : 'Server qaytargan, paddonga biriktirilmagan partiyalar ko‘rsatilgan.'}</p>{rows.length >= 500 && <p className="text-xs text-muted-foreground">Qo‘shish uchun 500 tagacha partiya qaytdi. Bu barcha mavjud partiyalar sonini bildirmaydi.</p>}</>}
      <PaddonItems key={mode} rows={rows} selected={selected} selectable={writable} disabled={blocked} adding={mode === 'available'} movableOnly={snapshot.free_movement_enabled} onSelection={setSelected} />
      {writable && <div className="flex flex-wrap justify-end gap-2"><Button disabled={blocked || !selected.length || selected.length > 500} onClick={() => void execute(paddonItemsOperation(mode === 'available' ? 'add' : 'remove', snapshot, selected), done)}>{mode === 'available' ? <Plus /> : <Trash2 />}{mode === 'available' ? 'Tanlanganlarni qo‘shish' : 'Tanlanganlarni olish'}{selected.length > 0 && ` · ${selected.length}`}</Button></div>}
      <PaddonError error={error} />{pending && <PaddonLoading label="Paddon amali yakuni kutilmoqda…" />}
      {manage && <div className="flex flex-wrap justify-between gap-2 border-t pt-4">{snapshot.paddon.item_count === 0 && snapshot.paddon.locked_at_unix === null && <Button variant="outline" disabled={blocked} onClick={() => setReview('delete')}><Trash2 />O‘chirishni ko‘rib chiqish</Button>}{snapshot.can_unlock && <Button variant="outline" disabled={blocked} onClick={() => setReview('unlock')}><Unlock />Qayta ochishni ko‘rib chiqish</Button>}</div>}
    </>}
    {!!error && !(error instanceof PaddonUnknown) && <div className="space-y-2"><p className="text-sm text-muted-foreground">Amal yuborilmadi yoki server rad etdi. Joriy tarkib va ruxsatlarni ko‘rib, tanlovni qayta boshlang.</p>{error instanceof PaddonConflict || retryAllowed(error) ? <Button variant="outline" disabled={pending || query.isFetching || !online} onClick={() => void reload()}>Joriy tarkibni ko‘rib qayta boshlash</Button> : null}</div>}
  </div>
}
