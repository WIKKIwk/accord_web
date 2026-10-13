import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, CheckCircle2, Loader2, MapPin, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import { Textarea } from './ui/textarea'
import { formatNumber, text } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import {
  executeInventoryCommand, factoryApparatusChoices, factoryLocationCommand, factoryLocationId, factoryLocations,
  inventoryAssetCommand, inventoryAssetDetail, inventoryAssetKey, inventoryAttempts, inventoryAvailable,
  inventoryLocations, inventoryPermissions, inventoryRelocationChoices, inventoryTransferActions,
  inventoryTransferChoices, inventoryTransferCommand, inventoryTransferDetail, inventoryTransfersPage,
  inventoryWarehouseAllowed, InventoryMutationError, reconcileInventoryCommand,
} from '@/lib/inventory-admin'
import type { FactoryLocation, InventoryAsset, InventoryAttemptLease, InventoryCommand, InventoryTransfer, InventoryTransferAction } from '@/lib/inventory-admin'

type AdminKind = 'assets' | 'locations'
const statusLabels: Record<string, string> = { available: 'Mavjud', transfer_reserved: 'Transfer uchun band', in_transit: 'Yo‘lda', requested: 'So‘ralgan', approved: 'Tasdiqlangan', received: 'Qabul qilingan', rejected: 'Rad etilgan', cancelled: 'Bekor qilingan' }
const assetLabels: Record<string, string> = { raw_material: 'Xomashyo', finished_goods: 'Tayyor mahsulot', qolip: 'Qolip' }
const actionLabels: Record<InventoryTransferAction, string> = { approve: 'Transferni tasdiqlash', reject: 'Transferni rad etish', dispatch: 'Transferni jo‘natish', receive: 'Transferni qabul qilish', cancel: 'Transferni bekor qilish' }
const commandLabels: Record<InventoryCommand['kind'], string> = { relocate: 'Aktivni ko‘chirish', return: 'O‘z omboriga qaytarish', 'transfer-create': 'Omborlararo transfer', 'transfer-action': 'Transfer amali', 'factory-create': 'Zavod joyini yaratish', 'factory-edit': 'Joyni tahrirlash', 'factory-apparatus': 'Apparatlarni bog‘lash' }
const message = (error: unknown) => error instanceof Error ? error.message : 'Amal bajarilmadi.'
const status = (value: unknown) => statusLabels[text(value, '')] ?? `Noma’lum (${text(value)})`

function Notice({ children }: { children: React.ReactNode }) { return <p className="text-sm text-muted-foreground">{children}</p> }
function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <Alert variant="destructive"><AlertDescription className="space-y-2"><p>{error.message}</p><Button type="button" size="sm" variant="outline" onClick={retry}>Qayta yuklash</Button></AlertDescription></Alert>
}
function AssetSummary({ asset }: { asset: InventoryAsset }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{asset.item_name}</p><Badge variant="secondary">{status(asset.status)}</Badge></div><p>{assetLabels[asset.kind]} · {asset.identifier} · {formatNumber(asset.qty)} {asset.uom}</p><p>Joriy joy: {asset.physical_location.name}</p><p className="text-xs text-muted-foreground">Ombor: {asset.custody_warehouse} · {asset.item_code}</p>{asset.transfer_id && <p className="break-all text-xs">Transfer: {asset.transfer_id}</p>}</div>
}
function TransferSummary({ transfer }: { transfer: InventoryTransfer }) {
  return <div className="space-y-3 rounded-lg border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{transfer.source_warehouse} → {transfer.destination_warehouse}</p><Badge variant="secondary">{status(transfer.status)}</Badge></div><p className="break-all text-xs text-muted-foreground">Transfer: {transfer.id}</p><ul className="space-y-2">{transfer.lines.map(line => <li className="border-t pt-2" key={inventoryAssetKey({ kind: line.asset_kind, asset_ref: line.asset_ref })}><p>{assetLabels[text(line.asset_kind)]} · {text(line.identifier, text(line.asset_ref))}</p><p className="text-xs text-muted-foreground">{text(line.item_name, text(line.item_code))} · {formatNumber(line.qty)} {text(line.uom)}</p></li>)}</ul>{text(transfer.note, '') && <p className="whitespace-pre-wrap text-xs">{text(transfer.note)}</p>}</div>
}
function FactorySummary({ location }: { location: FactoryLocation }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{location.name}</p><Badge variant="secondary">{location.active ? 'Faol' : 'Faolsiz'}</Badge></div><p className="break-all text-xs text-muted-foreground">Joy: {location.id}</p>{location.apparatus.length ? <ul className="space-y-1">{location.apparatus.map(row => <li className="text-xs" key={text(row.id)}>{text(row.name, text(row.id))}{row.active === false ? ' · Faolsiz apparat' : ''}</li>)}</ul> : <Notice>Apparat bog‘lanmagan.</Notice>}</div>
}
function CommandSummary({ command }: { command: InventoryCommand }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm"><p className="font-medium">{command.kind === 'transfer-action' && command.action ? actionLabels[command.action] : commandLabels[command.kind]}</p>{command.asset && <p>{assetLabels[command.asset.kind]} · {command.asset.identifier} · {formatNumber(command.asset.qty)} {command.asset.uom}<br />{command.asset.physical_location.name} → {command.destination?.name}</p>}{command.transfer && <TransferSummary transfer={command.transfer} />}{command.factory && <p>{command.factory.name}</p>}{command.body.name !== undefined && <p>Nom: {text(command.body.name)}</p>}{command.body.active !== undefined && <p>Holat: {command.body.active ? 'Faol' : 'Faolsiz'}</p>}{Array.isArray(command.body.apparatus_ids) && <p>Apparatlar: {command.body.apparatus_ids.length}</p>}{text(command.body.note, '') && <p className="whitespace-pre-wrap text-xs">{text(command.body.note)}</p>}</div>
}

/** Retained operations are shared by asset/transfer/factory identity, including closed dialogs. */
function useInventoryOperation(context: string, subjects: string[], onSaved?: () => void) {
  const { client, session, scope, demo, connection } = useSession()
  const queryClient = useQueryClient()
  useSyncExternalStore(inventoryAttempts.subscribe, inventoryAttempts.getRevision, inventoryAttempts.getRevision)
  const attempt = inventoryAttempts.get(scope, context, subjects)
  const [error, setError] = useState('')
  const [mutations] = useState(() => new MutationScope())
  const currentScope = useRef(scope), inFlight = useRef(false), running = useRef<InventoryAttemptLease | null>(null)
  currentScope.current = scope
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['inventory-admin', scope] })
    for (const kind of ['assets', 'locations', 'raw-materials', 'warehouses', 'stock']) {
      void queryClient.invalidateQueries({ queryKey: ['resource', scope, kind] })
      void queryClient.invalidateQueries({ queryKey: ['detail', scope, kind] })
    }
  }
  function interrupt() {
    mutations.cancelAll()
    if (running.current) inventoryAttempts.interrupt(running.current)
    running.current = null
    inFlight.current = false
  }
  useEffect(() => () => {
    mutations.cancelAll()
    if (running.current) inventoryAttempts.interrupt(running.current)
  }, [mutations])
  async function run(command: InventoryCommand, readOnly = false) {
    if (!client || !session || demo || connection === 'offline' || inFlight.current) return
    if (!(command.kind.startsWith('factory-') ? inventoryPermissions(session).factory : inventoryPermissions(session).inventory)) return
    let retained: InventoryAttemptLease
    try { retained = inventoryAttempts.begin(scope, context, command, readOnly || attempt?.phase === 'uncertain') }
    catch (caught) { setError(message(caught)); return }
    const lease = mutations.begin(), requestScope = scope, requestClient = client, requestSession = session
    const current = () => currentScope.current === requestScope && mutations.isCurrent(lease)
    running.current = retained; inFlight.current = true; setError('')
    try {
      const result = readOnly ? await reconcileInventoryCommand(requestClient, command, lease.controller.signal) : null
      const saved = readOnly ? result?.state === 'confirmed' ? result.result : undefined : await executeInventoryCommand(requestClient, requestSession, command, lease.controller.signal, () => inventoryAttempts.dispatched(retained), retained.wasUncertain, value => inventoryAttempts.receipt(retained, value))
      inventoryAttempts.finish(retained, saved ? { result: saved } : { error: 'Amal hozircha serverda tasdiqlanmadi. Avvalgi so‘rov va identifikator saqlanmoqda.', uncertain: true })
      if (!current()) return
      refresh()
      if (saved) { toast.success('Amal serverda tasdiqlandi.'); onSaved?.() }
    } catch (caught) {
      inventoryAttempts.finish(retained, { error: message(caught), uncertain: caught instanceof InventoryMutationError && caught.uncertain })
      if (current()) { setError(message(caught)); refresh() }
    } finally {
      mutations.finish(lease)
      if (running.current === retained) { running.current = null; inFlight.current = false }
    }
  }
  function reset() {
    try { inventoryAttempts.clear(scope, attempt?.context ?? context); setError(''); refresh() }
    catch (caught) { setError(message(caught)) }
  }
  return { attempt, error: error || attempt?.error || '', setError, run, reset, refresh, interrupt, pending: attempt?.phase === 'pending', uncertain: attempt?.phase === 'uncertain', confirmed: attempt?.phase === 'confirmed', locked: Boolean(attempt && ['pending', 'uncertain', 'confirmed'].includes(attempt.phase)) }
}
type Operation = ReturnType<typeof useInventoryOperation>
function OperationState({ operation }: { operation: Operation }) {
  const { attempt, error, pending, uncertain, confirmed } = operation
  const { client, session, demo, connection } = useSession()
  const permissions = inventoryPermissions(session)
  const canResolve = Boolean(client && !demo && connection !== 'offline' && attempt && (attempt.command.kind.startsWith('factory-') ? permissions.factory : permissions.inventory))
  return <div className="space-y-3" aria-live="polite">{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}{pending && <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Server holati tekshirilmoqda…</p>}{(uncertain || confirmed) && attempt && <><CommandSummary command={attempt.command} />{uncertain && <><Notice>Natija aniqlanmaguncha yangi amal boshlanmaydi. Qayta yuborish avvalgi so‘rovni aynan saqlaydi.</Notice><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!canResolve} onClick={() => void operation.run(attempt.command, true)}><RefreshCw />Server holatini tekshirish</Button><Button type="button" variant="outline" disabled={!canResolve} onClick={() => void operation.run(attempt.command)} >Aynan qayta yuborish</Button></div></>}{confirmed && <><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />Amal serverda tasdiqlandi.</p>{attempt.result?.id !== undefined && <p className="break-all text-xs text-muted-foreground">Yozuv: {text(attempt.result.id)}{attempt.result.status !== undefined ? ` · ${status(attempt.result.status)}` : ''}</p>}<Button type="button" variant="outline" onClick={operation.reset}>Yangi amal</Button></>}</>}</div>
}

export function InventoryAdminControls({ kind = 'assets', row, onSaved }: { kind?: AdminKind; row: Row; onSaved?: () => void }) {
  const { scope } = useSession()
  inventoryAttempts.activate(scope)
  if (kind === 'locations') {
    const id = factoryLocationId(row)
    return id ? <FactoryLocationPanel key={`${scope}:factory:${id}`} id={id} onSaved={onSaved} /> : <Notice>{row.kind === 'state' ? 'Zavod joyining haqiqiy identifikatori olinmagan.' : 'Bu ombor yoki tranzit joyi. Zavod joylarini boshqarish ro‘yxatdan ochiladi.'}</Notice>
  }
  const key = inventoryAssetKey(row)
  return key ? <AssetControls key={`${scope}:asset:${key}`} selected={row} onSaved={onSaved} /> : <Notice>Bu yozuv ko‘chirish API’sidagi xomashyo, tayyor mahsulot yoki qolip identifikatoriga ega emas.</Notice>
}

function AssetControls({ selected, onSaved }: { selected: Row; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession()
  const permission = inventoryPermissions(session).inventory, key = inventoryAssetKey(selected)
  const operation = useInventoryOperation(`asset:${key}`, [key], onSaved)
  const [action, setAction] = useState<'relocate' | 'return' | 'transfer-create'>('relocate')
  const [open, setOpen] = useState(false), [destinationId, setDestinationId] = useState(''), [note, setNote] = useState('')
  const noteId = useId()
  const enabled = Boolean(client && session && permission && !demo)
  const asset = useQuery({ queryKey: ['inventory-admin', scope, 'asset', key], queryFn: ({ signal }) => inventoryAssetDetail(client!, selected, signal), enabled, retry: false, staleTime: 5_000, refetchInterval: enabled ? 15_000 : false })
  const locations = useQuery({ queryKey: ['inventory-admin', scope, 'inventory-locations'], queryFn: ({ signal }) => inventoryLocations(client!, signal), enabled, retry: false, staleTime: 5_000 })
  const current = asset.data
  const fresh = Boolean(current && locations.data && !asset.isError && !locations.isError && !asset.isFetching && !locations.isFetching && Date.now() - asset.dataUpdatedAt < 30_000 && Date.now() - locations.dataUpdatedAt < 30_000)
  const allowed = Boolean(current && inventoryAvailable(current) && inventoryWarehouseAllowed(session, current.custody_warehouse))
  const choices = current ? action === 'transfer-create' ? inventoryTransferChoices(current, locations.data ?? []) : inventoryRelocationChoices(current, locations.data ?? []) : []
  const ready = !demo && permission && connection !== 'offline' && fresh && allowed && !operation.locked
  let preview: InventoryCommand | null = null
  if (current && locations.data) try { preview = inventoryAssetCommand(current, locations.data, session, action, destinationId, note, 'preview') } catch { /* Server choices and custody guards control readiness. */ }
  let returnAllowed = false
  if (current && locations.data) try { inventoryAssetCommand(current, locations.data, session, 'return', '', '', 'preview'); returnAllowed = true } catch { /* Native return only accepts a state asset with its own active warehouse. */ }
  function show(value: typeof action) { setAction(value); setDestinationId(''); setNote(''); setOpen(true); operation.refresh() }
  function close(value: boolean) { if (!value) operation.interrupt(); setOpen(value) }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || !current || !locations.data || !preview) return
    try { void operation.run(inventoryAssetCommand(current, locations.data, session, action, destinationId, note)) } catch (caught) { operation.setError(message(caught)) }
  }
  if (!permission) return <Notice>Inventar holatini o‘qish va ko‘chirish uchun ruxsat berilmagan.</Notice>
  if (demo) return <Notice>Ko‘rish rejimida inventar amallari bajarilmaydi.</Notice>
  return <section className="space-y-3 border-t pt-4" aria-label="Inventar amallari"><p className="text-sm font-medium">Inventar amallari</p>{asset.isPending || locations.isPending ? <Skeleton className="h-24 w-full" /> : null}{asset.isError && <Failure error={asset.error} retry={() => void asset.refetch()} />}{locations.isError && <Failure error={locations.error} retry={() => void locations.refetch()} />}{current && !asset.isError && <AssetSummary asset={current} />}{!allowed && current && !asset.isError && <Notice>Band, tranzitdagi yoki ruxsat doirasidan tashqaridagi aktiv ko‘chirilmaydi.</Notice>}{locations.data?.length === 0 && !locations.isError && <Notice>Faol inventar joylari mavjud emas.</Notice>}<div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={!ready || !current || inventoryRelocationChoices(current, locations.data ?? []).length === 0} onClick={() => show('relocate')}><MapPin />Aktivni ko‘chirish</Button><Button type="button" size="sm" variant="outline" disabled={!ready || !returnAllowed} onClick={() => show('return')}>O‘z omboriga qaytarish</Button><Button type="button" size="sm" variant="outline" disabled={!ready || current?.physical_location.kind !== 'warehouse' || !current || inventoryTransferChoices(current, locations.data ?? []).length === 0} onClick={() => show('transfer-create')}><ArrowRightLeft />Omborlararo transfer</Button><Button type="button" size="sm" variant="ghost" disabled={operation.pending} onClick={operation.refresh}><RefreshCw />Yangilash</Button></div><OperationState operation={operation} /><Dialog open={open} onOpenChange={close}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{commandLabels[action]}</DialogTitle><DialogDescription>{action === 'return' ? 'Aktiv o‘z omboriga qaytariladi. Bu oldingi harakatni bekor qilish amali emas.' : action === 'transfer-create' ? 'Butun aktiv tanlangan omborga transfer qilinadi. Server qabul qiluvchi ombor doirasini tekshiradi.' : 'Butun aktiv faol zavod joyiga yoki o‘z omboriga ko‘chiriladi.'}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={submit}>{current && <AssetSummary asset={current} />}{!operation.locked && <>{action !== 'return' && <div className="space-y-2"><Label>Manzil</Label><Select value={destinationId} onValueChange={setDestinationId} disabled={!ready}><SelectTrigger className="w-full" aria-label="Manzil"><SelectValue placeholder="Server ro‘yxatidan joyni tanlang" /></SelectTrigger><SelectContent>{choices.map(row => <SelectItem key={row.id} value={row.id}>{row.name} · {row.kind === 'warehouse' ? 'Ombor' : 'Zavod joyi'}</SelectItem>)}</SelectContent></Select>{choices.length === 0 && <Notice>Mos faol manzil mavjud emas.</Notice>}</div>}<div className="space-y-2"><Label htmlFor={noteId}>Izoh</Label><Textarea id={noteId} value={note} onChange={event => setNote(event.target.value)} disabled={!ready} /></div>{preview && <CommandSummary command={preview} />}</>}<OperationState operation={operation} /><DialogFooter><Button type="button" variant="outline" onClick={() => close(false)}>Yopish</Button>{!operation.locked && <Button type="submit" disabled={!ready || !preview}>Amalni tasdiqlash</Button>}</DialogFooter></form></DialogContent></Dialog></section>
}

/** Actual native transfer lifecycle; cancellation is only available before dispatch. */
export function InventoryTransferControls({ row, onSaved }: { row: Row; onSaved?: () => void }) {
  const { scope } = useSession()
  inventoryAttempts.activate(scope)
  return <TransferControls key={`${scope}:transfer:${text(row.id, '')}`} id={text(row.id, '')} onSaved={onSaved} />
}
function TransferControls({ id, onSaved }: { id: string; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession()
  const permission = inventoryPermissions(session).inventory
  const enabled = Boolean(client && session && permission && !demo && id)
  const detail = useQuery({ queryKey: ['inventory-admin', scope, 'transfer', id], queryFn: ({ signal }) => inventoryTransferDetail(client!, id, signal), enabled, retry: false, staleTime: 5_000, refetchInterval: enabled ? 15_000 : false })
  const current = detail.data
  const subjects = [`transfer:${id}`, ...(current?.lines.map(line => inventoryAssetKey({ kind: line.asset_kind, asset_ref: line.asset_ref })) ?? [])]
  const operation = useInventoryOperation(`transfer:${id}`, subjects, onSaved)
  const [action, setAction] = useState<InventoryTransferAction | null>(null), [note, setNote] = useState('')
  const noteId = useId()
  const fresh = Boolean(current && !detail.isError && !detail.isFetching && Date.now() - detail.dataUpdatedAt < 30_000)
  const ready = !demo && permission && connection !== 'offline' && fresh && !operation.locked
  const actions = current ? inventoryTransferActions(current, session) : []
  function close() { operation.interrupt(); setAction(null) }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || !current || !action || !actions.includes(action)) return
    try { void operation.run(inventoryTransferCommand(current, session, action, note)) } catch (caught) { operation.setError(message(caught)) }
  }
  if (!permission) return <Notice>Transferlarni o‘qish va boshqarish uchun ruxsat berilmagan.</Notice>
  if (demo) return <Notice>Ko‘rish rejimida transfer amallari bajarilmaydi.</Notice>
  if (!id) return <Notice>Transfer identifikatori olinmagan.</Notice>
  return <section className="space-y-3" aria-label="Transfer amallari">{detail.isPending && <Skeleton className="h-24 w-full" />}{detail.isError && <Failure error={detail.error} retry={() => void detail.refetch()} />}{current && !detail.isError && <><TransferSummary transfer={current} /><div className="flex flex-wrap gap-2">{actions.map(value => <Button key={value} type="button" size="sm" variant="outline" disabled={!ready} onClick={() => { setAction(value); setNote(''); operation.refresh() }}>{actionLabels[value]}</Button>)}<Button type="button" size="sm" variant="ghost" disabled={operation.pending} onClick={operation.refresh}><RefreshCw />Yangilash</Button></div>{!actions.length && <Notice>Joriy holat va ombor ruxsatida transfer amali mavjud emas. Jo‘natilgan transfer bekor qilinmaydi.</Notice>}</>}<OperationState operation={operation} /><Dialog open={action !== null} onOpenChange={value => { if (!value) close() }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{action ? actionLabels[action] : 'Transfer amali'}</DialogTitle><DialogDescription>{action === 'cancel' ? 'So‘ralgan yoki tasdiqlangan transfer bekor qilinadi; band qilingan aktivlar bo‘shatiladi.' : 'Server transferning bosqichi va ombor ruxsatini qayta tekshiradi.'}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={submit}>{current && <TransferSummary transfer={current} />}{!operation.locked && <div className="space-y-2"><Label htmlFor={noteId}>Izoh</Label><Textarea id={noteId} value={note} onChange={event => setNote(event.target.value)} disabled={!ready} /></div>}<OperationState operation={operation} /><DialogFooter><Button type="button" variant="outline" onClick={close}>Yopish</Button>{!operation.locked && <Button type="submit" disabled={!ready || !action || !actions.includes(action)}>Amalni tasdiqlash</Button>}</DialogFooter></form></DialogContent></Dialog></section>
}

export function InventoryAdminToolbar({ kind, onSaved }: { kind: AdminKind; onSaved?: () => void }) {
  const { scope } = useSession()
  inventoryAttempts.activate(scope)
  return kind === 'locations' ? <FactoryDirectory key={`${scope}:factory-directory`} onSaved={onSaved} /> : <TransferDirectory key={`${scope}:transfer-directory`} onSaved={onSaved} />
}
function TransferDirectory({ onSaved }: { onSaved?: () => void }) {
  const { client, session, scope, demo } = useSession()
  const [open, setOpen] = useState(false), [direction, setDirection] = useState('all'), [filter, setFilter] = useState('all'), [offset, setOffset] = useState(0), [selectedId, setSelectedId] = useState('')
  const permission = inventoryPermissions(session).inventory
  const list = useQuery({ queryKey: ['inventory-admin', scope, 'transfers', direction, filter, offset], queryFn: ({ signal }) => inventoryTransfersPage(client!, { direction, status: filter === 'all' ? '' : filter, offset, limit: 20 }, signal), enabled: Boolean(open && client && session && permission && !demo), retry: false, staleTime: 5_000 })
  if (!permission) return <Notice>Transferlarni boshqarish uchun ruxsat berilmagan.</Notice>
  return <><Button type="button" variant="outline" disabled={demo || !client} onClick={() => setOpen(true)}><ArrowRightLeft />Ombor transferlari</Button>{demo && <Notice>Ko‘rish rejimida transfer amallari bajarilmaydi.</Notice>}<Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Ombor transferlari</DialogTitle><DialogDescription>Server ruxsat doirasidagi transferlar va ularning haqiqiy holati.</DialogDescription></DialogHeader>{selectedId ? <><Button type="button" variant="ghost" className="justify-self-start" onClick={() => setSelectedId('')}>Ro‘yxatga qaytish</Button><InventoryTransferControls row={{ id: selectedId }} onSaved={onSaved} /></> : <><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Select value={direction} onValueChange={value => { setDirection(value); setOffset(0) }}><SelectTrigger className="w-full" aria-label="Transfer yo‘nalishi"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Barcha yo‘nalishlar</SelectItem><SelectItem value="incoming">Kiruvchi</SelectItem><SelectItem value="outgoing">Chiquvchi</SelectItem></SelectContent></Select><Select value={filter} onValueChange={value => { setFilter(value); setOffset(0) }}><SelectTrigger className="w-full" aria-label="Transfer holati"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Barcha holatlar</SelectItem>{['requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled'].map(value => <SelectItem key={value} value={value}>{status(value)}</SelectItem>)}</SelectContent></Select></div>{list.isPending && <Skeleton className="h-24 w-full" />}{list.isError && <Failure error={list.error} retry={() => void list.refetch()} />}{!list.isError && list.data && <>{list.data.items.length === 0 && <Notice>Tanlangan yo‘nalish va holatda transfer mavjud emas.</Notice>}<div className="space-y-2">{list.data.items.map(row => <Button type="button" variant="outline" className="h-auto w-full justify-between gap-3 whitespace-normal px-3 py-3 text-left" key={text(row.id)} onClick={() => setSelectedId(text(row.id))}><span>{text(row.source_warehouse)} → {text(row.destination_warehouse)}<span className="mt-1 block break-all text-xs text-muted-foreground">{text(row.id)}</span></span><Badge variant="secondary">{status(row.status)}</Badge></Button>)}</div><div className="flex items-center justify-between"><Button type="button" size="sm" variant="outline" disabled={!offset || list.isFetching} onClick={() => setOffset(value => Math.max(0, value - 20))}>Oldingi</Button><Button type="button" size="sm" variant="outline" disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset(value => value + 20)}>Keyingi</Button></div></>}</>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Yopish</Button></DialogFooter></DialogContent></Dialog></>
}

function FactoryDirectory({ onSaved }: { onSaved?: () => void }) {
  const { client, session, scope, demo } = useSession()
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null)
  const permission = inventoryPermissions(session).factory
  const list = useQuery({ queryKey: ['inventory-admin', scope, 'factory-locations'], queryFn: ({ signal }) => factoryLocations(client!, signal), enabled: Boolean(open && client && session && permission && !demo), retry: false, staleTime: 5_000 })
  if (!permission) return <Notice>Zavod joylarini o‘qish va tahrirlash uchun ruxsat berilmagan.</Notice>
  return <><Button type="button" variant="outline" disabled={demo || !client} onClick={() => setOpen(true)}><MapPin />Zavod joylarini boshqarish</Button>{demo && <Notice>Ko‘rish rejimida zavod joylari o‘zgartirilmaydi.</Notice>}<Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Zavod joylari</DialogTitle><DialogDescription>Faol va faolsiz joylar, ularning apparatlari va haqiqiy identifikatorlari.</DialogDescription></DialogHeader>{selected !== null ? <><Button type="button" variant="ghost" className="justify-self-start" onClick={() => setSelected(null)}>Ro‘yxatga qaytish</Button><FactoryLocationPanel key={`${scope}:factory:${selected || 'create'}`} id={selected} onSaved={onSaved} /></> : <><Button type="button" variant="outline" className="justify-self-start" onClick={() => setSelected('')}><Plus />Yangi zavod joyi</Button>{list.isPending && <Skeleton className="h-24 w-full" />}{list.isError && <Failure error={list.error} retry={() => void list.refetch()} />}{list.data && !list.isError && <>{!list.data.length && <Notice>Zavod joylari mavjud emas.</Notice>}<div className="space-y-2">{list.data.map(row => <Button type="button" variant="outline" className="h-auto w-full justify-between gap-3 whitespace-normal px-3 py-3 text-left" key={row.id} onClick={() => setSelected(row.id)}><span>{row.name}<span className="mt-1 block text-xs text-muted-foreground">{row.apparatus.length} apparat · {row.id}</span></span><Badge variant="secondary">{row.active ? 'Faol' : 'Faolsiz'}</Badge></Button>)}</div></>}</>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Yopish</Button></DialogFooter></DialogContent></Dialog></>
}

function FactoryLocationPanel({ id, onSaved }: { id: string; onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession()
  const permissions = inventoryPermissions(session), create = !id
  const operation = useInventoryOperation(create ? 'factory:create' : `factory:${id}`, [create ? 'factory:create' : `factory:${id}`], onSaved)
  const [mode, setMode] = useState<'factory-create' | 'factory-edit' | 'factory-apparatus' | null>(create ? 'factory-create' : null)
  const [name, setName] = useState(''), [active, setActive] = useState(true), [selectedIds, setSelectedIds] = useState<string[]>([])
  const nameId = useId(), activeId = useId()
  const enabled = Boolean(client && session && permissions.factory && !demo)
  const list = useQuery({ queryKey: ['inventory-admin', scope, 'factory-locations'], queryFn: ({ signal }) => factoryLocations(client!, signal), enabled, retry: false, staleTime: 5_000 })
  const bindingMode = mode === 'factory-create' || mode === 'factory-apparatus'
  const catalog = useQuery({ queryKey: ['inventory-admin', scope, 'apparatus'], queryFn: ({ signal }) => client!.listSnapshot('apparatus', { limit: 500 }, signal), enabled: Boolean(enabled && mode && bindingMode && permissions.apparatus), retry: false, staleTime: 5_000 })
  const current = list.data?.find(row => row.id === id)
  const options = factoryApparatusChoices(catalog.data?.items ?? [])
  const fresh = Boolean(list.data && !list.isError && !list.isFetching && Date.now() - list.dataUpdatedAt < 30_000 && (create || current))
  const catalogFresh = Boolean(catalog.data && !catalog.isError && !catalog.isFetching && Date.now() - catalog.dataUpdatedAt < 30_000)
  const canBind = permissions.apparatus && catalogFresh
  const ready = Boolean(client && !demo && permissions.factory && connection !== 'offline' && fresh && !operation.locked && (mode !== 'factory-apparatus' || canBind) && (mode !== 'factory-create' || !permissions.apparatus || catalogFresh))
  let preview: InventoryCommand | null = null
  if (mode && ready) try {
    preview = factoryLocationCommand(session, mode, current ?? null, mode === 'factory-edit' ? { name, active } : { name, apparatus_ids: selectedIds }, catalog.data?.items ?? [], 'preview')
    if (mode === 'factory-edit' && current?.name === name.trim() && current.active === active || mode === 'factory-apparatus' && JSON.stringify(current?.apparatus.map(row => text(row.id, '')).sort()) === JSON.stringify([...selectedIds].sort())) preview = null
  } catch { /* Empty names or inactive/non-canonical apparatus cannot enable a write. */ }
  function edit(value: 'factory-edit' | 'factory-apparatus') {
    if (!current) return
    setName(current.name); setActive(current.active); setSelectedIds(current.apparatus.map(row => text(row.id, ''))); setMode(value); operation.refresh()
  }
  function close() { operation.interrupt(); setMode(null) }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || !mode || !preview) return
    try { void operation.run(factoryLocationCommand(session, mode, current ?? null, mode === 'factory-edit' ? { name, active } : { name, apparatus_ids: selectedIds }, catalog.data?.items ?? [])) } catch (caught) { operation.setError(message(caught)) }
  }
  if (!permissions.factory) return <Notice>Zavod joylarini o‘qish va tahrirlash uchun ruxsat berilmagan.</Notice>
  if (demo) return <Notice>Ko‘rish rejimida zavod joylari o‘zgartirilmaydi.</Notice>
  const form = <form className="space-y-4" onSubmit={submit}>{mode && !operation.locked && <>{mode !== 'factory-apparatus' && <div className="space-y-2"><Label htmlFor={nameId}>Joy nomi</Label><Input id={nameId} value={name} onChange={event => setName(event.target.value)} disabled={!ready} /></div>}{mode === 'factory-edit' && <><div className="flex items-center gap-2"><Checkbox id={activeId} checked={active} onCheckedChange={value => setActive(value === true)} disabled={!ready} /><Label htmlFor={activeId}>Faol joy</Label></div>{!active && <Notice>Faolsiz qilish joy identifikatori, mavjud aktivlar va apparat bog‘lanishlarini saqlaydi. Bu joyga yangi ko‘chirish bajarilmaydi.</Notice>}</>}{bindingMode && <div className="space-y-2"><Label>Apparatlar</Label>{!permissions.apparatus ? <Notice>Apparat ro‘yxatini o‘qish uchun alohida ruxsat kerak. Yangi joy apparatlarsiz yaratiladi.</Notice> : <>{catalog.isPending && <Skeleton className="h-20 w-full" />}{catalog.isError && <Failure error={catalog.error} retry={() => void catalog.refetch()} />}{catalog.data && !catalog.isError && <>{catalog.data.bounded && <Notice>Ro‘yxat cheklangan; faqat serverda tasdiqlangan apparatlar tanlanadi.</Notice>}{!options.length && <Notice>Faol canonical apparat mavjud emas.</Notice>}<div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3">{options.map(row => <label key={row.id} className="flex items-start gap-2 text-sm"><Checkbox checked={selectedIds.includes(row.id)} disabled={!ready || !canBind} onCheckedChange={value => setSelectedIds(ids => value === true ? [...ids.filter(id => id !== row.id), row.id] : ids.filter(id => id !== row.id))} /><span>{row.name}<span className="block break-all text-xs text-muted-foreground">{row.id}</span></span></label>)}</div>{selectedIds.some(value => !options.some(row => row.id === value)) && <div className="space-y-2"><Notice>Avvalgi faol bo‘lmagan yoki ro‘yxatda tasdiqlanmagan apparatlar yangi a’zolikka o‘tkazilmaydi.</Notice>{selectedIds.filter(value => !options.some(row => row.id === value)).map(value => <Button type="button" size="sm" variant="outline" key={value} disabled={!ready} onClick={() => setSelectedIds(ids => ids.filter(id => id !== value))}>{value} ni tanlovdan olib tashlash</Button>)}</div>}</>}</>}<Notice>Tanlov joyning to‘liq apparat a’zoligini almashtiradi.</Notice></div>}{preview && <CommandSummary command={preview} />}</>}<OperationState operation={operation} /><div className="flex flex-wrap justify-end gap-2">{!create && <Button type="button" variant="outline" onClick={close}>Yopish</Button>}{mode && !operation.locked && <Button type="submit" disabled={!ready || !preview}>{create ? 'Zavod joyini yaratish' : 'O‘zgarishni saqlash'}</Button>}</div></form>
  return <section className="space-y-3" aria-label="Zavod joyini boshqarish">{list.isPending && <Skeleton className="h-24 w-full" />}{list.isError && <Failure error={list.error} retry={() => void list.refetch()} />}{!create && !list.isError && list.data && !current && <Notice>Tanlangan zavod joyi haqiqiy server ro‘yxatida mavjud emas. Ro‘yxatni yangilang.</Notice>}{current && !list.isError && <FactorySummary location={current} />}{create ? form : <><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={!fresh || operation.locked || connection === 'offline'} onClick={() => edit('factory-edit')}>Joyni tahrirlash</Button><Button type="button" size="sm" variant="outline" disabled={!fresh || !permissions.apparatus || operation.locked || connection === 'offline'} onClick={() => edit('factory-apparatus')}>Apparatlarni bog‘lash</Button><Button type="button" size="sm" variant="ghost" disabled={operation.pending} onClick={operation.refresh}><RefreshCw />Yangilash</Button></div>{!permissions.apparatus && <Notice>Apparat a’zoligini tanlash uchun apparat ro‘yxatini o‘qish ruxsati kerak.</Notice>}<OperationState operation={operation} /><Dialog open={mode !== null} onOpenChange={value => { if (!value) close() }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{mode === 'factory-apparatus' ? 'Apparatlarni bog‘lash' : 'Joyni tahrirlash'}</DialogTitle><DialogDescription>Joriy joy identifikatori saqlanadi. Server tanlov va mavjud bog‘lanishlarni tekshiradi.</DialogDescription></DialogHeader>{form}</DialogContent></Dialog></>}</section>
}
