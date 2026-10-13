// Adapted from dashboardcn, Copyright (c) 2026 dashboardcn contributors (MIT).
// See LICENSE and PROVENANCE.md in this directory for source and modifications.
import { Children, type ComponentProps } from 'react'
import { cn } from 'cn'

export type TimelineStatus = 'default' | 'current' | 'done'

/** Presentational chronology only. Server adapters own ordering and evidence. */
export function Timeline({ className, ...props }: ComponentProps<'ol'>) {
  return <ol data-slot="timeline" className={cn('flex flex-col', className)} {...props} />
}
export interface TimelineItemProps extends ComponentProps<'li'> { status?: TimelineStatus }
export function TimelineItem({ status = 'default', className, ...props }: TimelineItemProps) {
  return <li data-slot="timeline-item" data-status={status} aria-current={status === 'current' ? 'true' : undefined} className={cn('group/timeline-item relative', className)} {...props} />
}
export function TimelineRail({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="timeline-rail" className={cn('relative row-span-2 flex justify-center sm:row-span-1', className)} {...props} />
}
export function TimelineMarker({ className, children, ...props }: ComponentProps<'span'>) {
  const empty = Children.count(children) === 0
  return <span data-slot="timeline-marker" aria-hidden={empty ? 'true' : undefined} className={cn('relative z-20 mt-1 size-1.5 rounded-full bg-muted-foreground/70', className)} {...props}>{children}</span>
}
export function TimelineConnector({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="timeline-connector" aria-hidden="true" className={cn('absolute -bottom-7 -top-3 w-px bg-border group-last/timeline-item:hidden', className)} {...props} />
}
export function TimelineContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="timeline-content" className={cn('min-w-0', className)} {...props} />
}
export function TimelineTime({ className, ...props }: ComponentProps<'time'>) {
  return <time data-slot="timeline-time" className={cn('pt-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground', className)} {...props} />
}
