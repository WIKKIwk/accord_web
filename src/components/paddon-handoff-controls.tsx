import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Box, Check, Link2, RefreshCw, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { PaddonHandoffApi, PaddonHandoffUnknown, canUsePaddonHandoff, canCreatePaddonSuccessor, choosePaddonOperation, clearPaddonOperation, nextPaddonOperation, paddonHandoffIntentLedger } from '@/lib/paddon-handoff'
import type { ActivePaddonSelection, PaddonHandoffIntent, PaddonHandoffOperation } from '@/lib/paddon-handoff'
import type { PaddonList, PaddonSnapshot, PaddonSummary } from '@/lib/paddons'
import { PaddonError, PaddonLoading } from './paddon-controls'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export function PaddonHandoffToolbar({ apparatusId }: { apparatusId?: string }) {
  const { session, scope, demo } = useSession(), [openScope, setOpenScope] = useState<string | null>(null), trigger = useRef<HTMLButtonElement>(null)
  const ledger = useMemo(() => paddonHandoffIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  useEffect(() => { if (!intent) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [intent])
  if (!canUsePaddonHandoff(session)) return null
  return <><Button ref={trigger} variant="outline" disabled={demo} title={demo ? 'Ko‘rish rejimida server tanlovi o‘zgarmaydi.' : undefined} onClick={() => setOpenScope(scope)}><Box />Faol kesish paddoni{intent && <Badge variant="secondary">{intent.status === 'unknown' ? 'Tekshirish kerak' : 'Yuborilmoqda'}</Badge>}</Button>{openScope === scope && <PaddonHandoffManager key={scope} initialApparatus={apparatusId} onClose={() => setOpenScope(null)} returnFocus={() => trigger.current?.focus()} />}</>
}
export function HandoffSelectionView({ active, explainOutput = true }: { active: ActivePaddonSelection; explainOutput?: boolean }) {
  return <section className="space-y-1 rounded-lg border bg-muted/20 p-3" aria-label="Serverdagi faol paddon">
    <p className="break-all font-semibold">{active.code ? `Faol paddon: ${active.code}` : 'Faol paddon tanlanmagan.'}</p>
    <p className="break-all text-xs text-muted-foreground">{active.apparatus}</p>
    {explainOutput && <p className="text-xs text-muted-foreground">Yangi rulon uchun server joriy tanlovni qayta o‘qiydi. Tanlovsiz yangi rulon paddonga biriktirilmaydi.</p>}
  </section>
}
export function HandoffPaddonChoices({ list, selectedCode, disabled, onSelect }: { list: PaddonList; selectedCode: string; disabled: boolean; onSelect: (code: string) => void }) {
  const [search, setSearch] = useState(''), shown = list.items.filter(row => [row.code, row.location, row.note].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  return <section className="space-y-3"><Input aria-label="Tanlash uchun paddonlarni qidirish" placeholder="Kod, joylashuv yoki izoh bo‘yicha qidiring" value={search} onChange={event => setSearch(event.target.value)} /><div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-1 sm:grid-cols-2" aria-label="Tanlanadigan ochiq paddonlar">{!shown.length && <p className="p-3 text-sm text-muted-foreground sm:col-span-2">{list.items.length ? 'Qidiruvga mos paddon topilmadi. Tanlangan kod saqlanmoqda.' : 'Tanlash uchun ochiq paddonlar yo‘q.'}</p>}{shown.map(row => <Button key={row.id} className="h-auto w-full justify-between gap-3 whitespace-normal px-3 py-2 text-left" variant={selectedCode === row.code ? 'secondary' : 'ghost'} disabled={disabled} aria-pressed={selectedCode === row.code} aria-label={`${row.code} paddonini tanlash`} onClick={() => onSelect(row.code)}><span className="min-w-0"><span className="block break-all font-semibold">{row.code}</span><span className="block break-words text-xs text-muted-foreground">{row.location || 'Joylashuv ko‘rsatilmagan'} · {row.item_count} partiya</span></span>{selectedCode === row.code && <Check className="shrink-0" />}</Button>)}</div>{list.bounded && <p className="text-xs text-muted-foreground">200 tagacha ochiq paddon yuklandi. Bu barcha paddonlar soni emas; eski paddonni kodi bilan tanlang.</p>}</section>
}
export function HandoffRecovery({ intent, checking, canCheck, error, onCheck, onReviewed }: { intent: PaddonHandoffIntent; checking: boolean; canCheck: boolean; error: unknown; onCheck: () => void; onReviewed: () => void }) {
  const id = useId(), [reviewed, setReviewed] = useState(false), operation = intent.operation
  return <div className="space-y-4"><PaddonError error={new PaddonHandoffUnknown(operation)} /><section className="space-y-2 rounded-lg border p-4"><h3 className="font-semibold">Avvalgi amal: {operation.kind === 'next' ? 'Keyingi paddon' : operation.kind === 'clear' ? 'Tanlovni tozalash' : 'Faol paddonni tanlash'}</h3><p className="break-all text-sm">Apparat: {operation.apparatus}</p><p className="break-all text-sm">{operation.kind === 'next' ? 'Bosish qulfi bor manba' : 'Yuborilgan tanlov'}: {operation.code || 'Paddon tanlanmagan'}</p></section><details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Tekshiruv haqida</summary><p className="pt-2">Asl so‘rov qayta yuborilmaydi. Keyingi paddon uchun takroriy so‘rov mavjud paddonni qayta faollashtirib, boshqa qurilmadagi tanlovni almashtirishi mumkin. Avvalgi amal shu sessiya xotirasida saqlanmoqda. To‘liq yangilash yoki hisobdan chiqish bu ma’lumotni yo‘qotadi.</p></details><Button variant="outline" disabled={checking || !canCheck} onClick={() => { setReviewed(false); onCheck() }}><RefreshCw className={checking ? 'animate-spin' : ''} />Joriy faol paddonni tekshirish</Button><PaddonError error={error} />
    {intent.observation && <><HandoffSelectionView active={intent.observation.active} explainOutput={false} /><p className="text-sm">{intent.observation.state === 'matches' ? 'Joriy tanlov yuborilgan qiymatga mos.' : intent.observation.state === 'different' ? 'Joriy tanlov yuborilgan qiymatdan farq qiladi.' : 'Bu joriy tanlov; yo‘qolgan javobdagi keyingi paddon aniqlanmagan.'} Bu asl amal natijasini tasdiqlamaydi.</p><Label htmlFor={`${id}-reviewed`} className="flex items-start gap-3"><Checkbox id={`${id}-reviewed`} checked={reviewed} disabled={checking} onCheckedChange={next => setReviewed(next === true)} /><span className="text-sm">Avvalgi amal va joriy tanlovni ko‘rdim. Asl javob tasdiqlanmaganini tushunaman.</span></Label><Button variant="outline" disabled={!reviewed || checking} onClick={onReviewed}>Faol paddon tekshiruvini yakunlash</Button></>}
  </div>
}
function PaddonHandoffManager({ initialApparatus, onClose, returnFocus }: { initialApparatus?: string; onClose: () => void; returnFocus: () => void }) {
  const { client, session, scope, demo, connection } = useSession(), queryClient = useQueryClient()
  const api = useMemo(() => client && session && !demo && canUsePaddonHandoff(session) ? new PaddonHandoffApi(client, session) : null, [client, session, demo])
  const ledger = useMemo(() => paddonHandoffIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot), leases = useMemo(() => new MutationScope(), []), busy = useRef(false)
  const [apparatus, setApparatus] = useState(initialApparatus || ''), [apparatusSearch, setApparatusSearch] = useState(''), [mode, setMode] = useState<'choose' | 'next'>('choose'), [draftCode, setDraftCode] = useState<string | null>(null), [sourceCode, setSourceCode] = useState(''), [source, setSource] = useState<PaddonSnapshot | null>(null), [readingSource, setReadingSource] = useState(false), [confirmed, setConfirmed] = useState(false), [error, setError] = useState<unknown>(null), [checking, setChecking] = useState(false), [last, setLast] = useState<{ active: ActivePaddonSelection; paddon?: PaddonSummary } | null>(null)
  const catalog = useQuery({ queryKey: ['handoff-apparatus', scope, apparatusSearch], queryFn: ({ signal }) => api!.apparatus(apparatusSearch, signal), enabled: !!api && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const apparatusId = apparatus
  const projection = useQuery({ queryKey: ['handoff-projection', scope, apparatusId], queryFn: ({ signal }) => api!.projection(apparatusId, signal), enabled: !!api && !!apparatusId && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const active = useQuery({ queryKey: ['handoff-active', scope, apparatusId], queryFn: ({ signal }) => api!.active(apparatusId, signal), enabled: !!api && !!projection.data && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  const paddons = useQuery({ queryKey: ['handoff-selectable', scope], queryFn: ({ signal }) => api!.selectable(signal), enabled: !!api && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => { if (!apparatus && catalog.data?.items[0]) setApparatus(catalog.data.items[0].apparatus_id) }, [apparatus, catalog.data])
  useEffect(() => () => leases.cancelAll(), [leases])
  const pending = intent?.status === 'pending', recovery = intent?.status === 'unknown', ready = !!active.data && active.isFetchedAfterMount && projection.isFetchedAfterMount && !active.error && !projection.error && !active.isFetching && !projection.isFetching, blocked = !!intent || connection !== 'online' || !ready || !!error
  const selectedCode = draftCode ?? active.data?.code ?? '', nextAllowed = canCreatePaddonSuccessor(session, apparatusId)
  function reset() { setDraftCode(null); setSource(null); setConfirmed(false); setLast(null); setError(null) }
  async function refresh() { if (pending || !api) return; const result = await active.refetch(); if (!result.error) { reset(); void paddons.refetch(); void projection.refetch() } }
  async function execute(operation: PaddonHandoffOperation) {
    if (!api || blocked || busy.current || ledger.snapshot()) return
    busy.current = true; setError(null); ledger.begin(operation); const lease = leases.begin()
    try { const result = await api.execute(operation, lease.controller.signal); if (!leases.isCurrent(lease)) { ledger.unknown(operation); return }; ledger.finish(operation); setLast(result); setDraftCode(null); setSource(null); setConfirmed(false); queryClient.setQueryData(['handoff-active', scope, operation.apparatus], result.active); void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) }); toast.success(operation.kind === 'next' ? 'Keyingi paddon serverda tayinlandi.' : operation.kind === 'clear' ? 'Faol paddon tanlovi tozalandi.' : 'Faol paddon tanlovi saqlandi.') }
    catch (failure) { if (failure instanceof PaddonHandoffUnknown) ledger.unknown(operation); else ledger.finish(operation); if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false }
  }
  function submitOperation(make: () => PaddonHandoffOperation) { try { void execute(make()) } catch (failure) { setError(failure) } }
  async function observe() {
    const current = ledger.snapshot(); if (!api || busy.current || connection === 'checking' || current?.status !== 'unknown') return
    busy.current = true; setChecking(true); setError(null); const lease = leases.begin()
    try { const observation = await api.observe(current.operation, lease.controller.signal); if (leases.isCurrent(lease)) ledger.observe(current.operation, observation) }
    catch (failure) { if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (!lease.controller.signal.aborted) setChecking(false) }
  }
  async function inspectSource(event: FormEvent) {
    event.preventDefault(); if (!api || blocked || readingSource) return; setReadingSource(true); setSource(null); setConfirmed(false); const lease = leases.begin()
    try { const value = await api.detail(sourceCode, lease.controller.signal); if (leases.isCurrent(lease)) { setSource(value); setError(null) } }
    catch (failure) { if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); if (!lease.controller.signal.aborted) setReadingSource(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); returnFocus() }}>
      <DialogHeader className="shrink-0 border-b p-4 pr-12 sm:p-5 sm:pr-12">
        <DialogTitle>{recovery ? 'Faol paddon amali natijasini tekshirish' : 'Faol kesish paddoni'}</DialogTitle>
        <DialogDescription>Tanlov shu hisob va kesish apparatiga tegishli.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto p-4 sm:p-5" data-handoff-scroll>
        {recovery && intent ? <HandoffRecovery key={intent.operation.apparatus + intent.operation.kind} intent={intent} checking={checking} canCheck={connection !== 'checking'} error={error instanceof PaddonHandoffUnknown ? null : error} onCheck={() => void observe()} onReviewed={() => { ledger.resolveReviewed(intent.operation); setApparatus(intent.operation.apparatus); reset(); void active.refetch() }} /> : <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="handoff-apparatus-search">Kesish apparatini qidirish</Label><Input id="handoff-apparatus-search" value={apparatusSearch} disabled={!!intent || readingSource} onChange={event => setApparatusSearch(event.target.value)} /></div>
            <div className="space-y-2"><Label>Kesish apparati</Label>
              {catalog.isPending ? <PaddonLoading label="Kesish apparatlari yuklanmoqda…" /> : catalog.error ? <><PaddonError error={catalog.error} />{!(catalog.error instanceof ApiError && [401, 403].includes(catalog.error.status)) && <Button variant="outline" disabled={pending} onClick={() => void catalog.refetch()}>Kesish apparatlarini qayta yuklash</Button>}</> : catalog.data && !catalog.data.items.length ? <p className="text-sm text-muted-foreground">Qidiruvga mos faol kesish apparati yo‘q.</p> : <Select value={apparatusId || undefined} disabled={!!intent || readingSource} onValueChange={value => { leases.cancelAll(); setApparatus(value); reset() }}><SelectTrigger className="w-full" aria-label="Kesish apparati"><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{projection.data && !catalog.data?.items.some(row => row.apparatus_id === apparatusId) && <SelectItem value={apparatusId}>{projection.data.display.display_name}</SelectItem>}{catalog.data?.items.map(row => <SelectItem key={row.apparatus_id} value={row.apparatus_id}>{row.display.display_name}</SelectItem>)}</SelectContent></Select>}
            </div>
          </div>
          {catalog.data?.bounded && <p className="text-xs text-muted-foreground">500 tagacha apparat o‘qildi; ro‘yxatdagi kesish apparatlari ko‘rsatilgan.</p>}
          {projection.isPending && !!apparatusId || active.isPending && !!projection.data ? <PaddonLoading label="Serverdagi faol paddon yuklanmoqda…" /> : projection.error || active.error ? <><PaddonError error={projection.error || active.error} />{!(projection.error instanceof ApiError && [401, 403].includes(projection.error.status) || active.error instanceof ApiError && [401, 403].includes(active.error.status)) && <Button variant="outline" disabled={pending} onClick={() => { void projection.refetch(); void active.refetch() }}>Tanlovni qayta yuklash</Button>}</> : active.data && <HandoffSelectionView active={active.data} />}
          {active.data && <>
            <div className="flex flex-wrap gap-2"><Button variant={mode === 'choose' ? 'default' : 'outline'} disabled={!!intent} onClick={() => { setMode('choose'); reset() }}>Faol paddon tanlash</Button>{nextAllowed && <Button variant={mode === 'next' ? 'default' : 'outline'} disabled={!!intent} onClick={() => { setMode('next'); reset() }}><ArrowRight />Keyingi paddonga o‘tish</Button>}<Button variant="ghost" disabled={!!intent || active.isFetching} onClick={() => void refresh()}><RefreshCw className={active.isFetching ? 'animate-spin' : ''} />Tanlovni yangilash</Button></div>
            {mode === 'choose' ? <>
              <p className="text-sm text-muted-foreground">Ochiq va omborga qabul qilinmagan paddonni tanlang.</p>
              {paddons.isPending ? <PaddonLoading label="Ochiq paddonlar yuklanmoqda…" /> : paddons.error ? <><PaddonError error={paddons.error} />{!(paddons.error instanceof ApiError && [401, 403].includes(paddons.error.status)) && <Button variant="outline" disabled={pending} onClick={() => void paddons.refetch()}>Ochiq paddonlarni qayta yuklash</Button>}</> : paddons.data && <HandoffPaddonChoices list={paddons.data} selectedCode={selectedCode} disabled={blocked} onSelect={setDraftCode} />}
              <div className="space-y-2"><Label htmlFor="handoff-code">Faol paddon uchun kod</Label><Input id="handoff-code" value={selectedCode} disabled={blocked} onChange={event => setDraftCode(event.target.value)} placeholder="Eski paddonni kodi bilan tanlang" /></div>
            </> : <>
              <Alert><AlertDescription>Qulflangan paddondan keyingisini oching. Yangi yoki mavjud keyingi paddon shu hisobning faol tanloviga aylanadi.</AlertDescription></Alert>
              <form className="space-y-2" onSubmit={event => void inspectSource(event)}><Label htmlFor="handoff-source">Bosish qulfi bor paddon kodi</Label><div className="flex gap-2"><Input id="handoff-source" value={sourceCode} disabled={blocked || readingSource} onChange={event => { setSourceCode(event.target.value); setSource(null); setConfirmed(false) }} /><Button variant="outline" type="submit" disabled={blocked || readingSource || !sourceCode.trim()}>Manbani tekshirish</Button></div></form>
              {readingSource && <PaddonLoading label="Manba paddon tekshirilmoqda…" />}
              {source && <><section className="space-y-2 rounded-lg border p-3" aria-label="Paddon tafsilotlari"><div className="flex items-center justify-between gap-3"><p className="font-semibold">Manba paddon: {source.paddon.code}</p><Badge variant="outline">{source.paddon.locked_at_unix === null ? 'Ochiq' : 'Bosish qulfi bor'}</Badge></div><p className="text-xs text-muted-foreground">{source.paddon.item_count} partiya · {source.paddon.created_by_display_name || 'Muallif ko‘rsatilmagan'}</p></section>{source.paddon.locked_at_unix === null ? <p className="text-sm text-muted-foreground">Bu paddonda bosish qulfi yo‘q. Keyingi paddon amali yuborilmaydi.</p> : <Label className="flex items-start gap-3"><Checkbox checked={confirmed} disabled={blocked} onCheckedChange={next => setConfirmed(next === true)} /><span className="text-sm">Keyingi paddon shu hisob va apparatning faol tanlovini almashtirishini tasdiqlayman.</span></Label>}</>}
            </>}
          </>}
          <PaddonError error={error} />{!!error && !(error instanceof PaddonHandoffUnknown) && <Button variant="outline" disabled={pending || active.isFetching} onClick={() => void refresh()}>Joriy tanlovni ko‘rib qayta boshlash</Button>}
          {pending && <PaddonLoading label="Faol paddon amali yakuni kutilmoqda…" />}
        </div>}
      </div>
      <div className="shrink-0 border-t bg-background p-3 sm:p-4" data-handoff-footer>
        {!recovery && last && <p role="status" className="mb-3 text-sm">Server javobidagi tanlov: {last.active.code || 'tanlanmagan'}.</p>}
        <DialogFooter className="m-0 grid grid-cols-2 gap-2 rounded-none border-0 bg-transparent p-0 sm:flex sm:flex-row">
          {!recovery && active.data && mode === 'choose' && <><Button variant="outline" disabled={blocked || !active.data.code} onClick={() => submitOperation(() => clearPaddonOperation(active.data!))}><Unlink />Faol tanlovni tozalash</Button><Button className="order-last col-span-2 sm:order-none" disabled={blocked || !selectedCode.trim() || selectedCode.trim() === active.data.code} onClick={() => submitOperation(() => choosePaddonOperation(active.data!, selectedCode))}><Link2 />Faol paddonni saqlash</Button></>}
          {!recovery && active.data && mode === 'next' && source && source.paddon.locked_at_unix !== null && <Button className="col-span-2" disabled={blocked || !confirmed || !nextAllowed} onClick={() => submitOperation(() => nextPaddonOperation(active.data!, source.paddon))}><ArrowRight />Keyingi paddonni ochish</Button>}
          <Button variant="outline" className={!active.data || recovery || mode === 'next' ? 'col-span-2' : undefined} onClick={onClose}>Oynani yopish</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
}
