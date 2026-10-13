import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, CircleHelp, Expand, Factory, Focus, Link2, Loader2, RefreshCw, Search, Shrink, Tags, Unlink, Wifi, WifiOff, X } from 'lucide-react'
import { toast } from 'sonner'
import { FactoryMapViewer, type FactoryMapObject } from '@/components/FactoryMapViewer'
import { InfiniteListEnd } from '@/components/infinite-list-end'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { canonicalFactoryMapObjectId, factoryLivePayload, factoryMapApparatus, factoryMapObjectOwners, factoryMapOrderStatus, factoryMapQueueOrderIds, factoryMapStatuses, factoryStockPayload, unboundFactoryMapApparatus } from '@/lib/factory-map'
import { formatNumber, text, valueAt } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { display } from '@/lib/presentation'
import { useSession } from '@/lib/session'
import { useFactoryMap } from '@/lib/use-factory-map'

const message = (error: unknown) => typeof error === 'string' && error ? error : error instanceof Error ? error.message : 'Amal bajarilmadi.'

export default function FactoryMapPage() {
  const { demo, session } = useSession()
  const data = useFactoryMap()
  const [selected, setSelected] = useState<FactoryMapObject | null>(null)
  const [modelObjects, setModelObjects] = useState<FactoryMapObject[]>([])
  const [search, setSearch] = useState('')
  const [showLabels, setShowLabels] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [resetRevision, setResetRevision] = useState(0)
  const [bindingId, setBindingId] = useState('')
  const [confirm, setConfirm] = useState<{ row: Row; target: string } | null>(null)
  const [saveError, setSaveError] = useState('')
  const [listLimit, setListLimit] = useState(20)
  const [queueLimit, setQueueLimit] = useState(20)
  const mapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)
  useEffect(() => setListLimit(20), [search])
  useEffect(() => { setQueueLimit(20); setBindingId(''); setSaveError('') }, [selected?.objectId])
  useEffect(() => {
    if (!expanded) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('keydown', escape)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', escape) }
  }, [expanded])

  const now = Date.now()
  const live = factoryLivePayload(data.snapshot, data.apparatusRows, data.receivedAt, selected?.objectId ?? '', !data.fresh, now)
  const machines = live.machines
  const stock = factoryStockPayload(data.stockStateData, data.apparatusRows, !data.stockFresh, now)
  const owners = selected ? factoryMapObjectOwners(data.apparatusRows, selected.objectId) : []
  const apparatus = owners.length === 1 ? owners[0]! : null
  const current = apparatus ? machines.find(machine => machine.apparatusId === apparatus.id) : undefined
  const orderId = text(current?.orderId, '')
  const order = data.snapshot?.maps.find(saved => saved.map.id === orderId)?.map
  const queueIds = apparatus ? factoryMapQueueOrderIds(data.snapshot, apparatus.id).filter(id => data.snapshot?.maps.some(saved => saved.map.id === id)) : []
  const available = unboundFactoryMapApparatus(data.apparatusRows)
  const chosen = available.find(item => item.id === bindingId)
  const canBind = demo || Boolean(session?.capabilities.includes('production.map.manage'))
  const visibleObjects = useMemo(() => modelObjects.filter(object => {
    const names = factoryMapObjectOwners(data.apparatusRows, object.objectId).map(item => item.name)
    return [object.label, ...names].join(' ').toLocaleLowerCase('uz').includes(search.trim().toLocaleLowerCase('uz'))
  }), [modelObjects, data.apparatusRows, search])
  const loadMoreObjects = useCallback(async () => setListLimit(limit => limit + 20), [])
  const loadMoreQueue = useCallback(async () => setQueueLimit(limit => limit + 20), [])
  const selectObject = useCallback((object: FactoryMapObject) => {
    setSelected({ ...object, objectId: canonicalFactoryMapObjectId(object.objectId) })
    setExpanded(false)
  }, [])
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

      {(data.liveError || data.apparatusError) && <Alert><WifiOff /><AlertTitle>Ish holati yangilanmadi</AlertTitle><AlertDescription>{message(data.apparatusError || data.liveError)} Apparatlar holati noma’lum deb ko‘rsatiladi.</AlertDescription></Alert>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card ref={mapRef} className={`gap-0 overflow-hidden py-0 ${expanded ? 'fixed inset-0 z-50 h-svh rounded-none bg-background' : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              {data.fresh ? <Wifi className="size-4 text-emerald-600" /> : <WifiOff className="size-4 text-muted-foreground" />}
              <span className="font-medium">{data.loading ? 'Uskunalar yuklanmoqda…' : data.fresh ? demo ? 'Namunaviy holat' : 'Holat yangilangan' : 'Holat noma’lum'}</span>
              <Badge variant="secondary">{machines.length} ta biriktirilgan</Badge>
            </div>
            <div className="flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" aria-label="Umumiy ko‘rinish" title="Umumiy ko‘rinish" onClick={() => { setSelected(null); setResetRevision(value => value + 1) }}><Focus /></Button>
              <Button size="icon-sm" variant={showLabels ? 'secondary' : 'ghost'} aria-label="Apparat yozuvlarini ko‘rsatish" title="Apparat yozuvlari" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}><Tags /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={expanded ? 'To‘liq ekrandan chiqish' : 'To‘liq ekran'} title={expanded ? 'To‘liq ekrandan chiqish' : 'To‘liq ekran'} onClick={() => setExpanded(value => !value)}>{expanded ? <Shrink /> : <Expand />}</Button>
            </div>
          </div>
          <FactoryMapViewer className="h-[min(70vh,760px)] min-h-[480px] flex-1 sm:min-h-[560px]" liveState={live} stockState={stock} selectedObjectId={selected?.objectId ?? ''} focusedObjectId={selected?.objectId ?? ''} resetRevision={resetRevision} showLabels={showLabels} renderSuspended={Boolean(confirm)} onObjectTap={selectObject} onObjectsReady={setModelObjects} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <span>Aylantirish: sichqoncha · Yaqinlashtirish: scroll · Siljitish: o‘ng tugma</span>
            <span>{demo ? 'Lokal namuna' : 'Har 15 soniyada yangilanadi'}</span>
          </div>
        </Card>

        <Card className="min-w-0 self-start xl:h-[calc(min(70vh,760px)+101px)] xl:min-h-[661px]">
          <CardHeader>
            {selected ? <>
              <div className="flex items-start justify-between gap-2"><CardTitle>{apparatus?.name || selected.label || 'Biriktirilmagan apparat'}</CardTitle><Button size="icon-xs" variant="ghost" aria-label="Apparat tafsilotlarini yopish" onClick={() => setSelected(null)}><X /></Button></div>
              <CardDescription>{apparatus ? 'Apparatning ERPdagi joriy holati.' : 'Modeldagi ushbu apparatni ERP uskunasiga biriktiring.'}</CardDescription>
            </> : <><CardTitle>Apparatlar</CardTitle><CardDescription>Xaritadan yoki ro‘yxatdan apparatni tanlang.</CardDescription></>}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {!selected ? <>
              <div className="relative"><Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input aria-label="Xaritadagi apparatni qidirish" placeholder="Apparatni qidirish…" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
              <div ref={listRef} className="min-h-0 max-h-96 flex-1 space-y-1 overflow-y-auto xl:max-h-none">
                {visibleObjects.slice(0, listLimit).map(object => {
                  const objectOwners = factoryMapObjectOwners(data.apparatusRows, object.objectId)
                  const machine = machines.find(row => row.objectId === canonicalFactoryMapObjectId(object.objectId))
                  return <button key={object.objectId} className="flex w-full items-start gap-3 rounded-md px-2 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => selectObject(object)}>
                    <Factory className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{objectOwners.length === 1 ? objectOwners[0]!.name : object.label}</span><span className="mt-1 block text-xs text-muted-foreground">{objectOwners.length > 1 ? 'Biriktirish ziddiyati' : machine ? text(machine.statusLabel) : 'Biriktirilmagan'}</span></span>
                    {machine && <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: text(machine.statusColor, '#8b8984') }} />}
                  </button>
                })}
                {!visibleObjects.length && <p className="py-8 text-center text-sm text-muted-foreground">{modelObjects.length ? 'Apparat topilmadi.' : 'Model yuklangach apparatlar ko‘rinadi.'}</p>}
                <InfiniteListEnd root={listRef} hasMore={visibleObjects.length > listLimit} isFetching={false} loadMore={loadMoreObjects} />
              </div>
              <Separator />
              <div className="flex gap-2 text-xs leading-relaxed text-muted-foreground"><CircleHelp className="mt-0.5 size-4 shrink-0" /><span>Ranglar ERPdagi ish holatini bildiradi. Apparat tanlanganda buyurtmaning rejalashtirilgan yo‘li ko‘rinadi.</span></div>
            </> : owners.length > 1 ? <Alert variant="destructive"><AlertTitle>Biriktirish ziddiyati</AlertTitle><AlertDescription>Bu obyektga bir nechta ERP apparati biriktirilgan. Uskunalar biriktirishini tekshiring.</AlertDescription></Alert> : apparatus ? <>
              <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary"><span className="size-2 rounded-full" style={{ backgroundColor: text(current?.statusColor, '#8b8984') }} />{text(current?.statusLabel, 'Holat noma’lum')}</Badge><Badge variant="outline">{apparatus.active ? 'Faol' : 'Nofaol'}</Badge></div>
              <div className="space-y-1 text-sm"><p className="text-xs text-muted-foreground">Operatsiya</p><p>{display(valueAt(apparatus.row, 'runtime_projection.execution_profile.operation') || valueAt(apparatus.row, 'execution_profile.operation'))}</p></div>
              {orderId && <div className="space-y-2 rounded-lg border p-3"><p className="text-xs text-muted-foreground">{data.fresh ? 'Joriy buyurtma' : 'Oxirgi yuklangan buyurtma'}</p><Link className="flex items-center justify-between gap-2 font-medium hover:underline" to={`/app/orders?selected=${encodeURIComponent(orderId)}`}>{text(order?.order_number || order?.code || orderId)}<ArrowUpRight className="size-4" /></Link>{order?.title ? <p className="text-sm">{text(order.title)}</p> : null}<p className="text-xs text-muted-foreground">{text(data.snapshot?.order_customers[orderId] || order?.customer_name)}</p>{order?.order_kg !== undefined && <p className="text-xs text-muted-foreground">Reja: {formatNumber(order.order_kg)} kg</p>}</div>}
              <Separator />
              <p className="text-sm font-medium">Buyurtmalar navbati <span className="text-muted-foreground">({queueIds.length})</span></p>
              <div ref={queueRef} className="min-h-0 max-h-72 flex-1 space-y-1 overflow-y-auto xl:max-h-none">
                {queueIds.slice(0, queueLimit).map(id => {
                  const saved = data.snapshot!.maps.find(item => item.map.id === id)!.map
                  const state = data.fresh ? factoryMapOrderStatus(data.snapshot!, apparatus.id, id) : 'unknown'
                  return <Link key={id} to={`/app/orders?selected=${encodeURIComponent(id)}`} className="block rounded-md px-2 py-2 hover:bg-accent"><span className="block text-sm font-medium">{text(saved.order_number || saved.code || id)}</span><span className="mt-1 block text-xs text-muted-foreground">{factoryMapStatuses[state].label}</span></Link>
                })}
                {!queueIds.length && <p className="py-4 text-sm text-muted-foreground">{data.fresh ? 'Hozircha navbatda buyurtma yo‘q.' : 'Navbat holati noma’lum.'}</p>}
                <InfiniteListEnd root={queueRef} hasMore={queueIds.length > queueLimit} isFetching={false} loadMore={loadMoreQueue} />
              </div>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={`/app/apparatus?selected=${encodeURIComponent(apparatus.id)}`}>ERP uskunasi<ArrowUpRight /></Link></Button>{canBind && <Button size="sm" variant="ghost" disabled={data.saving} onClick={() => confirmPlacement(apparatus.row, '')}><Unlink />Ajratish</Button>}</div>
            </> : <>
              <Badge variant="outline" className="self-start">Biriktirilmagan</Badge>
              <p className="text-sm leading-relaxed text-muted-foreground">ERP apparati biriktirilgach uning holati va buyurtmalar navbati shu joyda ko‘rinadi.</p>
              {canBind && <>
                <Select value={bindingId} onValueChange={setBindingId} disabled={data.saving || data.loading || Boolean(data.apparatusError)}><SelectTrigger aria-label="Biriktiriladigan ERP apparati" className="w-full"><SelectValue placeholder="ERP apparatini tanlang" /></SelectTrigger><SelectContent>{available.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
                {!available.length && !data.loading && <p className="text-xs text-muted-foreground">Biriktirilmagan faol ERP apparati yo‘q.</p>}
                <Button disabled={!chosen || data.saving || Boolean(data.apparatusError)} onClick={() => chosen && confirmPlacement(chosen.row, selected.objectId)}><Link2 />Apparatni biriktirish</Button>
              </>}
              <Button variant="outline" onClick={() => setSelected(null)}><ArrowLeft />Apparatlar ro‘yxati</Button>
            </>}
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
