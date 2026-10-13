// dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// Manually reviewed at b1ffacbca0f7a0be60135c8665b9e8c267205c48; see PROVENANCE.md.
"use client"

import * as React from "react"

import { cn } from "cn"
import { formatNumber, type NumberFormat } from "./format"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Values at or above this are abbreviated by default. */
export const DEFAULT_COMPACT_FROM = 100_000

export interface MetricValueProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** Strings render as-is. */
  value: number | string
  format?: NumberFormat
  currency?: string
  maximumFractionDigits?: number
  /** Values at or above this are abbreviated (e.g. $158K) with the full value in a tooltip. Set to Infinity to always show the full value. */
  compactFrom?: number
  /** Text after the number, e.g. a unit. */
  suffix?: React.ReactNode
}

/** A formatted number. Large values are abbreviated and reveal the full value on hover. */
function MetricValue({
  value,
  format,
  currency,
  maximumFractionDigits,
  compactFrom = DEFAULT_COMPACT_FROM,
  suffix,
  className,
  ...props
}: MetricValueProps) {
  const classes = cn("tabular-nums", className)

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return (
      <span data-slot="metric-value" className={classes} {...props}>
        {typeof value === "number" ? "—" : value}
        {suffix}
      </span>
    )
  }

  const full = formatNumber(value, { format, currency, maximumFractionDigits })
  const abbreviate = format !== "percent" && Math.abs(value) >= compactFrom
  if (!abbreviate) {
    return (
      <span data-slot="metric-value" className={classes} {...props}>
        {full}
        {suffix}
      </span>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="metric-value"
            data-compact=""
            className={cn(classes, "cursor-default")}
            {...props}
          >
            {formatNumber(value, { format, currency, compact: true })}
            {suffix}
          </span>
        </TooltipTrigger>
        <TooltipContent className="tabular-nums">
          {full}
          {suffix}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { MetricValue }
