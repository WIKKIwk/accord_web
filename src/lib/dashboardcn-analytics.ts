import { isRecord } from './api'
import type { ProductionSnapshot, ResourceKind, Row } from './api-types'
import { isPlanningApparatusId } from './apparatus-planning'
import { manufacturingUnix, manufacturingUnionSeconds } from './manufacturing-time'
import type { ManufacturingTimeline } from './manufacturing-time'

export type DomainMetricsKind = 'apparatus' | 'materials' | 'warehouses' | 'stock' | 'closed'
export interface ObservedMetric { key: string; label: string; value: string }
export interface DomainMetricSummary {
  cards: ObservedMetric[]
  rows: ObservedMetric[]
  rowTitle: string
  note: string
}
const object = (value: unknown): Row => isRecord(value) ? value : {}
const name = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''
const count = (value: number, available: boolean, incomplete = false): string => !available || incomplete && !value ? '—' : `${value}${incomplete ? '+' : ''}`
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const exact = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('uz-UZ', { maximumSignificantDigits: 21 }).format(value) : '—'

export function supportsDomainMetrics(kind: ResourceKind): kind is DomainMetricsKind {
  return ['apparatus', 'materials', 'warehouses', 'stock', 'closed'].includes(kind)
}
/** Facts are scoped to the supplied loaded rows; missing native fields stay unknown. */
export function domainMetricSummary(kind: DomainMetricsKind, items: readonly Row[], available: boolean): DomainMetricSummary {
  const card = (key: string, label: string, value: number, incomplete = false): ObservedMetric => ({ key, label, value: count(value, available, incomplete) })
  if (kind === 'apparatus') {
    const projections = items.map(row => isRecord(row.runtime_projection) ? row.runtime_projection : row)
    const states = projections.map(row => name(object(row.lifecycle).state))
    const unknown = states.some(state => !['active', 'retired'].includes(state))
    return { cards: [card('loaded', 'Yuklangan apparatlar', items.length), card('active', 'Faol apparatlar', states.filter(state => state === 'active').length, unknown), card('retired', 'Ishdan chiqarilgan', states.filter(state => state === 'retired').length, unknown)], rows: [], rowTitle: 'Apparatlar navbati', note: 'Ko‘rinadigan navbatlar native ishlab chiqarish kuzatuvidan olinadi.' }
  }
  if (kind === 'materials') {
    const unknownActive = items.some(row => typeof row.active !== 'boolean')
    const variants = items.map(row => Array.isArray(row.variants) && row.variants.every(variant => isRecord(variant) && integer(variant.micron) && variant.micron > 0) ? row.variants : null)
    const variantTotal = variants.reduce((total, entries) => total + (entries?.length ?? 0), 0)
    return { cards: [card('loaded', 'Yuklangan materiallar', items.length), card('active', 'Faol materiallar', items.filter(row => row.active === true).length, unknownActive), card('variants', 'Mikron variantlari', variantTotal, variants.some(value => value === null))], rows: items.slice(0, 8).map((row, index) => ({ key: `${name(row.id)}:${index}`, label: `${name(row.name) || name(row.id) || 'Material noma’lum'}${row.active === false ? ' · faol emas' : ''}`, value: variants[index] ? `${variants[index]!.length} variant` : '—' })), rowTitle: 'Materiallarning mikron variantlari', note: 'Birinchi 8 ta yuklangan materialning variant soni. Zichlik va GSM qiymatlari jamlanmaydi.' }
  }
  if (kind === 'warehouses') {
    const unknown = items.some(row => typeof row.is_group !== 'boolean')
    const stores = items.filter(row => row.is_group === false)
    return { cards: [card('loaded', 'Yuklangan ombor yozuvlari', items.length), card('stores', 'Qoldiq saqlanadigan omborlar', stores.length, unknown), card('groups', 'Ombor guruhlari', items.filter(row => row.is_group === true).length, unknown)], rows: stores.slice(0, 8).map((row, index) => ({ key: `${name(row.warehouse)}:${index}`, label: name(row.warehouse) || 'Ombor noma’lum', value: integer(row.product_count) ? `${row.product_count} yozuv` : '—' })), rowTitle: 'Omborlardagi mahsulot yozuvlari', note: 'Server qaytargan mahsulot yozuvlari soni · birinchi 8 ta ombor. Mahsulot miqdori qoldiqlar bo‘limida o‘z birligi bilan ko‘rsatiladi.' }
  }
  if (kind === 'stock') {
    const units = new Set(items.map(row => name(row.uom)).filter(Boolean))
    let packageCount = 0, unknownPackages = false
    for (const row of items) {
      if (integer(row.package_count) && Number.isSafeInteger(packageCount + row.package_count)) packageCount += row.package_count
      else unknownPackages = true
    }
    return { cards: [card('loaded', 'Yuklangan qoldiq yozuvlari', items.length), card('units', 'O‘lchov birliklari', units.size, items.some(row => !name(row.uom))), card('packages', 'Qayd etilgan o‘ramlar', packageCount, unknownPackages)], rows: items.slice(0, 8).map((row, index) => ({ key: `${name(row.code)}:${name(row.order_id)}:${name(row.uom)}:${index}`, label: name(row.name) || name(row.code) || 'Mahsulot noma’lum', value: name(row.uom) && typeof row.on_hand_qty === 'number' && Number.isFinite(row.on_hand_qty) ? `${exact(row.on_hand_qty)} ${name(row.uom)}` : '—' })), rowTitle: 'Yuklangan qoldiqlar', note: 'Birinchi 8 ta qoldiq yozuvi. Har bir miqdor o‘z birligi bilan beriladi; turli birliklar jamlanmaydi.' }
  }
  const dates = items.map(row => manufacturingUnix(row.completed_at_unix))
  const groups = new Map<string, { label: string; count: number }>()
  for (const unix of dates) if (unix !== null) {
    const date = new Date(unix * 1000), key = date.toISOString().split('T')[0]
    const group = groups.get(key) ?? { label: new Intl.DateTimeFormat('uz-UZ', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date), count: 0 }
    group.count += 1; groups.set(key, group)
  }
  return { cards: [card('loaded', 'Yuklangan yopilgan buyurtmalar', items.length), card('dated', 'Yakun vaqti qayd etilgan', dates.filter(date => date !== null).length, dates.some(date => date === null)), card('logs', 'Hodisalar qaydi mavjud', items.filter(row => Array.isArray(row.logs) && row.logs.length > 0).length, items.some(row => !Array.isArray(row.logs)))], rows: [...groups].sort(([a], [b]) => b.localeCompare(a)).slice(0, 8).map(([key, group]) => ({ key, label: group.label, value: `${group.count} buyurtma` })), rowTitle: 'Yakun qaydi sanalari · UTC', note: 'Yuklangan tarixdagi eng so‘nggi 8 ta sana. API oxirgi 200 tagacha yopilgan buyurtmani saqlaydi; bu to‘liq kunlik ishlab chiqarish hisoboti emas.' }
}

export interface ApparatusQueueDistribution {
  rows: (ObservedMetric & { apparatusId: string; orderCount: number | null })[]
  bins: { label: string; count: number }[]
  knownCount: number
  unknownCount: number
}
/** Empty native arrays establish zero; absence, duplicate identities and malformed lists do not. */
export function apparatusQueueDistribution(items: readonly Row[], snapshot?: ProductionSnapshot): ApparatusQueueDistribution {
  const projections = items.map(row => isRecord(row.runtime_projection) ? row.runtime_projection : row)
  const ids = projections.map(row => isPlanningApparatusId(row.apparatus_id) ? row.apparatus_id : '')
  const duplicates = new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))
  const visible = snapshot?.ok === true && isRecord(snapshot.visible_order_ids) ? snapshot.visible_order_ids : null
  const rows = projections.map((row, index) => {
    const apparatusId = ids[index]
    const value = visible && apparatusId && !duplicates.has(apparatusId) && Object.hasOwn(visible, apparatusId) ? visible[apparatusId] : null
    const valid = Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0 && id === id.trim()) && new Set(value).size === value.length
    const orderCount = valid ? value.length : null
    return { key: `${apparatusId || 'unknown'}:${index}`, apparatusId, label: name(object(row.display).display_name) || apparatusId || 'Apparat identifikatori noma’lum', value: orderCount === null ? '—' : `${orderCount} buyurtma`, orderCount }
  })
  const bins = [{ label: '0 buyurtma', count: 0 }, { label: '1 buyurtma', count: 0 }, { label: '2 buyurtma', count: 0 }, { label: '3+ buyurtma', count: 0 }]
  for (const row of rows) if (row.orderCount !== null) bins[Math.min(row.orderCount, 3)].count += 1
  const knownCount = rows.filter(row => row.orderCount !== null).length
  return { rows, bins, knownCount, unknownCount: rows.length - knownCount }
}

export interface MaterialMicronMatrix {
  columns: number[]
  rows: { key: string; label: string; values: (0 | 1 | null)[] }[]
  omittedRows: number
  omittedColumns: number
  unknownRows: number
}
/** Presence in the full native variant array is catalog configuration, never inventory availability. */
export function materialMicronMatrix(items: readonly Row[]): MaterialMicronMatrix {
  const ids = items.map(row => typeof row.id === 'string' && row.id.length > 0 && row.id === row.id.trim() ? row.id : '')
  const duplicates = new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))
  const variants = items.map((row, index) => {
    if (!ids[index] || duplicates.has(ids[index]) || !Array.isArray(row.variants) || !row.variants.every(variant => isRecord(variant) && integer(variant.micron) && variant.micron > 0 && variant.micron <= 4_294_967_295)) return null
    const microns = row.variants.map(variant => (variant as Row).micron as number)
    return new Set(microns).size === microns.length ? microns : null
  })
  const allColumns = [...new Set(variants.flatMap(entries => entries ?? []))].sort((a, b) => a - b)
  const columns = allColumns.slice(0, 12)
  const rows = items.slice(0, 8).map((row, index) => ({ key: `${ids[index] || 'unknown'}:${index}`, label: `${name(row.name) || ids[index] || 'Material noma’lum'}${row.active === false ? ' · faol emas' : ''}`, values: columns.map(micron => variants[index] === null ? null : variants[index]!.includes(micron) ? 1 as const : 0 as const) }))
  return { columns, rows, omittedRows: Math.max(0, items.length - rows.length), omittedColumns: Math.max(0, allColumns.length - columns.length), unknownRows: variants.filter(entries => entries === null).length }
}

export type RetainedHistoryPeriod = '7d' | '30d' | 'all'
export interface RetainedTimeBin { startUnix: number; endUnix: number; label: string }
export interface RetainedHistoryOptions { timeZone?: string }
interface RecordedSpan { apparatus: string; state: 'in_progress' | 'paused'; startUnix: number; endUnix: number }
export interface RetainedHistoryAnalytics {
  asOfUnix: number | null
  timeZone: string | null
  period: RetainedHistoryPeriod
  bins: RetainedTimeBin[]
  series: { date: string; inProgress: number | null; paused: number | null }[]
  observedIntervalCount: number
}

/** Validate an explicitly supplied zone; an invalid zone is unknown, never silently UTC. */
export function historyTimeZone(timeZone: string): string | null {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone }).resolvedOptions().timeZone } catch { return null }
}

/** Actual local date boundaries, including short/long DST days and skipped civil dates. */
export function zonedHistoryDateBins(startUnix: number, endUnix: number, timeZone: string, maximumBins = 16): RetainedTimeBin[] {
  const zone = historyTimeZone(timeZone)
  if (!zone || manufacturingUnix(startUnix) === null || manufacturingUnix(endUnix) === null || endUnix < startUnix || !Number.isSafeInteger(maximumBins) || maximumBins < 1 || maximumBins > 128) return []
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' })
  const dayAt = (unix: number): number | null => {
    const date = new Date(unix * 1000)
    if (!Number.isFinite(date.getTime())) return null
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
    const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000
    return Number.isSafeInteger(day) ? day : null
  }
  const firstDay = dayAt(startUnix), lastDay = dayAt(endUnix)
  if (firstDay === null || lastDay === null || lastDay < firstDay) return []
  const boundaries = new Map<number, number | null>()
  const boundary = (day: number): number | null => {
    if (boundaries.has(day)) return boundaries.get(day)!
    // All offset arithmetic is delegated to Intl. Search seconds around the civil
    // date rather than adding 24 hours to a zoned midnight across a DST change.
    let low = day * 86400 - 2 * 86400, high = day * 86400 + 2 * 86400
    if (dayAt(low) === null || dayAt(high) === null) { boundaries.set(day, null); return null }
    while (low < high) {
      const middle = Math.floor((low + high) / 2), actual = dayAt(middle)
      if (actual === null) { boundaries.set(day, null); return null }
      if (actual < day) low = middle + 1
      else high = middle
    }
    boundaries.set(day, low)
    return low
  }
  const step = Math.max(1, Math.ceil((lastDay - firstDay + 1) / maximumBins))
  const includeYear = new Date(firstDay * 86_400_000).getUTCFullYear() !== new Date(lastDay * 86_400_000).getUTCFullYear()
  const labelFormatter = new Intl.DateTimeFormat('uz-UZ', { timeZone: 'UTC', day: '2-digit', month: '2-digit', ...(includeYear ? { year: 'numeric' } : {}) })
  const label = (day: number) => labelFormatter.format(new Date(day * 86_400_000))
  const bins: RetainedTimeBin[] = []
  for (let day = firstDay; day <= lastDay && bins.length < maximumBins; day += step) {
    const nextDay = Math.min(day + step, lastDay + 1), start = boundary(day), end = boundary(nextDay)
    if (start === null || end === null) return []
    if (end <= start) continue // A skipped civil date is not an observed zero day.
    bins.push({ startUnix: start, endUnix: end, label: nextDay - day === 1 ? label(day) : `${label(day)}–${label(nextDay - 1)}` })
  }
  return bins
}

/** A local view of retained, validated closed-order intervals. No clock, request or extrapolation. */
export function retainedHistoryAnalytics(timelines: readonly ManufacturingTimeline[], period: RetainedHistoryPeriod = 'all', requestedAsOf?: number | null, options: RetainedHistoryOptions = {}): RetainedHistoryAnalytics {
  const timeZone = historyTimeZone(options.timeZone ?? 'UTC')
  const unique = new Map<string, ManufacturingTimeline>()
  for (const timeline of timelines) if (timeline.source === 'closed_order' && timeline.orderId && manufacturingUnix(timeline.asOfUnix) !== null) {
    const previous = unique.get(timeline.orderId)
    if (!previous || timeline.asOfUnix! > previous.asOfUnix!) unique.set(timeline.orderId, timeline)
  }
  const asOfUnix = requestedAsOf === undefined ? manufacturingUnix(Math.max(0, ...[...unique.values()].map(timeline => timeline.asOfUnix!))) : manufacturingUnix(requestedAsOf)
  const allSpans: RecordedSpan[] = []
  if (asOfUnix !== null) for (const timeline of unique.values()) for (const stage of timeline.stages) {
    if (!stage.apparatus) continue
    for (const interval of stage.intervals) {
      if (!['in_progress', 'paused'].includes(interval.state) || manufacturingUnix(interval.startUnix) === null || manufacturingUnix(interval.endUnix) === null || interval.endUnix <= interval.startUnix || interval.endUnix > timeline.asOfUnix! || interval.endUnix > asOfUnix) continue
      const start = timeline.events.find(event => event.id === interval.startEventId), end = timeline.events.find(event => event.id === interval.endEventId)
      if (!start || !end || start.kind !== 'queue' || end.kind !== 'queue' || !start.transition || !end.transition || start.stageKey !== stage.key || end.stageKey !== stage.key || start.atUnix !== interval.startUnix || end.atUnix !== interval.endUnix || start.toState !== interval.state || end.fromState !== interval.state || stage.gaps.some(gap => gap.startUnix < interval.endUnix && gap.endUnix > interval.startUnix)) continue
      allSpans.push({ apparatus: stage.apparatus, state: interval.state as RecordedSpan['state'], startUnix: interval.startUnix, endUnix: interval.endUnix })
    }
  }
  const apparatusMap = new Map<string, string>()
  for (const span of allSpans) if (!apparatusMap.has(span.apparatus)) apparatusMap.set(span.apparatus, span.apparatus)
  const apparatus = [...apparatusMap].map(([value, label]) => ({ value, label }))
  const startUnix = asOfUnix === null ? null : period === 'all' ? allSpans.length ? Math.min(...allSpans.map(span => span.startUnix)) : asOfUnix - 7 * 86400 : Math.max(1, asOfUnix - (period === '7d' ? 7 : 30) * 86400)
  const spans = startUnix === null ? [] : allSpans.flatMap(span => {
    const start = Math.max(span.startUnix, startUnix), end = Math.min(span.endUnix, asOfUnix!)
    return end > start ? [{ ...span, startUnix: start, endUnix: end }] : []
  })
  const bins = startUnix !== null && asOfUnix !== null && timeZone !== null ? zonedHistoryDateBins(startUnix, asOfUnix, timeZone) : []
  const clipped = (entries: readonly RecordedSpan[], bin: RetainedTimeBin) => entries.flatMap(span => {
    const start = Math.max(span.startUnix, bin.startUnix), end = Math.min(span.endUnix, bin.endUnix)
    return end > start ? [{ startUnix: start, endUnix: end }] : []
  })
  const series = bins.map(bin => {
    const inBin = spans.filter(span => span.endUnix > bin.startUnix && span.startUnix < bin.endUnix)
    if (!inBin.length) return { date: bin.label, inProgress: null, paused: null }
    const total = (state: RecordedSpan['state']) => apparatus.reduce((sum, entry) => sum + (manufacturingUnionSeconds(clipped(inBin.filter(span => span.apparatus === entry.value && span.state === state), bin)) ?? 0), 0)
    return { date: bin.label, inProgress: total('in_progress'), paused: total('paused') }
  })
  return { asOfUnix, timeZone, period, bins, series, observedIntervalCount: spans.length }
}
