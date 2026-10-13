import { useMemo, useState } from 'react'
import type { Row } from '@/lib/api-types'
import { text } from '@/lib/api'
import { buildManufacturingTimeline, manufacturingTimeLabel, manufacturingTimeZone } from '@/lib/manufacturing-time'
import { ManufacturingEventRail } from '@/components/manufacturing-time-timeline'

/** The selected saved closed-order record; no extra requests or inferred history. */
export function ClosedOrderEventHistory({ row, observedAt, fresh }: { row: Row; observedAt: number; fresh: boolean }) {
  const timeline = useMemo(() => buildManufacturingTimeline({
    orderId: text(row.order_id, ''), closedOrder: row,
    asOfUnix: observedAt > 0 ? Math.floor(observedAt / 1000) : 0, fresh,
  }), [row, observedAt, fresh])
  const [selectedId, setSelectedId] = useState('')
  const selected = timeline.events.find(event => event.id === selectedId) ?? timeline.events[0]
  const zone = manufacturingTimeZone()
  return <section aria-label="Yopilgan buyurtmaning saqlangan hodisalari" className="space-y-3">
    <div><h3 className="text-sm font-medium">Buyurtma hodisalari</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{timeline.events.length} ta saqlangan qayd · vaqt zonasi: {zone}. Davomiylik faqat ikki mos holat qaydi orasida ko‘rsatiladi.</p></div>
    {!fresh && <p role="status" className="text-xs text-muted-foreground">Oxirgi olingan tarix. Saqlangan qaydlar joriy vaqtgacha uzaytirilmaydi.</p>}
    {timeline.events.length ? <>
      <div className="max-h-[32rem] overflow-y-auto pr-2"><ManufacturingEventRail timeline={timeline} events={timeline.events} selectedId={selected?.id ?? ''} timeZone={zone} onSelect={event => setSelectedId(event.id)} /></div>
      {selected && <p aria-live="polite" className="border-t pt-3 text-xs leading-5 text-muted-foreground">Tanlangan qayd: <span className="font-medium text-foreground">{selected.label}</span> · {manufacturingTimeLabel(selected.atUnix, zone)}{selected.actor ? ` · ${selected.actor}` : ''}</p>}
    </> : <p className="py-6 text-sm text-muted-foreground">Bu buyurtmaning hodisa qaydlari olinmagan.</p>}
  </section>
}
