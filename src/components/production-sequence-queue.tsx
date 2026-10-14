import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical, Loader2, LockKeyhole, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { text } from '@/lib/api'
import type { ProductionSnapshot } from '@/lib/api-types'
import { demoProductionSnapshot, getDemoPage } from '@/lib/demo'
import { factoryMapApparatus } from '@/lib/factory-map'
import { MutationScope } from '@/lib/mutation-scope'
import { canViewPage } from '@/lib/permissions'
import { productionCanManageOrders } from '@/lib/production-controls'
import { productionOperationLedger, type ProductionOperationLease } from '@/lib/production-operation-ledger'
import { executeProductionSequenceMove, productionSequenceMove, productionSequenceQueue, SequenceMoveError, type SequenceMovePlan, type SequenceQueueRow } from '@/lib/production-sequence'
import { useSession } from '@/lib/session'
import { isHandoffCutApparatus } from '@/lib/paddon-handoff'
import { OrderImageThumbnail } from './order-image-controls'
import { orderPhotoReference } from "@/lib/order-photo";
import { PaddonHandoffToolbar } from './paddon-handoff-controls'

const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'Navbat amali bajarilmadi.'
const isAbort = (value: unknown) => value instanceof DOMException && value.name === 'AbortError'
interface QueueProps { apparatusId: string; onApparatusChange: (id: string) => void }

export function ProductionSequenceQueue(props: QueueProps) {
  const { scope } = useSession()
  productionOperationLedger.activate(scope)
  return <SequenceQueuePanel key={scope} {...props} />
}

function SequenceQueuePanel({ apparatusId, onApparatusChange }: QueueProps) {
  const { client, session, demo, scope, connection, reconnect } = useSession()
  const queryClient = useQueryClient(), queryKey = [scope, 'production-snapshot']
  const snapshot = useQuery({ queryKey, queryFn: ({ signal }) => demo ? Promise.resolve(structuredClone(demoProductionSnapshot)) : client!.productionSnapshot(signal), enabled: Boolean(demo || client && canViewPage(session, 'orders')), staleTime: 5_000, refetchInterval: demo ? false : 15_000 })
  const apparatus = useQuery({ queryKey: [scope, 'production-control-apparatus'], queryFn: ({ signal }) => demo ? Promise.resolve(getDemoPage('apparatus', { limit: 500 })) : client!.listSnapshot('apparatus', { limit: 500 }, signal), enabled: Boolean(demo || client && canViewPage(session, 'apparatus')), staleTime: 60_000 })
  const options = useMemo(() => {
    const names = new Map((apparatus.data?.items ?? []).map(factoryMapApparatus).filter(item => item.id).map(item => [item.id, item.name]))
    const ids = new Set([...names.keys(), ...Object.keys(snapshot.data?.sequences ?? {}), ...Object.keys(snapshot.data?.visible_order_ids ?? {})])
    return [...ids].filter(id => /^apparatus:[^\s]+$/.test(id)).map(id => ({ id, name: names.get(id) || id })).sort((left, right) => left.name.localeCompare(right.name, 'uz'))
  }, [apparatus.data, snapshot.data])
  const selectedId = apparatusId || options[0]?.id || ''
  const name = options.find(option => option.id === selectedId)?.name || selectedId
  const [search, setSearch] = useState(''), [confirm, setConfirm] = useState<SequenceMovePlan | null>(null)
  const [dragSnapshot, setDragSnapshot] = useState<ProductionSnapshot | null>(null)
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false), [announcement, setAnnouncement] = useState('')
  const [reducedMotion, setReducedMotion] = useState(false)
  const [focusRequested, setFocusRequested] = useState(false), [permissionDenied, setPermissionDenied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null), focusOrderId = useRef(''), refreshRef = useRef<HTMLButtonElement>(null), recoveryRef = useRef<HTMLButtonElement>(null)
  const dndId = useId(), instructionsId = useId()
  const mutations = useMemo(() => new MutationScope(), []), identity = useRef({ client, scope, session })
  identity.current = { client, scope, session }
  const busy = useRef(false), activeAttempt = useRef<ProductionOperationLease | null>(null)
  useSyncExternalStore(productionOperationLedger.subscribe, productionOperationLedger.getRevision, productionOperationLedger.getRevision)
  const attempts = productionOperationLedger.list(scope)
  const apparatusAttempt = attempts.find(entry => entry.apparatusId === selectedId)
  const ownAttempt = apparatusAttempt?.channel === 'sequence-reorder' ? productionOperationLedger.get<SequenceMovePlan>(scope, apparatusAttempt.orderId, 'sequence-reorder') : null
  const uncertain = ownAttempt?.phase === 'uncertain' ? ownAttempt : null
  const queue = productionSequenceQueue(dragSnapshot || snapshot.data, selectedId, session)
  const fresh = Boolean(snapshot.data && !snapshot.isError && Date.now() - snapshot.dataUpdatedAt < 30_000)
  const canChange = !demo && Boolean(client) && connection === 'online' && fresh && !snapshot.isFetching && !saving && !needsRefresh && !permissionDenied && !apparatusAttempt && queue.canReorder && !search.trim() && !confirm
  const draftIds = confirm?.apparatusId === selectedId ? confirm.displayIds : queue.rows.map(row => row.id)
  const displayed = draftIds.flatMap(id => queue.rows.find(row => row.id === id) ?? []).filter(row => !search.trim() || [row.label, row.product, row.customer, row.id].some(value => value.toLocaleLowerCase('uz').includes(search.trim().toLocaleLowerCase('uz'))))
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => () => {
    mutations.cancelAll()
    if (activeAttempt.current) productionOperationLedger.interrupt(activeAttempt.current)
  }, [mutations])
  useEffect(() => {
    mutations.cancelAll()
    if (activeAttempt.current) productionOperationLedger.interrupt(activeAttempt.current)
    activeAttempt.current = null; busy.current = false
    setSaving(false); setConfirm(null); setDragSnapshot(null)
  }, [client, session, mutations])
  useEffect(() => {
    if (!focusRequested || saving || snapshot.isFetching || confirm) return
    const row = [...(rootRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-order-id]') ?? [])].find(row => row.dataset.orderId === focusOrderId.current)
    const handle = row?.querySelector<HTMLButtonElement>('button')
    const target = handle && !handle.disabled ? handle : recoveryRef.current && !recoveryRef.current.disabled ? recoveryRef.current : refreshRef.current
    target?.focus(); setFocusRequested(false)
  }, [focusRequested, saving, snapshot.isFetching, confirm])

  const publish = async (value: ProductionSnapshot | undefined, plan: SequenceMovePlan, current: () => boolean) => {
    if (!value || !current()) return
    await queryClient.cancelQueries({ queryKey, exact: true })
    if (!current()) return
    queryClient.setQueryData<ProductionSnapshot>(queryKey, before => {
      if (before && (before.scope !== value.scope || before.epoch === value.epoch && before.rev > value.rev || before.epoch !== value.epoch && before.epoch !== plan.epoch)) return before
      return value
    })
  }
  const invalidate = () => { void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) && query.queryKey.some(part => typeof part === 'string' && ['production-snapshot', 'orders', 'maps', 'dashboard'].includes(part)) }) }
  const refresh = async () => {
    if (saving) return
    if (connection !== 'online') await reconnect()
    const result = await snapshot.refetch()
    if (result.isSuccess) { setNeedsRefresh(false); setError(''); void queryClient.invalidateQueries({ queryKey: ['order-image-thumb', scope] }) }
  }
  const propose = (orderId: string, destination: number, source = snapshot.data) => {
    if (!canChange || !source || busy.current || productionOperationLedger.get(scope, orderId) || productionOperationLedger.list(scope).some(entry => entry.apparatusId === selectedId)) return
    try {
      const plan = productionSequenceMove(source, selectedId, orderId, destination, session)
      if (!plan) { setAnnouncement('Navbat o‘rni o‘zgarmadi. Ishdagi buyurtmalar chegarasi saqlandi.'); return }
      focusOrderId.current = orderId
      setConfirm(plan); setError('')
      setAnnouncement(`${plan.orderLabel}: ${plan.fromPosition}-o‘rindan ${plan.toPosition}-o‘ringa. Saqlashni tasdiqlang.`)
    } catch (failure) { setError(errorMessage(failure)) }
  }
  const dragEnd = ({ active, over }: DragEndEvent) => {
    const source = dragSnapshot || snapshot.data
    setDragSnapshot(null)
    if (over && active.id !== over.id) propose(String(active.id), queue.rows.findIndex(row => row.id === over.id), source)
  }
  const closeConfirmation = () => {
    if (saving) {
      mutations.cancelAll()
      if (activeAttempt.current) productionOperationLedger.interrupt(activeAttempt.current)
      activeAttempt.current = null; busy.current = false; setSaving(false)
    }
    setConfirm(null)
  }
  const save = async (plan: SequenceMovePlan, recovery = false) => {
    if (!client || busy.current || demo || connection !== 'online' || !recovery && !confirm) return
    let ownership: ProductionOperationLease
    try { ownership = productionOperationLedger.begin(scope, { channel: 'sequence-reorder', orderId: plan.orderId, apparatusId: plan.apparatusId, plan, proof: { actor: plan.actor } }, recovery) }
    catch (failure) { setError(errorMessage(failure)); return }
    activeAttempt.current = ownership; busy.current = true; setSaving(true); setError('')
    const lease = mutations.begin(), captured = { client, scope, session }
    const current = () => mutations.isCurrent(lease) && identity.current.client === captured.client && identity.current.scope === captured.scope && identity.current.session === captured.session
    try {
      const result = await executeProductionSequenceMove(client, session, plan, lease.controller.signal, current, recovery, () => {
        if (!productionOperationLedger.dispatched(ownership)) throw new DOMException('Navbat buyrug‘i doirasi o‘zgargan.', 'AbortError')
      })
      if (!current()) return
      productionOperationLedger.finish(ownership, { confirmed: true })
      await publish(result.snapshot, plan, current)
      if (!current()) return
      setConfirm(null); setNeedsRefresh(!result.snapshot)
      const notice = result.receipt.adjusted ? 'Navbat server ruxsat qilgan eng yaqin o‘ringa surildi.' : 'Apparat navbati saqlandi.'
      toast.success(notice); setAnnouncement(notice)
      if (!result.snapshot) setError('Navbat serverda tasdiqlandi. Joriy navbat hali olinmadi; ma’lumotlarni yangilang.')
      invalidate()
    } catch (failure) {
      if (!current() || isAbort(failure)) { productionOperationLedger.interrupt(ownership); return }
      if (failure instanceof SequenceMoveError && failure.definitive && !recovery) productionOperationLedger.finish(ownership, { confirmed: true })
      else productionOperationLedger.finish(ownership, { error: errorMessage(failure), uncertain: true })
      if (failure instanceof SequenceMoveError) await publish(failure.snapshot, plan, current)
      if (!current()) return
      setError(errorMessage(failure)); setConfirm(null)
      if (failure instanceof SequenceMoveError && failure.kind === 'forbidden') setPermissionDenied(true)
      if (failure instanceof SequenceMoveError && failure.kind === 'conflict') invalidate()
    } finally {
      productionOperationLedger.interrupt(ownership)
      if (activeAttempt.current === ownership) activeAttempt.current = null
      if (mutations.isCurrent(lease)) { busy.current = false; setSaving(false) }
      mutations.finish(lease)
    }
  }
  const labelFor = (id: string | number) => queue.rows.find(row => row.id === String(id))?.label || String(id)

  return <Card ref={rootRef} aria-label="Apparat navbatini tartiblash">
    <CardHeader className="gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><CardTitle>Apparat navbati</CardTitle><CardDescription>Buyurtmalarni dastasidan tortib suring yoki oldinga / orqaga tugmalaridan foydalaning.</CardDescription></div><Button ref={refreshRef} size="sm" variant="outline" onClick={() => void refresh()} disabled={saving || snapshot.isFetching}><RefreshCw className={snapshot.isFetching ? 'animate-spin' : undefined} />Navbatni yangilash</Button></div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selectedId || undefined} onValueChange={id => { closeConfirmation(); setDragSnapshot(null); setSearch(''); setError(''); onApparatusChange(id) }} disabled={saving}><SelectTrigger className="w-full sm:w-72" aria-label="Navbat apparati"><SelectValue placeholder="Apparatni tanlang" /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent></Select>
        <div className="relative w-full sm:w-64"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Navbatdan qidirish" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buyurtma yoki mijoz…" disabled={saving || Boolean(confirm)} /></div>
        <span className="text-xs text-muted-foreground">{queue.rows.length} ta buyurtma</span>{demo && <Badge variant="outline">DEMO · faqat ko‘rish</Badge>}
        {apparatus.data?.items.some(row => factoryMapApparatus(row).id === selectedId && isHandoffCutApparatus(row)) && <PaddonHandoffToolbar apparatusId={selectedId} />}
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <p id={instructionsId} className="text-xs text-muted-foreground">Dastada Space yoki Enter: ko‘tarish / qo‘yish. ↑ / ↓: surish. Escape: bekor qilish. Ishdagi, to‘xtatilgan va muzlatilgan buyurtmalar qulflangan.</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      {search.trim() && <Alert><AlertDescription>Qidirish paytida navbat o‘zgartirilmaydi. Surish uchun qidirishni tozalang.</AlertDescription></Alert>}
      {queue.reason && snapshot.data && <Alert><AlertDescription>{queue.reason}</AlertDescription></Alert>}
      {permissionDenied && <Alert><AlertDescription>Server navbatni o‘zgartirishga ruxsat bermadi. Yangi surish yopiq. <Link to="/kirish">Ruxsatlar yangilangach qayta kiring.</Link></AlertDescription></Alert>}
      {(snapshot.isError || connection === 'offline' || needsRefresh || !fresh && snapshot.data) && <Alert variant="destructive"><TriangleAlert /><AlertTitle>Joriy navbat yangilanishi kerak</AlertTitle><AlertDescription>{snapshot.isError ? errorMessage(snapshot.error) : connection === 'offline' ? 'Server bilan aloqa uzilgan. Avval aloqa va navbatni yangilang.' : 'Oxirgi yuklangan holat ko‘rsatilmoqda. Yangilangan navbat olinmaguncha surish yopiq.'}</AlertDescription></Alert>}
      {uncertain && <Alert><TriangleAlert /><AlertTitle>Navbat buyrug‘i natijasi noaniq</AlertTitle><AlertDescription className="space-y-2"><p>{uncertain.error}</p><p>Buyurtma № {uncertain.plan.orderLabel}. Asl buyruq shu sessiyada saqlanmoqda. Joriy navbatni o‘qish bu buyruq tasdig‘ining o‘rnini bosmaydi.</p><Button ref={recoveryRef} size="sm" variant="outline" className="mt-2" disabled={saving || connection !== 'online' || !productionCanManageOrders(session)} onClick={() => void save(uncertain.plan, true)}>{saving ? <Loader2 className="animate-spin" /> : <RefreshCw />}Asl navbat buyrug‘i natijasini tekshirish</Button></AlertDescription></Alert>}
      {apparatusAttempt && !uncertain && <Alert><AlertDescription>{apparatusAttempt.channel === 'sequence-reorder' ? 'Navbat buyrug‘i tekshirilmoqda. Natija aniqlanguncha shu apparatdagi yangi surish yopiq.' : <span>Shu apparatning boshqa navbat buyrug‘i natijasi kutilmoqda. <Link className="underline" to={`/app/orders?selected=${encodeURIComponent(apparatusAttempt.orderId)}`}>Buyurtma boshqaruvini oching</Link>.</span>}</AlertDescription></Alert>}
      {error && !uncertain && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {snapshot.isLoading ? <div role="status" aria-label="Navbat yuklanmoqda"><Skeleton className="h-10" /><Skeleton className="mt-2 h-40" /></div> : !selectedId ? <p className="py-8 text-center text-sm text-muted-foreground">Apparat navbatlari mavjud emas.</p> : <div className="motion-list-enter overflow-hidden rounded-lg border" data-motion-list data-list-state="ready">
        {/* Adapted from the audited shadcn dashboard-01 sortable-row pattern.
            See docs/third-party/sequence-reorder.md and shadcn-ui-MIT.txt. */}
        <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={() => { if (canChange && snapshot.data) setDragSnapshot(structuredClone(snapshot.data)) }} onDragEnd={dragEnd} onDragCancel={() => { setDragSnapshot(null); setAnnouncement('Surish bekor qilindi. Navbat o‘zgarmadi.') }} accessibility={{ screenReaderInstructions: { draggable: 'Navbat dastasida Space yoki Enter bilan buyurtmani ko‘taring, yuqoriga yoki pastga strelka bilan suring, Space yoki Enter bilan qo‘ying. Escape bilan bekor qiling.' }, announcements: { onDragStart: ({ active }) => `${labelFor(active.id)} ko‘tarildi.`, onDragOver: ({ active, over }) => over ? `${labelFor(active.id)}: ${labelFor(over.id)} o‘rniga surilmoqda.` : 'Buyurtma jadval tashqarisida.', onDragEnd: ({ active, over }) => over ? `${labelFor(active.id)} qo‘yildi. Yangi o‘rinni saqlashni tasdiqlang.` : 'Surish bekor qilindi.', onDragCancel: () => 'Surish bekor qilindi. Navbat o‘zgarmadi.' } }}>
          <Table aria-label={`${name} buyurtma navbati`} aria-describedby={instructionsId}>
            <TableHeader className="bg-muted/40"><TableRow><TableHead className="w-12"><span className="sr-only">Surish</span></TableHead><TableHead className="w-14">№</TableHead><TableHead>Buyurtma</TableHead><TableHead>Holat</TableHead><TableHead className="hidden md:table-cell">Mijoz</TableHead><TableHead className="text-right">Navbat</TableHead></TableRow></TableHeader>
            <TableBody><SortableContext items={displayed.map(row => row.id)} strategy={verticalListSortingStrategy}>{displayed.map(row => {
              const index = queue.rows.findIndex(item => item.id === row.id)
              const lockedElsewhere = Boolean(productionOperationLedger.get(scope, row.id))
              const enabled = canChange && !row.locked && !lockedElsewhere
              const possible = (delta: number) => {
                if (!enabled || !snapshot.data || index + delta < 0 || index + delta >= queue.rows.length) return false
                try { return Boolean(productionSequenceMove(snapshot.data, selectedId, row.id, index + delta, session, 'preview-only')) } catch { return false }
              }
              return <SortableQueueRow key={row.id} row={row} position={draftIds.indexOf(row.id) + 1} enabled={enabled} reducedMotion={reducedMotion} reason={lockedElsewhere ? 'Buyurtmaning avvalgi ishlab chiqarish amali natijasi kutilmoqda.' : row.reason} up={possible(-1)} down={possible(1)} onMove={delta => propose(row.id, index + delta)} />
            })}</SortableContext>{!displayed.length && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">{search.trim() ? 'Qidiruvga mos buyurtma topilmadi.' : 'Bu apparat navbati bo‘sh.'}</TableCell></TableRow>}</TableBody>
          </Table>
        </DndContext>
      </div>}
      {apparatus.isError && <p className="text-xs text-muted-foreground">Apparat nomlari olinmadi; haqiqiy identifikatorlar ko‘rsatilmoqda.</p>}
      <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!open) closeConfirmation() }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); setFocusRequested(true) }}><DialogHeader><DialogTitle>Navbat o‘rnini saqlash</DialogTitle><DialogDescription>Buyurtma № {confirm?.orderLabel} · {options.find(option => option.id === confirm?.apparatusId)?.name || confirm?.apparatusId}. {confirm?.fromPosition}-o‘rindan {confirm?.toPosition}-o‘ringa suriladi. Server navbatning joriy versiyasini tekshiradi.</DialogDescription></DialogHeader>
          {confirm?.clamped && <p className="text-sm text-muted-foreground">Ishdagi yoki to‘xtatilgan buyurtmalardan oldinga o‘tish mumkin emas; eng yaqin ruxsat etilgan o‘rin tanlandi.</p>}
          {saving && <p role="status" className="text-sm text-muted-foreground">Navbat buyrug‘i yuborilmoqda. Oyna yopilsa, yuborilgan buyruq natijasi alohida tekshiriladi.</p>}
          <DialogFooter><Button variant="outline" onClick={closeConfirmation}>{saving ? 'Yopish' : 'Bekor qilish'}</Button><Button disabled={saving || connection !== 'online'} onClick={() => confirm && void save(confirm)}>{saving && <Loader2 className="animate-spin" />}Navbatni saqlash</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>
}

function SortableQueueRow({ row, position, enabled, reducedMotion, reason, up, down, onMove }: { row: SequenceQueueRow; position: number; enabled: boolean; reducedMotion: boolean; reason: string; up: boolean; down: boolean; onMove: (delta: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: { draggable: !enabled, droppable: false }, transition: reducedMotion ? null : undefined })
  return <TableRow ref={setNodeRef} data-order-id={row.id} data-dragging={isDragging || undefined} className="relative data-[dragging=true]:z-10 data-[dragging=true]:bg-muted data-[dragging=true]:opacity-80" style={{ transform: CSS.Transform.toString(transform), transition: reducedMotion ? undefined : transition }}>
    <TableCell><Button ref={setActivatorNodeRef} {...attributes} {...listeners} variant="ghost" size="icon-sm" disabled={!enabled} aria-label={`Navbatni surish: ${row.label}`} className="touch-none text-muted-foreground" title={reason || 'Buyurtmani navbatda surish'}>{row.locked ? <LockKeyhole className="size-4" /> : <GripVertical className="size-4" />}</Button></TableCell>
    <TableCell className="tabular-nums text-muted-foreground">{position}</TableCell>
    <TableCell className="min-w-44"><div className="flex items-center gap-3"><OrderImageThumbnail photo={orderPhotoReference("orders", { id: row.id })} title={row.label} /><div className="min-w-0"><Link to={`/app/orders?selected=${encodeURIComponent(row.id)}`} className="font-medium hover:underline">№ {row.label}</Link>{row.product && <p className="mt-0.5 max-w-72 truncate text-xs text-muted-foreground">{row.product}</p>}{reason && <p className="mt-1 max-w-72 whitespace-normal text-xs text-muted-foreground">{reason}</p>}</div></div></TableCell>
    <TableCell><Badge variant="outline">{row.statusLabel}</Badge></TableCell><TableCell className="hidden max-w-64 truncate text-muted-foreground md:table-cell">{text(row.customer)}</TableCell>
    <TableCell><div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" disabled={!up} onClick={() => onMove(-1)} aria-label={`${row.label}: navbatda oldinga`}><ArrowUp className="size-4" /></Button><Button size="icon-sm" variant="ghost" disabled={!down} onClick={() => onMove(1)} aria-label={`${row.label}: navbatda orqaga`}><ArrowDown className="size-4" /></Button></div></TableCell>
  </TableRow>
}
