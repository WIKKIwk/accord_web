import { ChevronDown } from 'lucide-react'
import { cn } from 'cn'
import type { WorkerGroup } from '@/lib/worker-groups'
import { workerGroupOverviewSummary } from '@/lib/worker-group-analytics'
import { KpiCard } from './dashboardcn/kpi-card'
import { MetricList } from './dashboardcn/metric-list'
import { MetricValue } from './dashboardcn/metric-value'

export interface WorkerGroupOverviewProps {
  /** Supply the full native group GET, before filtering the visible list. */
  groups: readonly WorkerGroup[]
  available?: boolean
  className?: string
}

/** Read-only group facts; the directory and its forms remain the main interaction. */
export function WorkerGroupOverview({ groups, available = true, className }: WorkerGroupOverviewProps) {
  const summary = workerGroupOverviewSummary(groups, available)
  const cards = [
    { key: 'groups', label: 'Guruhlar', value: summary.groupCount },
    { key: 'members', label: 'Guruhdagi ishchilar', value: summary.recordedMemberCount },
    { key: 'accounting', label: 'Hisoblash yoqilgan', value: summary.accountingEnabledCount },
    { key: 'empty', label: 'Ishchisiz guruhlar', value: summary.emptyGroupCount },
  ]
  const shownApparatus = summary.apparatus.slice(0, 6)
  const remaining = summary.apparatus.slice(shownApparatus.length)
  const coverage = summary.state === 'unavailable' ? 'Guruhlar ma’lumotlari olinmagan. — noma’lum.'
    : summary.state === 'invalid' ? 'Guruh qaydlari to‘liq emas. — noma’lum.'
      : `Barcha guruhlar bo‘yicha. Har bir biriktirilgan ishchi bir marta sanaladi.${summary.state === 'incomplete' ? ' Ayrim qaydlar noma’lum; — bilan ko‘rsatilgan.' : ''}`

  return <section data-slot="worker-group-overview" data-state={summary.state} aria-label="Ishchi guruhlari kuzatuvi" className={cn('min-w-0 space-y-2', className)}>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cards.map(card => <KpiCard key={card.key} data-metric={card.key} label={card.label} value={card.value ?? '—'} valueClassName="text-2xl font-medium" className="min-w-0 gap-1 py-3 [&_[data-slot=card-header]]:px-3 [&_[data-slot=card-description]]:text-[11px] [&_[data-slot=card-description]]:leading-4" />)}
    </div>
    <p className="text-[11px] leading-5 text-muted-foreground">{coverage}</p>
    {summary.apparatus.length > 1 && <details className="group/overview-breakdown min-w-0 rounded-lg border">
      <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">Apparatlar bo‘yicha guruhlar</span>
        <span className="shrink-0 text-muted-foreground"><MetricValue value={summary.apparatus.length} compactFrom={Infinity} /> apparat</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open/overview-breakdown:rotate-180" />
      </summary>
      <div className="space-y-2 border-t px-3 py-3">
        <p className="text-[11px] leading-5 text-muted-foreground">Har bir apparatdagi guruhlar soni · ko‘p guruhli apparatlar avval.</p>
        <MetricList aria-label="Apparatlar bo‘yicha guruhlar soni" items={shownApparatus.map(item => ({ key: item.id, label: item.label, value: item.groupCount }))} className="[&_[data-slot=metric-list-row]]:text-xs [&_[data-slot=metric-list-row]>div:last-child]:w-auto [&_[data-slot=metric-list-row]>div:last-child]:min-w-8" />
        {remaining.length > 0 && <p className="text-[11px] leading-5 text-muted-foreground">Eng ko‘p guruhli 6 apparat ko‘rsatilgan. Qolgan <MetricValue value={remaining.length} compactFrom={Infinity} /> apparatda jami <MetricValue value={remaining.reduce((total, item) => total + item.groupCount, 0)} compactFrom={Infinity} /> guruh bor.</p>}
      </div>
    </details>}
  </section>
}
