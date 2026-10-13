// dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// Manually reviewed at b1ffacbca0f7a0be60135c8665b9e8c267205c48; see PROVENANCE.md.
"use client"

import * as React from "react"

import { cn } from "cn"
import { type NumberFormat } from "./format"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { DeltaBadge, getDeltaDirection } from "./delta-badge"
import { Sparkline } from "./sparkline"
import { MetricValue } from "./metric-value"
import { Skeleton } from "@/components/ui/skeleton"

export interface KpiCardProps extends Omit<
  React.ComponentProps<typeof Card>,
  "children"
> {
  /** Metric name, e.g. "Revenue". */
  label: string
  /** Current value. Numbers are formatted with `format`; strings render as-is. */
  value: number | string
  /** Fractional change vs. the previous period, e.g. 0.124 for +12.4%. */
  delta?: number
  /** Context for the delta, e.g. "vs. last 30 days". */
  deltaLabel?: string
  /** Series for the sparkline. Rendered when it has two or more points. */
  trend?: number[]
  format?: NumberFormat
  /** ISO 4217 code, used when `format` is "currency". */
  currency?: string
  /** Treat a decrease as good and an increase as bad (churn, latency, errors). */
  invertDelta?: boolean
  /** Optional icon shown before the label. */
  icon?: React.ReactNode
  /** Native loading state; no provisional number is shown. */
  loading?: boolean
  /** Stable accessible identity used by the enclosing navigation link. */
  valueId?: string
  valueClassName?: string
  children?: React.ReactNode
}

function KpiCard({
  label,
  value,
  delta,
  deltaLabel,
  trend,
  format = "number",
  currency,
  invertDelta = false,
  icon,
  loading = false,
  valueId,
  valueClassName,
  className,
  children,
  ...props
}: KpiCardProps) {
  const direction = getDeltaDirection(delta)
  const isPositive =
    direction === "flat" ? null : (direction === "up") !== invertDelta
  const trendColor =
    isPositive === true
      ? "var(--color-emerald-500)"
      : isPositive === false
        ? "var(--color-red-500)"
        : "var(--primary)"

  return (
    <Card
      data-slot="kpi-card"
      data-direction={direction}
      className={cn("gap-4 py-5", className)}
      {...props}
    >
      <CardHeader className="px-5">
        <CardDescription className="flex items-center gap-1.5 [&>svg]:size-4">
          {icon}
          {label}
        </CardDescription>
        <CardTitle id={valueId} className={cn("text-2xl font-semibold tabular-nums tracking-tight", valueClassName)}>
          {loading ? <Skeleton className="h-8 w-12 sm:h-10 sm:w-16" aria-label={`${label} yuklanmoqda`} /> : <MetricValue value={value} format={format} currency={currency} compactFrom={Infinity} />}
        </CardTitle>
        {delta !== undefined ? (
          <CardAction>
            <DeltaBadge delta={delta} invert={invertDelta} />
          </CardAction>
        ) : null}
      </CardHeader>
      {trend && trend.length > 1 ? (
        <CardContent className="px-5">
          <Sparkline data={trend} color={trendColor} />
        </CardContent>
      ) : null}
      {deltaLabel || children ? (
        <CardContent className="text-muted-foreground flex items-center gap-2 px-5 text-xs">
          {deltaLabel ? <span>{deltaLabel}</span> : null}
          {children}
        </CardContent>
      ) : null}
    </Card>
  )
}

export { KpiCard }
