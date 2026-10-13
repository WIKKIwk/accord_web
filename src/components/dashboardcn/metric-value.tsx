// Adapted from dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// See LICENSE and PROVENANCE.md in this directory for source and modifications.
import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

export interface MetricValueProps extends Omit<ComponentProps<'span'>, 'children'> {
  value: number | string
  suffix?: ReactNode
}

/** Exact values and already formatted native bounds remain visible at every size. */
export function MetricValue({ value, suffix, className, ...props }: MetricValueProps) {
  const display = typeof value === 'number'
    ? Number.isFinite(value) ? new Intl.NumberFormat('uz-UZ', { maximumSignificantDigits: 21 }).format(value) : '—'
    : value
  return <span data-slot="metric-value" className={cn('tabular-nums', className)} {...props}>{display}{suffix}</span>
}
