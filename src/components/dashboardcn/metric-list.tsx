// Adapted from dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// See LICENSE and PROVENANCE.md in this directory for source and modifications.
import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'
import { MetricValue } from './metric-value'

export interface MetricListItem {
  key: string
  label: string
  value: number | string
  icon?: ReactNode
}
export interface MetricListProps extends Omit<ComponentProps<'ul'>, 'children'> {
  items: readonly MetricListItem[]
  layout?: 'rows' | 'inline'
}

/** Compact observed facts; no period change or synthetic sparkline is inferred. */
export function MetricList({ items, layout = 'rows', className, ...props }: MetricListProps) {
  return <ul data-slot="metric-list" className={cn(layout === 'inline' ? 'flex flex-wrap gap-x-5 gap-y-2' : 'flex flex-col divide-y divide-border/65', className)} {...props}>
    {items.map(item => <li key={item.key} data-slot="metric-list-row" className={layout === 'inline' ? 'flex items-center gap-2 text-[11px]' : 'flex items-center justify-between gap-4 py-2.5 text-xs first:pt-0 last:pb-0'}>
      {item.icon}<span className="text-muted-foreground">{item.label}</span><MetricValue value={item.value} className="font-mono" />
    </li>)}
  </ul>
}
