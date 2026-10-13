// dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// Manually reviewed at b1ffacbca0f7a0be60135c8665b9e8c267205c48; see PROVENANCE.md.
"use client"

import * as React from "react"

import { cn } from "cn"
import { type NumberFormat } from "./format"
import { DeltaBadge, getDeltaDirection } from "./delta-badge"
import { Sparkline } from "./sparkline"
import { MetricValue } from "./metric-value"

export interface MetricListItem {
  label: string
  value: number | string
  delta?: number
  trend?: number[]
  format?: NumberFormat
  currency?: string
  invertDelta?: boolean
  icon?: React.ReactNode
  key?: string
}

export interface MetricListProps extends React.ComponentProps<"div"> {
  items: readonly MetricListItem[]
  /** Sparkline variant. */
  variant?: "area" | "line"
  /** Sparkline area fill. */
  fill?: "gradient" | "dots"
  showDivider?: boolean
}

/** Compact rows of label, sparkline, value, and delta. */
function MetricList({
  items,
  variant = "line",
  fill,
  showDivider = true,
  className,
  ...props
}: MetricListProps) {
  return (
    <div
      data-slot="metric-list"
      className={cn("flex flex-col", showDivider && "divide-y", className)}
      {...props}
    >
      {items.map((item) => {
        const direction = getDeltaDirection(item.delta)
        const positive =
          direction === "flat" ? null : (direction === "up") !== Boolean(item.invertDelta)
        const color =
          positive === true
            ? "var(--color-emerald-500)"
            : positive === false
              ? "var(--color-red-500)"
              : "var(--muted-foreground)"
        return (
          <div
            key={item.key ?? item.label}
            data-slot="metric-list-row"
            className="flex items-center gap-4 py-2.5 text-sm first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {item.icon ? (
                <span className="text-muted-foreground shrink-0 [&>svg]:size-4">
                  {item.icon}
                </span>
              ) : null}
              <span className="truncate">{item.label}</span>
            </div>
            {item.trend && item.trend.length > 1 ? (
              <Sparkline
                data={item.trend}
                variant={variant}
                fill={fill}
                color={color}
                className="h-6 w-20 shrink-0"
              />
            ) : null}
            <div className="flex w-28 shrink-0 items-center justify-end gap-2 tabular-nums">
              <MetricValue
                value={item.value}
                format={item.format}
                currency={item.currency}
                compactFrom={Infinity}
                className="font-medium"
              />
              {item.delta !== undefined ? (
                <DeltaBadge
                  delta={item.delta}
                  invert={item.invertDelta}
                  variant="text"
                  showIcon={false}
                />
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export { MetricList }
