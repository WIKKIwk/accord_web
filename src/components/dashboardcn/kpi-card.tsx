// Adapted from dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// See LICENSE and PROVENANCE.md in this directory for source and modifications.
import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricValue } from './metric-value'

export interface KpiCardProps extends Omit<ComponentProps<'div'>, 'children'> {
  label: string
  value: number | string
  valueId: string
  valueClassName?: string
  loading?: boolean
  adornment?: ReactNode
  children?: ReactNode
}

/** The enclosing Home link owns the card surface and complete touch target. */
export function KpiCard({ label, value, valueId, valueClassName, loading = false, adornment, className, children, ...props }: KpiCardProps) {
  return <div data-slot="kpi-card" className={cn('min-w-0', className)} {...props}>
    <div className="flex items-start justify-between gap-1"><p className="min-h-8 text-[11px] font-medium leading-4 text-muted-foreground sm:min-h-0">{label}</p>{adornment}</div>
    {loading ? <Skeleton id={valueId} className="mt-1.5 h-8 w-12 sm:mt-2 sm:h-10 sm:w-16" aria-label={`${label} yuklanmoqda`} /> : <p id={valueId} className={cn('mt-1.5 text-[1.9rem] font-medium leading-none tracking-[-0.045em] tabular-nums sm:mt-2', valueClassName)}><MetricValue value={value} /></p>}
    {children}
  </div>
}
