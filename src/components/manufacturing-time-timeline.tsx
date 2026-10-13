import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, Clock3, ListFilter, RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from 'cn'
import {
  manufacturingDurationLabel, manufacturingEventPosition, manufacturingNextEventIndex, manufacturingStateLabels,
  manufacturingTimeLabel, manufacturingTimeZone, manufacturingZoomWindow,
} from '@/lib/manufacturing-time'
import type { ManufacturingEvent, ManufacturingStage, ManufacturingTimeline, ManufacturingWindow } from '@/lib/manufacturing-time'
import { DashboardMetric, DashboardNote, DashboardSurface } from '@/components/dashboard-surface'
import { Timeline, TimelineConnector, TimelineContent as TimelineEventContent, TimelineItem, TimelineMarker, TimelineRail, TimelineTime } from '@/components/dashboardcn/timeline'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const sourceLabels: Record<ManufacturingTimeline['source'], string> = {
  closed_order: 'Saqlangan buyurtma tarixi', batch_lineage: 'Partiya zanjiri', snapshot_only: 'Joriy holat', unavailable: 'Tarix olinmagan',
}
const spanClasses: Record<string, string> = {
  in_progress: 'bg-foreground/75', paused: 'border border-foreground/50 bg-foreground/25', pending: 'bg-foreground/15',
  print_preflight: 'border border-foreground/35 bg-foreground/15', frozen: 'border border-foreground/60 bg-foreground/20', completed: 'bg-foreground/50',
}
const gapLabels = { inconsistent: 'Mos holat almashishi olinmagan', same_second: 'Bir soniyadagi hodisalar tartibi noaniq', unattributed: 'Bosqichga ulanmagan hodisa bor', conflict: 'Yozuv identifikatorlari mos emas' }
const timeTabClasses = 'rounded-full px-4 text-xs data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=inactive]:bg-transparent data-[state=inactive]:text-muted-foreground dark:data-[state=active]:border-border dark:data-[state=active]:bg-muted dark:data-[state=active]:text-foreground'

export interface ManufacturingTimeTimelineProps {
  timeline: ManufacturingTimeline
  timeZone?: string
  className?: string
}

/** Order-keyed local selection keeps unrelated order events out of an open detail. */
export function ManufacturingTimeTimeline(props: ManufacturingTimeTimelineProps) {
  return <TimelineContent key={props.timeline.orderId} {...props} />
}

function TimelineContent({ timeline, timeZone = manufacturingTimeZone(), className }: ManufacturingTimeTimelineProps) {
  const id = useId()
  const [selectedId, setSelectedId] = useState(timeline.events[0]?.id ?? '')
  const [viewport, setViewport] = useState<ManufacturingWindow | null>(null)
  const [query, setQuery] = useState('')
  const [stageFilter, setStageFilter] = useState('all')
  const [tab, setTab] = useState('stages')
  const markerRefs = useRef(new Map<number, HTMLButtonElement>())
  const filteredEvents = useMemo(() => timeline.events.filter(event => (stageFilter === 'all' || (stageFilter === 'unattributed' ? event.stageKey === null : event.stageKey === stageFilter)) &&
    [event.label, event.actor, event.apparatus, event.nodeId, event.note, event.batchId, event.sessionId].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [timeline.events, stageFilter, query])
  const selected = timeline.events.find(event => event.id === selectedId) ?? timeline.events[0] ?? null
  const extent = timeline.window
  const window = extent && viewport ? manufacturingZoomWindow(viewport, extent, 1) : extent
  const groups = useMemo(() => {
    const timestamps = new Map<number, ManufacturingEvent[]>()
    for (const event of filteredEvents) if (!window || event.atUnix >= window.startUnix && event.atUnix <= window.endUnix) timestamps.set(event.atUnix, [...(timestamps.get(event.atUnix) ?? []), event])
    return [...timestamps]
  }, [filteredEvents, window?.startUnix, window?.endUnix])
  const selectedIndex = filteredEvents.findIndex(event => event.id === selected?.id)
  const filteredStages = timeline.stages.filter(stage => stageFilter === 'all' || stage.key === stageFilter)
  useEffect(() => {
    if (selectedId && !timeline.events.some(event => event.id === selectedId)) setSelectedId(timeline.events[0]?.id ?? '')
  }, [timeline.events, selectedId])

  function select(event: ManufacturingEvent, focus = false) {
    setSelectedId(event.id)
    if (window && extent && (event.atUnix < window.startUnix || event.atUnix > window.endUnix)) setViewport(manufacturingZoomWindow(window, extent, 1, event.atUnix))
    if (focus) requestAnimationFrame(() => markerRefs.current.get(event.atUnix)?.focus())
  }
  function move(direction: number) {
    const next = filteredEvents[manufacturingNextEventIndex(selectedIndex, filteredEvents.length, direction)]
    if (next) select(next)
  }
  function rulerKey(event: KeyboardEvent) {
    if (!filteredEvents.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? filteredEvents.length - 1 : manufacturingNextEventIndex(selectedIndex, filteredEvents.length, event.key === 'ArrowRight' ? 1 : -1)
    select(filteredEvents[index], true)
  }
  const canZoom = Boolean(window && extent && extent.endUnix > extent.startUnix)
  const zoomed = Boolean(window && extent && (window.startUnix !== extent.startUnix || window.endUnix !== extent.endUnix))
  const sourceExplanation = timeline.source === 'closed_order'
    ? 'Qayd etilgan oraliqlar ikki mos holat almashishi bilan chegaralanadi. Birinchi yozuvdan oldingi va oxirgisidan keyingi vaqt baholanmagan.'
    : timeline.source === 'batch_lineage'
      ? 'Tanlangan partiyaning bog‘langan hodisalari ko‘rsatiladi. Buyurtmaning to‘liq holat tarixi olinmagani uchun davomiylik baholanmagan.'
      : 'Joriy holat va oxirgi saqlangan faollik ko‘rsatiladi. Davomiylik uchun tarixiy holat almashishlari talab qilinadi.'

  return <DashboardSurface aria-label="Bosqichlar va vaqt qaydlari" className={className}>
    <div className="px-5 pb-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1"><h2 className="text-base font-medium tracking-tight">Bosqichlar va vaqt qaydlari</h2><p className="break-words text-xs text-muted-foreground">{timeline.orderNumber ? `#${timeline.orderNumber} · ` : ''}{timeline.title}</p></div>
        <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline" className="text-[10px]">{sourceLabels[timeline.source]}</Badge>{timeline.earlyClosed && <Badge variant="outline" className="text-[10px]">Erta yopilgan</Badge>}{timeline.hasIssue && <Badge variant="outline" className="text-[10px]">Muammoli qayd</Badge>}{timeline.coverage.lineageComplete !== null && <Badge variant="outline" className="text-[10px]">{timeline.coverage.lineageComplete ? 'Partiya zanjiri to‘liq' : 'Partiya zanjiri qisman'}</Badge>}{!timeline.fresh && <Badge variant="secondary" className="text-[10px]">Oxirgi olingan ma’lumot</Badge>}</div>
      </div>
      <DashboardNote className="mt-3">Olingan vaqt: <span className="font-mono tabular-nums">{manufacturingTimeLabel(timeline.asOfUnix, timeZone)}</span> · {timeZone} vaqti</DashboardNote>
    </div>
    <div className="grid border-y border-border/65 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <DashboardMetric label="Qaydlar oynasi" value={manufacturingDurationLabel(timeline.observedWindowSeconds)} valueClassName="text-[2.1rem] sm:text-[2.5rem]" detail="Birinchi va oxirgi olingan hodisa orasida" />
      <DashboardMetric className="border-t border-border/65 sm:border-l sm:border-t-0" label="O‘lchangan bosqichlar" value={`${timeline.coverage.measuredStageCount} / ${timeline.stages.length}`} valueClassName="text-[1.75rem]" detail="Mos holat qaydlaridan hisoblangan" />
      <DashboardMetric className="border-t border-border/65 sm:border-l sm:border-t-0" label="Baholanmagan oraliqlar" value={timeline.source === 'closed_order' && timeline.stages.some(stage => stage.intervals.length || stage.gaps.length) ? String(timeline.coverage.gapCount) : '—'} valueClassName="text-[1.75rem]" detail={`${timeline.coverage.unattributedEvents} bosqichga ulanmagan hodisa`} />
    </div>
    <div className="space-y-4 p-5 sm:p-6">
      <div className="flex items-start gap-2.5"><Clock3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><DashboardNote>{sourceExplanation}</DashboardNote></div>
      {timeline.orderControlState && timeline.orderControlState !== 'active' && <Alert><AlertDescription><p className="font-medium">{!timeline.fresh ? 'Oxirgi kuzatuvda: ' : ''}{timeline.orderControlState === 'frozen' ? 'Buyurtma muzlatilgan.' : timeline.orderControlState === 'freeze_requested' ? 'Buyurtmani muzlatish so‘rovi kutilmoqda.' : 'Buyurtmaning boshqaruv holati noma’lum.'}</p><p>Bosqichlar jadvalidagi holatlar saqlangan bosqich qaydlaridir. Buyurtmaning umumiy cheklovi alohida amal qiladi.</p></AlertDescription></Alert>}
      {timeline.source === 'closed_order' && timeline.coverage.lineageComplete !== null && <p className="text-xs leading-5 text-muted-foreground">Partiya sessiyalari va vaqt belgilarining qamrovi tanlangan zanjirga tegishli. Holat davomiyligi buyurtmaning saqlangan yozuvlaridan hisoblangan.</p>}
      {timeline.coverage.issues.length > 0 && <Collapsible>
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="gap-2 px-0">Qamrov tafsilotlari <ChevronDown className="size-4" /></Button></CollapsibleTrigger>
        <CollapsibleContent><ul className="space-y-2 pb-2 pt-3 text-sm text-muted-foreground">{timeline.coverage.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
          <p className="text-xs text-muted-foreground">Olingan holat yozuvlari: {timeline.coverage.logsReceived} · chiqarilgan: {timeline.coverage.discardedRecords} · takrorlar: {timeline.coverage.duplicateRecords} · mos kelmagan takrorlar: {timeline.coverage.conflictingRecords}</p>
        </CollapsibleContent>
      </Collapsible>}
      <div className="grid gap-3 border-t border-border/65 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)]">
        <div className="space-y-1.5"><Label htmlFor={`${id}-search`}>Hodisalarni qidirish</Label><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input id={`${id}-search`} className="pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="Hodisa, uskuna yoki xodim" /></div></div>
        <div className="space-y-1.5"><Label htmlFor={`${id}-stage`}>Bosqich</Label><Select value={stageFilter} onValueChange={setStageFilter}><SelectTrigger id={`${id}-stage`} className="w-full"><ListFilter className="size-4" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Barcha hodisalar</SelectItem>{timeline.stages.map(stage => <SelectItem key={stage.key} value={stage.key}>{stage.title} · {stage.nodeId}</SelectItem>)}<SelectItem value="unattributed">Buyurtma va bosqichsiz hodisalar</SelectItem></SelectContent></Select></div>
      </div>

      {window && <section aria-label="Hodisalar vaqt chizig‘i" className="overflow-hidden rounded-2xl border border-border/65 bg-muted/15">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3"><p className="text-xs font-medium">Hodisalar vaqt chizig‘i <span className="ml-1 font-normal text-muted-foreground">{filteredEvents.length} ta</span></p><div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Vaqt chizig‘ini yaqinlashtirish" disabled={!canZoom || window.endUnix - window.startUnix <= Math.min(60, extent!.endUnix - extent!.startUnix)} onClick={() => setViewport(manufacturingZoomWindow(window, extent!, .5, selected?.atUnix))}><ZoomIn /></Button>
          <Button variant="outline" size="icon-sm" aria-label="Vaqt chizig‘ini uzoqlashtirish" disabled={!zoomed} onClick={() => setViewport(manufacturingZoomWindow(window, extent!, 2))}><ZoomOut /></Button>
          <Button variant="ghost" size="sm" disabled={!zoomed} onClick={() => setViewport(null)}><RotateCcw className="size-3.5" /> To‘liq oyna</Button>
        </div></div>
        <p id={`${id}-ruler-help`} className="px-4 text-[10px] leading-5 text-muted-foreground">Hodisani tanlang. Klaviaturada ← va → hodisalar orasida, Home va End birinchi va oxirgi hodisaga o‘tadi.</p>
        <div className="relative mx-6 h-40 outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} role="group" aria-label="Vaqt bo‘yicha hodisani tanlash" aria-describedby={`${id}-ruler-help`} onKeyDown={rulerKey}>
          {selected && selected.atUnix >= window.startUnix && selected.atUnix <= window.endUnix && <>
            <div className="pointer-events-none absolute bottom-[31px] top-[56px] border-l border-foreground/55" style={{ left: `${manufacturingEventPosition(selected.atUnix, window) * 100}%` }} aria-hidden="true" />
            <div className="pointer-events-none absolute top-3 z-10 w-[min(13rem,100%)] rounded-xl border border-border/80 bg-popover px-3 py-2.5 text-[11px] text-popover-foreground shadow-sm" style={{ left: `clamp(0px, calc(${manufacturingEventPosition(selected.atUnix, window) * 100}% - 6.5rem), max(0px, calc(100% - 13rem)))` }} aria-hidden="true"><p className="font-mono text-[10px] tabular-nums text-muted-foreground">{shortTime(selected.atUnix, timeZone)} · {stageTitle(timeline, selected)}</p><p className="mt-1 truncate font-medium">{selected.label}</p>{selected.actor && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{selected.actor}</p>}</div>
          </>}
          {Array.from({ length: 61 }, (_, index) => { const ratio = index / 60, major = index % 10 === 0; return <span key={index} className={cn('absolute bottom-8 w-px rounded-full bg-muted-foreground/35', major ? 'h-5 bg-muted-foreground/65' : index % 5 === 0 ? 'h-3.5' : 'h-2')} style={{ left: `${ratio * 100}%` }} aria-hidden="true" /> })}
          {[0, .25, .5, .75, 1].map(ratio => <span key={ratio} className={cn('absolute bottom-2 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground', ratio === 0 ? '' : ratio === 1 ? '-translate-x-full' : '-translate-x-1/2', (ratio === .25 || ratio === .75) && 'hidden sm:block')} style={{ left: `${ratio * 100}%` }} aria-hidden="true">{shortTime(Math.round(window.startUnix + ratio * (window.endUnix - window.startUnix)), timeZone)}</span>)}
          {groups.map(([timestamp, entries]) => <button key={timestamp} type="button" ref={element => { if (element) markerRefs.current.set(timestamp, element); else markerRefs.current.delete(timestamp) }}
            className="absolute bottom-6 flex size-11 -translate-x-1/2 items-center justify-center gap-0.5 rounded-md outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
            style={{ left: `${manufacturingEventPosition(timestamp, window) * 100}%` }} aria-pressed={entries.some(event => event.id === selected?.id)} aria-label={`${manufacturingTimeLabel(timestamp, timeZone)}: ${entries.length > 1 ? `${entries.length} hodisa, ` : ''}${entries[0].label}`}
            title={`${manufacturingTimeLabel(timestamp, timeZone)} · ${entries.map(event => event.label).join(' · ')}`} onClick={() => { const current = entries.findIndex(event => event.id === selected?.id); select(entries[(current + 1) % entries.length]) }}>
            <span className={cn('absolute bottom-3 h-5 w-0.5 rounded-full bg-muted-foreground/55', entries.some(event => event.id === selected?.id) && 'h-11 bg-foreground')} aria-hidden="true" /><span className={cn('relative -mt-5 size-2 rounded-full border border-muted-foreground/65 bg-card', entries.some(event => event.id === selected?.id) && '-mt-[3.5rem] size-2.5 border-foreground bg-foreground ring-4 ring-card')} />{entries.length > 1 && <span className="relative -mt-5 text-[10px] tabular-nums">{entries.length}</span>}
          </button>)}
        </div>
        <div className="flex flex-wrap justify-between gap-2 px-4 pb-3 font-mono text-[10px] tabular-nums text-muted-foreground"><span>{manufacturingTimeLabel(window.startUnix, timeZone)}</span><span>{manufacturingTimeLabel(window.endUnix, timeZone)}</span></div>

      {selected && <section aria-label="Tanlangan hodisa" aria-live="polite" className="border-t border-border/65 bg-card/70 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><p className="text-[10px] text-muted-foreground">Tanlangan hodisa</p><h3 className="text-sm font-medium">{selected.label}</h3><p className="font-mono text-[11px] tabular-nums">{manufacturingTimeLabel(selected.atUnix, timeZone)} · {timeZone}</p></div><div className="flex items-center gap-1"><Button variant="outline" size="icon-sm" aria-label="Oldingi hodisa" disabled={selectedIndex <= 0} onClick={() => move(-1)}><ArrowLeft /></Button><Button variant="outline" size="icon-sm" aria-label="Keyingi hodisa" disabled={!filteredEvents.length || selectedIndex >= filteredEvents.length - 1} onClick={() => move(1)}><ArrowRight /></Button></div></div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span>Bosqich: {stageTitle(timeline, selected)}</span>{selected.actor && <span>Ijrochi: {selected.actor}</span>}{selected.transition && selected.fromState && selected.toState && <span>{manufacturingStateLabels[selected.fromState]} → {manufacturingStateLabels[selected.toState]}</span>}</div>
        {(selected.batchId || selected.sessionId) && <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{selected.batchId && `Partiya: ${selected.batchId}`}{selected.batchId && selected.sessionId && ' · '}{selected.sessionId && `Sessiya: ${selected.sessionId}`}</p>}
        {selected.note && <p className={cn('mt-3 whitespace-pre-wrap text-sm', selected.issue ? 'text-destructive' : 'text-muted-foreground')}>{selected.note}</p>}
      </section>}
      </section>}

      <Tabs value={tab} onValueChange={setTab} className="flex-col">
        <TabsList aria-label="Vaqt qaydlari ko‘rinishi" className="h-8 rounded-full bg-muted/60 p-1"><TabsTrigger value="stages" className={timeTabClasses}>Bosqichlar</TabsTrigger><TabsTrigger value="events" className={timeTabClasses}>Hodisalar ({filteredEvents.length})</TabsTrigger></TabsList>
        <TabsContent value="stages" className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-full bg-foreground/75" />Qayd etilgan jarayon</span><span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-full border border-foreground/50 bg-foreground/25" />Qayd etilgan to‘xtash</span><span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-full border border-dashed border-muted-foreground/60" />Baholanmagan oraliq</span></div>
          {filteredStages.length ? <div className="overflow-x-auto outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} aria-label="Bosqichlar vaqt jadvali, kichik ekranda gorizontal aylantiriladi">
            <div className="min-w-[650px]"><div className="grid grid-cols-[11rem_minmax(0,1fr)_6.5rem] gap-4 border-b border-border/65 py-3 text-[10px] text-muted-foreground"><span>Bosqich / joriy holat</span><span>Bir xil vaqt o‘qi · {timeZone}</span><span className="text-right">Qayd oralig‘i</span></div>
              {filteredStages.map(stage => <StageRow key={stage.key} stage={stage} window={window} timeZone={timeZone} fresh={timeline.fresh} onInspect={() => { setStageFilter(stage.key); setTab('events'); const first = timeline.events.find(event => event.stageKey === stage.key); if (first) select(first) }} />)}
            </div>
          </div> : <EmptyHistory message="Uskuna va aniq bosqichga tegishli vaqt qaydlari olinmagan." />}
          <p className="text-xs leading-5 text-muted-foreground">Har bir ustun qayd etilgan holat vaqtini ko‘rsatadi. Mahsuldor ish vaqti, OEE va WIP kutish davomiyligi uchun qo‘shimcha tarix talab qilinadi.</p>
        </TabsContent>
        <TabsContent value="events" className="pt-2">
          {filteredEvents.length ? <ManufacturingEventRail timeline={timeline} events={filteredEvents} selectedId={selected?.id ?? ''} timeZone={timeZone} onSelect={event => select(event)} /> : <EmptyHistory message={timeline.events.length ? 'Qidiruv va bosqich filtri bo‘yicha hodisa topilmadi.' : 'Vaqti qayd etilgan tarixiy hodisa olinmagan.'} />}
        </TabsContent>
      </Tabs>
    </div>
  </DashboardSurface>
}

/** A rail mark is evidence between adjacent visible events, never an elapsed-time estimate from a marker. */
function railInterval(timeline: ManufacturingTimeline, event: ManufacturingEvent, next: ManufacturingEvent | undefined) {
  if (!next || !event.stageKey || event.stageKey !== next.stageKey || !event.transition || !next.transition || event.kind !== 'queue' || next.kind !== 'queue' || timeline.asOfUnix === null || next.atUnix > timeline.asOfUnix) return null
  const stage = timeline.stages.find(stage => stage.key === event.stageKey)
  const interval = stage?.intervals.find(interval => interval.startEventId === event.id && interval.endEventId === next.id && interval.startUnix === event.atUnix && interval.endUnix === next.atUnix && interval.endUnix > interval.startUnix)
  if (!stage || !interval || interval.state !== event.toState || interval.state !== next.fromState || stage.gaps.some(gap => gap.startUnix < interval.endUnix && gap.endUnix > interval.startUnix)) return null
  return interval
}

export function ManufacturingEventRail({ timeline, events, selectedId, timeZone, onSelect }: { timeline: ManufacturingTimeline; events: readonly ManufacturingEvent[]; selectedId: string; timeZone: string; onSelect: (event: ManufacturingEvent) => void }) {
  return <div>
    <div className="flex items-center justify-between gap-3 border-b border-border/65 pb-2 text-[10px] text-muted-foreground"><span>Vaqt · {timeZone}</span><span>Qayd oralig‘i</span></div>
    <Timeline aria-label={`Hodisalar ketma-ketligi · ${timeZone}`} className="pb-2">{events.map((event, index) => {
      const interval = railInterval(timeline, event, events[index + 1])
      return <TimelineItem key={event.id}>
        {(index === 0 || stageTitle(timeline, event) !== stageTitle(timeline, events[index - 1])) && <p className="ml-[6.9rem] pb-1 pt-4 text-[11px] font-medium text-muted-foreground">{stageTitle(timeline, event)}</p>}
        <div className="relative grid grid-cols-[4.7rem_1rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 py-3 sm:grid-cols-[4.7rem_1rem_minmax(0,1fr)_7.5rem]">
          <TimelineTime dateTime={isoTime(event.atUnix)} title={manufacturingTimeLabel(event.atUnix, timeZone)}>{shortTime(event.atUnix, timeZone)}<span className="sr-only"> · {manufacturingTimeLabel(event.atUnix, timeZone)}</span></TimelineTime>
          <TimelineRail aria-hidden="true"><TimelineConnector />{interval && <span data-rail-interval-state={interval.state} data-rail-start={interval.startEventId} data-rail-end={interval.endEventId} className={cn('absolute top-[.4rem] z-10 h-[calc(100%+1.5rem)] w-[7px] rounded-full', spanClasses[interval.state])} />}<TimelineMarker className={event.id === selectedId ? 'size-2 bg-foreground ring-4 ring-card' : undefined} /></TimelineRail>
          <TimelineEventContent><Button variant="ghost" size="sm" className="h-auto max-w-full justify-start whitespace-normal px-0 text-left text-xs font-medium" aria-pressed={event.id === selectedId} onClick={() => onSelect(event)}>{event.label}</Button>{event.transition && event.fromState && event.toState && <p className="mt-1 text-[11px] text-muted-foreground">{manufacturingStateLabels[event.fromState]} → {manufacturingStateLabels[event.toState]}</p>}{event.actor && <p className="mt-1 text-[11px] text-muted-foreground">{event.actor}</p>}</TimelineEventContent>
          <p className="col-start-3 min-w-0 break-words font-mono text-[11px] tabular-nums text-muted-foreground sm:col-start-4 sm:pt-0.5 sm:text-right" title={interval ? `${manufacturingStateLabels[interval.state]} · ${manufacturingTimeLabel(interval.startUnix, timeZone)} — ${manufacturingTimeLabel(interval.endUnix, timeZone)}` : undefined}>{interval ? <><span className="sr-only">Qayd oralig‘i: {manufacturingStateLabels[interval.state]} · </span>{manufacturingDurationLabel(interval.endUnix - interval.startUnix)}</> : <><span className="sr-only">Qayd oralig‘i baholanmagan</span>—</>}</p>
        </div>
      </TimelineItem>
    })}</Timeline>
  </div>
}

function isoTime(unix: number) {
  const date = new Date(unix * 1000)
  return Number.isFinite(unix) && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function shortTime(unix: number, timeZone: string) {
  try { return new Intl.DateTimeFormat('uz-UZ', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(unix * 1000)) } catch { return '—' }
}
function stageTitle(timeline: ManufacturingTimeline, event: ManufacturingEvent) {
  return timeline.stages.find(stage => stage.key === event.stageKey)?.title || event.nodeTitle || (event.kind === 'closed' || event.kind === 'freeze' ? 'Buyurtma darajasida' : event.nodeId || 'Bosqichga ulanmagan')
}
function EmptyHistory({ message }: { message: string }) {
  return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{message}</div>
}
function StageRow({ stage, window, timeZone, fresh, onInspect }: { stage: ManufacturingStage; window: ManufacturingWindow | null; timeZone: string; fresh: boolean; onInspect: () => void }) {
  const width = window ? window.endUnix - window.startUnix : 0
  const ranges = (window ? stage.intervals.filter(interval => interval.endUnix > window.startUnix && interval.startUnix < window.endUnix) : [])
  const gaps = (window ? stage.gaps.filter(gap => gap.endUnix > window.startUnix && gap.startUnix < window.endUnix) : [])
  const position = (start: number, end: number) => ({ left: `${manufacturingEventPosition(start, window!) * 100}%`, width: `${Math.max(0, (Math.min(end, window!.endUnix) - Math.max(start, window!.startUnix)) / width * 100)}%` })
  return <div className="grid grid-cols-[11rem_minmax(0,1fr)_6.5rem] items-center gap-4 border-b border-border/60 py-4 last:border-b-0">
    <div className="min-w-0"><Button variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal px-0 text-left" onClick={onInspect}>{stage.title}</Button><p className="mt-1 truncate text-[11px] text-muted-foreground" title={stage.nodeId}>{stage.nodeId}</p><p className="mt-1 text-xs text-muted-foreground">{stage.currentState ? `${fresh ? 'Joriy' : 'Oxirgi kuzatuv'}: ${manufacturingStateLabels[stage.currentState]}` : stage.lastRecordedState ? `Oxirgi qayd: ${manufacturingStateLabels[stage.lastRecordedState]}` : 'Holat olinmagan'}</p></div>
    <div className="space-y-2"><div className="relative h-12 overflow-hidden rounded-xl bg-muted/35" role="img" aria-label={`${stage.title}: qayd etilgan jarayon ${manufacturingDurationLabel(stage.inProgressSeconds)}, to‘xtash ${manufacturingDurationLabel(stage.pausedSeconds)}, ${stage.gaps.length} baholanmagan oraliq`}>
      {width > 0 && ranges.map(interval => <span key={`${interval.startEventId}:${interval.endEventId}`} data-interval-state={interval.state} className={cn('absolute inset-y-1.5 rounded-lg border-x-2 border-x-card', spanClasses[interval.state])} style={position(interval.startUnix, interval.endUnix)} title={`${manufacturingStateLabels[interval.state]}: ${manufacturingDurationLabel(interval.endUnix - interval.startUnix)} · ${manufacturingTimeLabel(interval.startUnix, timeZone)} — ${manufacturingTimeLabel(interval.endUnix, timeZone)}`} />)}
      {width > 0 && gaps.map(gap => <span key={`${gap.startUnix}:${gap.endUnix}`} className="absolute inset-y-1.5 rounded-lg border border-dashed border-muted-foreground/60" style={position(gap.startUnix, gap.endUnix)} title={gapLabels[gap.reason]} />)}
      {!ranges.length && !gaps.length && <span className="absolute inset-0 flex items-center px-2 text-[11px] text-muted-foreground">{stage.recordedSeconds === null ? 'Davomiylik baholanmagan' : 'Bu oynada vaqt qaydi yo‘q'}</span>}
    </div><p className="text-[11px] text-muted-foreground">Jarayon: <span className="font-mono tabular-nums">{manufacturingDurationLabel(stage.inProgressSeconds)}</span>{stage.pausedSeconds !== null && <> · To‘xtash: <span className="font-mono tabular-nums">{manufacturingDurationLabel(stage.pausedSeconds)}</span></>}</p></div>
    <p className="text-right font-mono text-sm font-medium tabular-nums">{manufacturingDurationLabel(stage.recordedSeconds)}</p>
  </div>
}
