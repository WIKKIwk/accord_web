import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, CircleHelp, Expand, Factory, Focus, Link2, Loader2, RefreshCw, Search, Shrink, Tags, Unlink, Wifi, WifiOff, X } from 'lucide-react'
import { toast } from 'sonner'
import { FactoryMapViewer, type FactoryMapObject } from '@/components/FactoryMapViewer'
import { FactoryStageStrip } from '@/components/factory-stage-strip'
import { InfiniteListEnd } from '@/components/infinite-list-end'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { canonicalFactoryMapObjectId, factoryLivePayload, factoryMapApparatus, factoryMapObjectOwners, factoryMapOrderStatus, factoryMapQueueOrderIds, factoryMapStatuses, factoryStockPayload, filterFactoryMapObjects, unboundFactoryMapApparatus, type FactoryMapListFilter } from '@/lib/factory-map'
import { factoryModelObjects } from '@/lib/factory-map-model'
import { formatNumber, isRecord, text, valueAt } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { display } from '@/lib/presentation'
import { useSession } from '@/lib/session'
import { useFactoryMap } from '@/lib/use-factory-map'
import { hasCapability } from '@/lib/permissions'
import { factoryStageForObject, factoryStageOrderChoices, factoryStageRoute } from '@/lib/factory-stage-navigation'
import type { FactoryRouteStage } from '@/lib/factory-stage-navigation'

const message = (error: unknown) => typeof error === 'string' && error ? error : error instanceof Error ? error.message : 'Amal bajarilmadi.'

export default function FactoryMapPage() {
  const { demo, session, connection, scope } = useSession()
  const [params] = useSearchParams()
  const requestedOrderId = params.get('orderId')?.trim() ?? ''
  const data = useFactoryMap()
  const [selected, setSelected] = useState<FactoryMapObject | null>(null)
  const [modelObjects, setModelObjects] = useState<FactoryMapObject[]>(() => factoryModelObjects.map(object => ({ ...object, aliases: [...object.aliases] })))
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FactoryMapListFilter>('all')
  const [modelError, setModelError] = useState('')
  const [modelLoading, setModelLoading] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [resetRevision, setResetRevision] = useState(0)
  const [focusRevision, setFocusRevision] = useState(0)
  const [routeOrderId, setRouteOrderId] = useState(requestedOrderId)
  const [viewedStageKey, setViewedStageKey] = useState('')
  const [stageSelectionIssue, setStageSelectionIssue] = useState('')
  const [bindingId, setBindingId] = useState('')
  const [confirm, setConfirm] = useState<{ row: Row; target: string } | null>(null)
  const [saveError, setSaveError] = useState('')
  const [listLimit, setListLimit] = useState(20)
  const [queueLimit, setQueueLimit] = useState(20)
  const mapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)
  const mapTitleId = useId()
  useEffect(() => {
    setRouteOrderId(requestedOrderId); setViewedStageKey(''); setStageSelectionIssue(''); setSelected(null)
    setResetRevision(value => value + 1)
  }, [scope, requestedOrderId])
  useEffect(() => setListLimit(20), [search, filter])
  useEffect(() => { setQueueLimit(20); setBindingId(''); setSaveError('') }, [selected?.objectId])
  useEffect(() => {
    if (!expanded) return
    const overflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => mapRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }))
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); return }
      if (event.key !== 'Tab') return
      const focusable = [...(mapRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0)
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !mapRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !mapRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = overflow; document.removeEventListener('keydown', keyboard); if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true }) }
  }, [expanded])

  const now = Date.now()
  const live = factoryLivePayload(data.snapshot, data.apparatusRows, data.receivedAt, selected?.objectId ?? '', !data.fresh, now)
  const machines = live.machines
  const stock = factoryStockPayload(data.stockStateData, data.apparatusRows, !data.stockFresh, now)
  const owners = selected ? factoryMapObjectOwners(data.apparatusRows, selected.objectId) : []
  const apparatus = owners.length === 1 ? owners[0]! : null
  const current = apparatus ? machines.find(machine => machine.apparatusId === apparatus.id) : undefined
  const orderId = text(current?.orderId, '')
  const order = data.snapshot?.maps.find(saved => String(saved.map.id) === orderId)?.map
  const effectiveRouteOrderId = routeOrderId || orderId
  const stageRoute = useMemo(() => factoryStageRoute(data.snapshot, effectiveRouteOrderId, data.apparatusRows, modelObjects, data.fresh), [data.snapshot, effectiveRouteOrderId, data.apparatusRows, modelObjects, data.fresh])
  const orderChoices = useMemo(() => factoryStageOrderChoices(data.snapshot), [data.snapshot])
  const viewedStage = stageRoute.stages.find(stage => stage.key === viewedStageKey)
  // A refreshed/edited route cannot leave the previous machine isolated.
  const isolatedObjectId = viewedStage?.objectId && selected?.objectId === viewedStage.objectId ? viewedStage.objectId : ''
  const queueIds = apparatus ? factoryMapQueueOrderIds(data.snapshot, apparatus.id) : []
  const apparatusKnown = !data.loading && !data.apparatusError
  const queueKnown = Boolean(data.snapshot && isRecord(data.snapshot.visible_order_ids))
  const available = unboundFactoryMapApparatus(data.apparatusRows)
  const chosen = available.find(item => item.id === bindingId)
  const canBind = demo || hasCapability(session, 'production.map.manage')
  const visibleObjects = useMemo(() => filterFactoryMapObjects(modelObjects, data.apparatusRows, machines, search, filter), [modelObjects, data.apparatusRows, machines, search, filter])
  const unboundCount = modelObjects.filter(object => !factoryMapObjectOwners(data.apparatusRows, object.objectId).length).length
  const legendStates = [...new Set(machines.map(machine => machine.state))]
  const loadMoreObjects = useCallback(async () => setListLimit(limit => limit + 20), [])
  const loadMoreQueue = useCallback(async () => setQueueLimit(limit => limit + 20), [])
  const selectObject = useCallback((object: FactoryMapObject) => {
    const objectId = canonicalFactoryMapObjectId(object.objectId)
    const machine = machines.find(machine => machine.objectId === objectId)
    const nextOrderId = routeOrderId || text(machine?.orderId, '')
    const route = factoryStageRoute(data.snapshot, nextOrderId, data.apparatusRows, modelObjects, data.fresh)
    const step = factoryStageForObject(route.stages, objectId, nextOrderId === effectiveRouteOrderId ? viewedStageKey : '')
    setRouteOrderId(nextOrderId); setViewedStageKey(step.key); setStageSelectionIssue(nextOrderId ? step.issue : '')
    setSelected({ ...object, objectId })
    setFocusRevision(value => value + 1)
    setExpanded(false)
  }, [machines, routeOrderId, data.snapshot, data.apparatusRows, modelObjects, data.fresh, effectiveRouteOrderId, viewedStageKey])
  const showOverview = useCallback(() => { setSelected(null); setViewedStageKey(''); setStageSelectionIssue(''); setResetRevision(value => value + 1) }, [])
  const selectStage = useCallback((stage: FactoryRouteStage | null) => {
    if (!stage) { showOverview(); return }
    const currentStage = stageRoute.stages.find(candidate => candidate.key === stage.key)
    setViewedStageKey(stage.key); setStageSelectionIssue('')
    const object = currentStage?.objectId ? modelObjects.find(object => canonicalFactoryMapObjectId(object.objectId) === currentStage.objectId) : undefined
    if (!object) { setSelected(null); setResetRevision(value => value + 1); return }
    setSelected({ ...object, objectId: currentStage!.objectId }); setFocusRevision(value => value + 1)
  }, [stageRoute.stages, modelObjects, showOverview])
  useEffect(() => {
    if (!viewedStageKey) return
    if (!viewedStage) { showOverview(); return }
    if (viewedStage.objectId === (selected?.objectId ?? '')) return
    const object = modelObjects.find(object => canonicalFactoryMapObjectId(object.objectId) === viewedStage.objectId)
    setSelected(object ? { ...object, objectId: viewedStage.objectId } : null)
    if (object) setFocusRevision(value => value + 1)
    else setResetRevision(value => value + 1)
  }, [viewedStageKey, viewedStage?.objectId, selected?.objectId, modelObjects, showOverview, viewedStage])
  const confirmPlacement = (row: Row, target: string) => { setSaveError(''); setConfirm({ row, target }) }
  const save = async () => {
    if (!confirm) return
    try {
      await data.savePlacement(confirm.row, confirm.target)
      setConfirm(null); setBindingId('')
      toast.success(confirm.target ? 'Apparat xaritaga biriktirildi.' : 'Apparat xaritadan ajratildi.')
    } catch (error) { setSaveError(message(error)) }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">3D zavod xaritasi</h1><Badge variant="outline">{demo ? 'Ko‘rish rejimi' : 'Ishlab chiqarish'}</Badge></div>
          <p className="text-sm text-muted-foreground">Apparatni tanlang: joriy buyurtma, navbat va ish holatini ko‘ring.</p>
        </div>
        <Button variant="outline" disabled={data.refreshing} onClick={() => void data.refresh()}><RefreshCw className={data.refreshing ? 'animate-spin' : undefined} />Yangilash</Button>
      </div>

      {(data.liveError || data.apparatusError || connection === 'offline') && <Alert><WifiOff /><AlertTitle>Ish holati yangilanmadi</AlertTitle><AlertDescription>{connection === 'offline' ? 'Server bilan aloqa uzilgan.' : message(data.apparatusError || data.liveError)} Apparatlar holati noma’lum deb ko‘rsatiladi. Ulanish tiklangach xarita yangilanadi.</AlertDescription></Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card ref={mapRef} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-labelledby={expanded ? mapTitleId : undefined} className={`gap-0 overflow-hidden py-0 ${expanded ? 'fixed inset-0 z-50 h-svh rounded-none bg-background' : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              {data.fresh ? <Wifi className="size-4 text-emerald-600" /> : <WifiOff className="size-4 text-muted-foreground" />}
              <span id={mapTitleId} className="font-medium">{data.loading ? 'Uskunalar yuklanmoqda…' : data.fresh ? demo ? 'Namunaviy holat' : 'Holat yangilangan' : 'Holat noma’lum'}</span>
              <Badge variant="secondary">{apparatusKnown ? machines.length : '—'} ta biriktirilgan</Badge>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label="Umumiy ko‘rinish" title="Umumiy ko‘rinish" onClick={showOverview}><Focus /><span className="hidden sm:inline">Umumiy ko‘rinish</span></Button>
              <Button size="icon-sm" variant={showLabels ? 'secondary' : 'ghost'} aria-label="Apparat yozuvlarini ko‘rsatish" title="Apparat yozuvlari" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}><Tags /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={expanded ? 'To‘liq ekrandan chiqish' : 'To‘liq ekran'} title={expanded ? 'To‘liq ekrandan chiqish' : 'To‘liq ekran'} onClick={() => setExpanded(value => !value)}>{expanded ? <Shrink /> : <Expand />}</Button>
            </div>
          </div>
          <FactoryMapViewer className={expanded ? 'min-h-0 flex-1' : 'h-[min(65vh,680px)] min-h-[360px] sm:min-h-[480px]'} liveState={live} stockState={stock} selectedObjectId={selected?.objectId ?? ''} focusedObjectId={selected?.objectId ?? ''} isolatedObjectId={isolatedObjectId} stageMotionAllowed={!viewedStage || viewedStage.activeExecution} resetRevision={resetRevision} focusRevision={focusRevision} showLabels={showLabels} renderSuspended={Boolean(confirm)} onObjectTap={selectObject} onObjectsReady={objects => { setModelObjects(objects); setModelLoading(false); setModelError('') }} onError={reason => { setModelError(reason); setModelLoading(false) }} onLoading={() => { setModelLoading(true); setModelError('') }} onClearSelection={showOverview} />
          <FactoryStageStrip route={stageRoute} orderChoices={orderChoices} viewedKey={viewedStageKey} selectionIssue={stageSelectionIssue} onOrderChange={orderId => { setRouteOrderId(orderId); showOverview() }} onStageChange={selectStage} />
          <div className="flex flex-wrap gap-x-4 gap-y-2 border-t px-4 py-3 text-xs" aria-label="Xarita holatlari izohi">{legendStates.map(state => <span key={state} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-black/10" style={{ backgroundColor: factoryMapStatuses[state].color }} />{factoryMapStatuses[state].label}<span className="tabular-nums text-muted-foreground">{machines.filter(machine => machine.state === state).length}</span></span>)}{apparatusKnown && unboundCount > 0 && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><span className="size-2.5 rounded-full border border-dashed border-muted-foreground" />Biriktirilmagan {unboundCount}</span>}{!apparatusKnown && <span className="text-muted-foreground">Biriktirish ma’lumotlari kutilmoqda</span>}</div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <span>Aylantirish: sichqoncha · Zoom: scroll · Siljitish: o‘ng tugma · Tanlash: ro‘yxat yoki klaviatura ← →</span>
            <span>{demo ? 'Lokal namuna' : data.receivedAt ? `${new Date(data.receivedAt).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })} · har 15 soniyada` : 'Holat kutilmoqda'}</span>
          </div>
        </Card>

        <Card className="min-w-0 self-start xl:h-[calc(min(65vh,680px)+146px)] xl:min-h-[626px]">
          <CardHeader>
            <CardTitle>Apparatlar <span className="ml-1 text-sm font-normal text-muted-foreground">{modelObjects.length}</span></CardTitle><CardDescription>Nomi yoki buyurtma raqami bo‘yicha qidiring. Tanlash xaritani apparatga yaqinlashtiradi.</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              <div className="relative"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input aria-label="Xaritadagi apparat yoki buyurtmani qidirish" placeholder="Apparat yoki buyurtma…" className="pr-8 pl-9" value={search} onChange={event => setSearch(event.target.value)} />{search && <Button className="absolute top-1 right-1" size="icon-xs" variant="ghost" aria-label="Apparat qidiruvini tozalash" onClick={() => setSearch('')}><X /></Button>}</div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Apparatlar holati bo‘yicha filtr">{([['all', 'Barchasi'], ['working', 'Ishda'], ['attention', 'E’tibor'], ['unbound', 'Biriktirilmagan']] as const).map(([id, label]) => <Button key={id} size="xs" variant={filter === id ? 'secondary' : 'ghost'} aria-pressed={filter === id} disabled={id !== 'all' && !apparatusKnown} onClick={() => setFilter(id)}>{label}</Button>)}</div>
              <div ref={listRef} className={`min-h-0 space-y-1 overflow-y-auto ${selected ? 'max-h-40 shrink-0' : 'max-h-96 flex-1 xl:max-h-none'}`} aria-label="Xaritadagi apparatlar">
                {visibleObjects.slice(0, listLimit).map(object => {
                  const objectOwners = factoryMapObjectOwners(data.apparatusRows, object.objectId)
                  const machine = machines.find(row => row.objectId === canonicalFactoryMapObjectId(object.objectId))
                  const isSelected = selected?.objectId === canonicalFactoryMapObjectId(object.objectId)
                  return <button key={object.objectId} type="button" aria-pressed={isSelected} className={`flex w-full items-start gap-3 rounded-md px-2 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isSelected ? 'bg-accent ring-1 ring-border' : ''}`} onClick={() => selectObject(object)}>
                    <Factory className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{objectOwners.length === 1 ? objectOwners[0]!.name : object.label}</span><span className="mt-1 block text-xs text-muted-foreground">{objectOwners.length > 1 ? 'Biriktirish ziddiyati' : machine ? `${text(machine.statusLabel)}${objectOwners[0]?.active === false ? ' · Nofaol' : ''}` : apparatusKnown ? 'Biriktirilmagan' : 'Biriktirish holati noma’lum'}</span>{machine?.orderNumber && <span className="mt-1 block text-xs text-muted-foreground">Buyurtma № {machine.orderNumber}</span>}</span>
                    {machine && <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: text(machine.statusColor, '#8b8984') }} />}
                  </button>
                })}
                {!visibleObjects.length && <div className="py-6 text-center text-sm text-muted-foreground"><p>Bu qidiruv yoki filtrga mos apparat topilmadi.</p><Button size="sm" variant="ghost" onClick={() => { setSearch(''); setFilter('all') }}>Filtrni tozalash</Button></div>}
                <InfiniteListEnd root={listRef} hasMore={visibleObjects.length > listLimit} isFetching={false} loadMore={loadMoreObjects} />
              </div>
            {!selected ? <>
              <Separator />
              <div className="flex gap-2 text-xs leading-relaxed text-muted-foreground"><CircleHelp className="mt-0.5 size-4 shrink-0" /><span>Ranglar ERPdagi ish holatini bildiradi. Apparat tanlanganda buyurtmaning rejalashtirilgan yo‘li ko‘rinadi.</span></div>
              {(modelLoading || modelError) && <p className="text-xs text-muted-foreground">{modelError ? '3D model ochilmadi. Apparatlar ro‘yxati va ERP tafsilotlari mavjud.' : '3D model yuklanmoqda. Ro‘yxatdan apparat tanlash mumkin.'}</p>}
            </> : <div className="min-h-0 space-y-4 overflow-y-auto border-t pt-4">
              <div className="flex items-start justify-between gap-2"><h2 className="text-base font-semibold" tabIndex={-1}>{apparatus?.name || selected.label}</h2><Button size="icon-xs" variant="ghost" aria-label="Apparat tafsilotlarini yopish" onClick={showOverview}><X /></Button></div>
              <p className="sr-only" role="status">Tanlangan apparat: {apparatus?.name || selected.label}. {text(current?.statusLabel, 'Biriktirilmagan')}</p>
              {owners.length > 1 ? <Alert variant="destructive"><AlertTitle>Biriktirish ziddiyati</AlertTitle><AlertDescription>Bu obyektga bir nechta ERP apparati biriktirilgan. Uskunalar biriktirishini tekshiring.</AlertDescription></Alert> : apparatus ? <>
              <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary"><span className="size-2 rounded-full" style={{ backgroundColor: text(current?.statusColor, '#8b8984') }} />{text(current?.statusLabel, 'Holat noma’lum')}</Badge><Badge variant="outline">{apparatus.active ? 'Faol' : 'Nofaol'}</Badge></div>
              {viewedStage && <div className="space-y-2 rounded-lg border p-3" data-factory-stage-details><p className="text-xs text-muted-foreground">Ko‘rilayotgan bosqich · {viewedStage.index + 1} / {stageRoute.stages.length}</p><p className="text-sm font-medium">{viewedStage.title}</p><Badge variant="outline">{viewedStage.statusLabel}</Badge><Link className="block text-xs hover:underline" to={`/app/orders?selected=${encodeURIComponent(stageRoute.orderId)}`}>{stageRoute.orderLabel}</Link><p className="text-xs text-muted-foreground">{viewedStage.activeExecution ? 'Shu bosqichning bajarilishi ERPda tasdiqlangan.' : 'Bu tanlov faqat bosqichni ko‘rsatadi. Ish holati alohida kuzatiladi.'}</p>{viewedStage.issue && <p className="text-xs text-muted-foreground">{viewedStage.issue}</p>}</div>}
              <div className="space-y-1 text-sm"><p className="text-xs text-muted-foreground">Operatsiya</p><p>{display(valueAt(apparatus.row, 'runtime_projection.execution_profile.operation') || valueAt(apparatus.row, 'execution_profile.operation'))}</p></div>
              {orderId ? <div className="space-y-2 rounded-lg border p-3"><p className="text-xs text-muted-foreground">{data.fresh ? ['in_progress', 'print_preflight', 'print_preflight_passed', 'paused'].includes(current?.state ?? '') ? 'Joriy buyurtma' : 'Navbatdagi buyurtma' : 'Oxirgi yuklangan buyurtma'}</p><Link className="flex items-center justify-between gap-2 font-medium hover:underline" to={`/app/orders?selected=${encodeURIComponent(orderId)}`}>{text(order?.order_number || order?.code || orderId)}<ArrowUpRight className="size-4" /></Link>{order?.title ? <p className="text-sm">{text(order.title)}</p> : null}<p className="text-xs text-muted-foreground">{text(data.snapshot?.order_customers[orderId] || order?.customer_name)}</p>{order?.order_kg !== undefined && <p className="text-xs text-muted-foreground">Reja: {formatNumber(order.order_kg)} kg</p>}</div> : <p className="text-sm text-muted-foreground">{data.fresh && current?.state === 'idle' ? 'Apparat hozir bo‘sh.' : 'Joriy buyurtma holati noma’lum.'}</p>}
              <Separator />
              <p className="text-sm font-medium">{data.fresh ? 'Buyurtmalar navbati' : 'Oxirgi yuklangan navbat'} <span className="text-muted-foreground">({queueKnown ? queueIds.length : '—'})</span></p>
              <div ref={queueRef} className="min-h-0 max-h-72 flex-1 space-y-1 overflow-y-auto xl:max-h-none">
                {queueIds.slice(0, queueLimit).map(id => {
                  const saved = data.snapshot!.maps.find(item => String(item.map.id) === id)?.map
                  const state = data.fresh ? factoryMapOrderStatus(data.snapshot!, apparatus.id, id) : 'unknown'
                  return <Link key={id} to={`/app/orders?selected=${encodeURIComponent(id)}`} className="block rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"><span className="block text-sm font-medium">{text(saved?.order_number || saved?.code || id)}{id === orderId && <Badge variant="outline" className="ml-2">Tanlangan</Badge>}</span>{saved?.title ? <span className="mt-1 block truncate text-xs">{text(saved.title)}</span> : null}<span className="mt-1 block text-xs text-muted-foreground">{factoryMapStatuses[state].label}</span></Link>
                })}
                {!queueIds.length && <p className="py-4 text-sm text-muted-foreground">{data.fresh && queueKnown ? 'Hozircha navbatda buyurtma yo‘q.' : 'Navbat holati noma’lum.'}</p>}
                <InfiniteListEnd root={queueRef} hasMore={queueIds.length > queueLimit} isFetching={false} loadMore={loadMoreQueue} />
              </div>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={`/app/apparatus?selected=${encodeURIComponent(apparatus.id)}`}>ERP uskunasi<ArrowUpRight /></Link></Button>{canBind && <Button size="sm" variant="ghost" disabled={data.saving} onClick={() => confirmPlacement(apparatus.row, '')}><Unlink />Ajratish</Button>}</div>
            </> : <>
              <Badge variant="outline" className="self-start">{apparatusKnown ? 'Biriktirilmagan' : 'Biriktirish holati noma’lum'}</Badge>
              <p className="text-sm leading-relaxed text-muted-foreground">ERP apparati biriktirilgach uning holati va buyurtmalar navbati shu joyda ko‘rinadi.</p>
              {canBind && <>
                <Select value={bindingId} onValueChange={setBindingId} disabled={data.saving || data.loading || Boolean(data.apparatusError)}><SelectTrigger aria-label="Biriktiriladigan ERP apparati" className="w-full"><SelectValue placeholder="ERP apparatini tanlang" /></SelectTrigger><SelectContent>{available.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
                {!available.length && apparatusKnown && <p className="text-xs text-muted-foreground">Biriktirilmagan faol ERP apparati yo‘q.</p>}
                <Button disabled={!chosen || data.saving || Boolean(data.apparatusError)} onClick={() => chosen && confirmPlacement(chosen.row, selected.objectId)}><Link2 />Apparatni biriktirish</Button>
              </>}
              <Button variant="outline" onClick={showOverview}><ArrowLeft />Apparatlar ro‘yxati</Button>
            </>}</div>}
          </CardContent>
        </Card>
      </div>
      {data.stockError && <p className="text-xs text-muted-foreground">Ombordagi rulonlar holati yangilanmadi: {message(data.stockError)}</p>}
      <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!open && !data.saving) setConfirm(null) }}>
        <DialogContent showCloseButton={!data.saving} onEscapeKeyDown={event => { if (data.saving) event.preventDefault() }} onInteractOutside={event => { if (data.saving) event.preventDefault() }}>
          <DialogHeader><DialogTitle>{confirm?.target ? 'Apparatni biriktirish' : 'Apparatni xaritadan ajratish'}</DialogTitle><DialogDescription>{confirm ? `${factoryMapApparatus(confirm.row).name}${confirm.target ? ` → ${selected?.label || 'tanlangan obyekt'}` : ' ushbu 3D obyektidan ajratiladi.'}` : ''}{demo ? ' O‘zgarish faqat ko‘rish rejimida saqlanadi.' : ''}</DialogDescription></DialogHeader>
          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
          <DialogFooter><Button variant="outline" disabled={data.saving} onClick={() => setConfirm(null)}>Bekor qilish</Button><Button disabled={data.saving} onClick={() => void save()}>{data.saving ? <Loader2 className="animate-spin" /> : confirm?.target ? <Link2 /> : <Unlink />}{confirm?.target ? 'Biriktirish' : 'Ajratish'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
