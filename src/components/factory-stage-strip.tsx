import { useEffect, useId, useRef } from 'react'
import { ArrowLeft, ArrowRight, Factory, Layers3, Package, Printer, Scissors, Waypoints } from 'lucide-react'
import type { FactoryRouteStage, FactoryStageRoute } from '@/lib/factory-stage-navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface FactoryStageStripProps {
  route: FactoryStageRoute
  orderChoices: { id: string; label: string }[]
  viewedKey: string
  selectionIssue?: string
  onOrderChange: (orderId: string) => void
  onStageChange: (stage: FactoryRouteStage | null) => void
}
function StageIcon({ stage }: { stage: FactoryRouteStage }) {
  const Icon = stage.operation === 'print' ? Printer : stage.operation === 'laminate' ? Layers3 : stage.operation === 'cut' ? Scissors : stage.operation === 'package' ? Package : Waypoints
  return <Icon className="size-4" aria-hidden="true" />
}

/** Selected/viewed is a browsing state; the ERP execution marker is independent. */
export function FactoryStageStrip({ route, orderChoices, viewedKey, selectionIssue, onOrderChange, onStageChange }: FactoryStageStripProps) {
  const id = useId(), track = useRef<HTMLDivElement>(null)
  const viewed = route.stages.find(stage => stage.key === viewedKey), index = viewed ? route.stages.indexOf(viewed) + 1 : 0
  const active = route.stages.filter(stage => stage.activeExecution)
  const steps: (FactoryRouteStage | null)[] = [null, ...route.stages]
  useEffect(() => {
    const button = track.current?.querySelector<HTMLElement>('[aria-current="step"]')
    const row = track.current
    if (button && row) row.scrollTo({ left: Math.max(0, row.scrollLeft + button.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - button.clientWidth) / 2), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [viewedKey, route.orderId])
  function navigate(position: number, focus = false) {
    const next = Math.max(0, Math.min(steps.length - 1, position))
    onStageChange(steps[next])
    if (focus) track.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true })
  }
  return <section className="space-y-4 border-t bg-card px-4 py-4" aria-label="Buyurtma bosqichlari" data-factory-stage-strip>
    <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,280px)]"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold tabular-nums">{viewed ? `${String(index).padStart(2, '0')} / ${String(route.stages.length).padStart(2, '0')}` : 'Umumiy ko‘rinish'}</p>{viewed && <span className="text-sm font-medium">{viewed.title}</span>}{viewed?.branch && <Badge variant="outline">Rejalashtirilgan tarmoq</Badge>}</div><p className="text-xs leading-relaxed text-muted-foreground">{viewed ? `${viewed.apparatusName || 'Apparat tanlovi tasdiqlanmagan'} · ${viewed.statusLabel}` : route.orderId ? 'Zavodning to‘liq modeli. Bosqichni tanlab uning haqiqiy apparatini alohida ko‘ring.' : 'Buyurtmani tanlab uning haqiqiy bosqichlarini ko‘ring.'}</p></div><div className="space-y-1.5"><Label className="text-xs text-muted-foreground" htmlFor={`${id}-order`}>Buyurtma yo‘li</Label><Select value={route.orderId || '__none__'} disabled={!orderChoices.length} onValueChange={value => onOrderChange(value === '__none__' ? '' : value)}><SelectTrigger id={`${id}-order`} className="w-full"><SelectValue placeholder="Buyurtmani tanlang" /></SelectTrigger><SelectContent><SelectItem value="__none__">Buyurtmani tanlang</SelectItem>{orderChoices.map(order => <SelectItem key={order.id} value={order.id}>{order.label}</SelectItem>)}</SelectContent></Select></div></div>
    {route.stages.length > 0 && <div className="flex items-center gap-2"><Button type="button" size="icon" variant="outline" className="shrink-0 rounded-full" aria-label="Oldingi bosqich" disabled={index === 0} onClick={() => navigate(index - 1)}><ArrowLeft /></Button><div ref={track} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain pb-1" aria-label="Bosqichlar bo‘yicha o‘tish"><ol className="flex min-w-max items-start">{steps.map((stage, position) => {
      const selected = stage ? stage.key === viewedKey : !viewed
      return <li key={stage?.key ?? 'overview'} className="relative w-24 shrink-0 sm:w-28">{position < steps.length - 1 && <span className="pointer-events-none absolute top-5 left-1/2 h-px w-full bg-border" aria-hidden="true" />}<button type="button" className="relative flex min-h-20 w-full flex-col items-center gap-2 rounded-lg px-1 py-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={stage ? `${position}. ${stage.title}: ${stage.apparatusName || 'Apparat tanlanmagan'}, ${stage.statusLabel}${stage.activeExecution ? ', hozir bajarilmoqda' : ''}` : 'Umumiy ko‘rinish: zavodning to‘liq modeli'} aria-current={selected ? 'step' : undefined} data-stage-key={stage?.key ?? 'overview'} onClick={() => navigate(position)} onKeyDown={event => {
        const target = event.key === 'ArrowRight' ? position + 1 : event.key === 'ArrowLeft' ? position - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : null
        if (target !== null) { event.preventDefault(); navigate(target, true) }
      }}><span className={`grid size-10 place-items-center rounded-full border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{stage ? <StageIcon stage={stage} /> : <Factory className="size-4" aria-hidden="true" />}</span><span className={`line-clamp-2 text-xs leading-4 ${selected ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{stage?.title ?? 'Umumiy'}</span>{stage?.activeExecution && <span className="text-[10px] font-medium text-foreground">Bajarilmoqda</span>}</button></li>
    })}</ol></div><Button type="button" size="icon" variant="outline" className="shrink-0 rounded-full" aria-label="Keyingi bosqich" disabled={index >= route.stages.length} onClick={() => navigate(index + 1)}><ArrowRight /></Button></div>}
    {(viewed?.issue || selectionIssue || route.issue) && <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground" role="status">{viewed?.issue || selectionIssue || route.issue}</p>}
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground"><p role="status" aria-live="polite">{viewed ? `Ko‘rilayotgan bosqich: ${viewed.title}. ` : ''}{!route.fresh ? 'Ish holati yangilanmagan: bajarilayotgan bosqich noma’lum.' : active.length === 1 ? `ERPda bajarilayotgan bosqich: ${active[0].title}.` : active.length > 1 ? `ERPda bajarilayotgan bosqichlar: ${active.map(stage => stage.title).join(', ')}.` : 'Hozir bajarilayotgan bosqich tasdiqlanmagan.'}</p><span>Harakat ERP holatining sxematik ko‘rinishi.</span></div>
    {viewed?.alternative && <p className="text-xs text-muted-foreground">Muqobil apparatlar: {viewed.candidateNames.join(' · ')}. {viewed.apparatusId ? `Tanlangan: ${viewed.apparatusName || viewed.apparatusId}.` : 'Biriktirish tasdiqlanmaguncha apparat taxmin qilinmaydi.'}</p>}
  </section>
}
