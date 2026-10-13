import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

/** Dashboard surfaces share the app's colors; their layout is independent of CRUD cards. */
export function DashboardSurface({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="dashboard-surface" className={cn('min-w-0 overflow-hidden rounded-[1.35rem] border border-border/70 bg-card text-card-foreground', className)} {...props} />
}

export function DashboardMetric({ label, value, detail, className, valueClassName }: { label: string; value: ReactNode; detail: ReactNode; className?: string; valueClassName?: string }) {
  return <div className={cn('min-w-0 px-5 py-5 sm:px-6', className)}>
    <p className="text-[11px] font-medium leading-4 text-muted-foreground">{label}</p>
    <p className={cn('mt-2 text-[2.5rem] font-medium leading-none tracking-[-0.045em] tabular-nums', valueClassName)}>{value}</p>
    <p className="mt-2.5 text-[11px] leading-[1.6] text-muted-foreground">{detail}</p>
  </div>
}

export function DashboardNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[11px] leading-[1.7] text-muted-foreground', className)}>{children}</p>
}
