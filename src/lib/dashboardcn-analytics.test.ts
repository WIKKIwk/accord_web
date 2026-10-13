import { describe, expect, it } from 'vitest'
import { apparatusQueueDistribution, domainMetricSummary, materialMicronMatrix } from './dashboardcn-analytics'

describe('resource dashboardcn facts', () => {
  it('uses native execution and lifecycle profiles while retaining unknown apparatus states', () => {
    const result = domainMetricSummary('apparatus', [
      { apparatus_id: 'a', lifecycle: { state: 'active' }, execution_profile: { operation: 'print' } },
      { apparatus_id: 'b', lifecycle: {}, execution_profile: { operation: 'future_operation' } },
      { runtime_projection: { apparatus_id: 'c', lifecycle: { state: 'retired' }, execution_profile: { operation: 'cut' } } },
    ], true)
    expect(result.cards.map(card => card.value)).toEqual(['3', '1+', '1+'])
    expect(result.rows).toEqual([])
  })
  it('does not turn missing material variants or active fields into zero', () => {
    const result = domainMetricSummary('materials', [{ id: 'pet', name: 'PET', active: true, variants: [{ micron: 12 }] }, { id: 'pe', name: 'PE', variants: null }], true)
    expect(result.cards.map(card => card.value)).toEqual(['2', '1+', '1+'])
    expect(result.rows.map(row => row.value)).toEqual(['1 variant', '—'])
  })
  it('shows warehouse group/type counts and only authoritative product_count fields', () => {
    const result = domainMetricSummary('warehouses', [{ warehouse: 'Guruh', is_group: true }, { warehouse: 'Ombor', is_group: false, product_count: 0 }, { warehouse: 'Boshqa', is_group: false }], true)
    expect(result.cards.map(card => card.value)).toEqual(['3', '2', '1'])
    expect(result.rows.map(row => row.value)).toEqual(['0 yozuv', '—'])
  })
  it('keeps individual quantities next to their own units and refuses missing quantity/unit/package facts', () => {
    const result = domainMetricSummary('stock', [{ code: 'kg', on_hand_qty: 12.345678, uom: 'kg', package_count: 2 }, { code: 'metre', on_hand_qty: 500, uom: 'metr' }, { code: 'missing', on_hand_qty: 0 }], true)
    expect(result.cards.map(card => card.value)).toEqual(['3', '2+', '2+'])
    expect(result.rows.map(row => row.value)).toEqual(['12,345678 kg', '500 metr', '—'])
    expect(JSON.stringify(result)).not.toContain('512')
  })
  it('counts retained closing-date facts rather than inventing complete daily totals', () => {
    const unix = Date.UTC(2026, 9, 13, 12) / 1000
    const result = domainMetricSummary('closed', [{ order_id: 'one', completed_at_unix: unix, logs: [{}] }, { order_id: 'two', completed_at_unix: unix + 60, logs: [] }, { order_id: 'missing', completed_at_unix: '2026-10-13' }], true)
    expect(result.cards.map(card => card.value)).toEqual(['3', '2+', '1+'])
    expect(result.rows).toHaveLength(1); expect(result.rows[0].value).toBe('2 buyurtma'); expect(result.note).toContain('200')
  })
  it('shows an unknown metric when the query has no data instead of claiming a zero count', () => {
    for (const kind of ['apparatus', 'materials', 'warehouses', 'stock', 'closed'] as const) expect(domainMetricSummary(kind, [], false).cards.every(card => card.value === '—')).toBe(true)
  })
})

import { buildManufacturingTimeline } from './manufacturing-time'
import { historyTimeZone, retainedHistoryAnalytics, zonedHistoryDateBins } from './dashboardcn-analytics'
import type { ProductionSnapshot, Row } from './api-types'

const machine = 'apparatus:print:fixture', observedAt = Date.UTC(2026, 9, 13, 12) / 1000
function recorded(orderId: string, transitions: { at: number; from: string; to: string; action: string }[], asOfUnix = observedAt) {
  const logs: Row[] = transitions.map((event, index) => ({ event_id: `${orderId}-${index}`, order_id: orderId, apparatus: machine, stage_node_id: 'print', action: event.action, from_state: event.from, to_state: event.to, created_at_unix: event.at }))
  return buildManufacturingTimeline({ orderId, closedOrder: { order_id: orderId, title: orderId, logs, completed_at_unix: transitions.at(-1)?.at }, map: { id: orderId, nodes: [{ id: 'print', kind: 'apparatus', apparatus_id: machine, title: 'Bosma' }], edges: [] }, asOfUnix })
}
function running(orderId: string, start: number, end: number, asOfUnix = observedAt) {
  return recorded(orderId, [{ at: start, from: 'pending', to: 'in_progress', action: 'start' }, { at: end, from: 'in_progress', to: 'completed', action: 'complete' }], asOfUnix)
}

describe('retained recorded dashboardcn analytics', () => {
  it('unions overlapping orders on the same apparatus per state', () => {
    const result = retainedHistoryAnalytics([running('one', observedAt - 600, observedAt - 300), running('two', observedAt - 500, observedAt - 200)], 'all', observedAt)
    expect(result.series).toHaveLength(1)
    expect(result.series[0]).toMatchObject({ inProgress: 400, paused: 0 })
  })
  it('splits real recorded spans at UTC midnight without assigning the whole duration to either day', () => {
    const midnight = Date.UTC(2026, 9, 13) / 1000
    const result = retainedHistoryAnalytics([running('crosses-midnight', midnight - 300, midnight + 600)], 'all', observedAt)
    expect(result.bins).toHaveLength(2)
    expect(result.series.map(row => row.inProgress)).toEqual([300, 600])
  })
  it('clips the retained seven-day view to the fetch as-of boundary and leaves unobserved dates null', () => {
    const result = retainedHistoryAnalytics([running('crosses-start', observedAt - 8 * 86400, observedAt - 6 * 86400)], '7d', observedAt)
    expect(result.series.reduce((sum, row) => sum + (row.inProgress ?? 0), 0)).toBe(86400)
    expect(result.series.some(row => row.inProgress === null && row.paused === null)).toBe(true)
    expect(result.asOfUnix).toBe(observedAt)
    expect(result.bins.at(-1)!.endUnix).toBe(Date.UTC(2026, 9, 14) / 1000)
    expect(result.observedIntervalCount).toBe(1)
  })
  it('filters old retained evidence out of seven/thirty-day views without inventing a complete current period total', () => {
    const old = running('old', observedAt - 40 * 86400, observedAt - 40 * 86400 + 300)
    expect(retainedHistoryAnalytics([old], 'all', observedAt).observedIntervalCount).toBe(1)
    for (const period of ['7d', '30d'] as const) {
      const result = retainedHistoryAnalytics([old], period, observedAt)
      expect(result.observedIntervalCount).toBe(0)
      expect(result.series.every(row => row.inProgress === null && row.paused === null)).toBe(true)
    }
  })
  it('distinguishes an observed pause-only interval from a day with no observation', () => {
    const paused = recorded('paused', [{ at: observedAt - 600, from: 'in_progress', to: 'paused', action: 'pause' }, { at: observedAt - 300, from: 'paused', to: 'in_progress', action: 'resume' }])
    const result = retainedHistoryAnalytics([paused], '7d', observedAt)
    expect(result.series.at(-1)).toMatchObject({ inProgress: 0, paused: 300 })
  })
  it('does not extrapolate stale spans, accepts only closed history, and de-duplicates the same order by newest fetch', () => {
    const early = running('one', observedAt - 600, observedAt - 300, observedAt - 200)
    const latest = running('one', observedAt - 600, observedAt - 100)
    const result = retainedHistoryAnalytics([early, latest, { ...latest, orderId: 'lineage', source: 'batch_lineage' }], 'all', observedAt + 86400)
    expect(result.observedIntervalCount).toBe(1)
    expect(result.series.reduce((sum, row) => sum + (row.inProgress ?? 0), 0)).toBe(500)
  })
  it('rejects tampered interval endpoints, future bounds, state mismatch and gaps without converting them to observed zero', () => {
    const timeline = running('one', observedAt - 600, observedAt - 300)
    const stage = timeline.stages[0]
    const invalid = [
      { ...timeline, asOfUnix: observedAt - 400 },
      { ...timeline, stages: [{ ...stage, intervals: stage.intervals.map(interval => ({ ...interval, endEventId: 'not-the-saved-event' })) }] },
      { ...timeline, stages: [{ ...stage, intervals: stage.intervals.map(interval => ({ ...interval, state: 'paused' as const })) }] },
      { ...timeline, stages: [{ ...stage, gaps: [{ startUnix: observedAt - 500, endUnix: observedAt - 400, reason: 'conflict' as const }] }] },
    ]
    for (const value of invalid) {
      const result = retainedHistoryAnalytics([value], 'all', observedAt)
      expect(result.observedIntervalCount).toBe(0); expect(result.series.every(row => row.inProgress === null && row.paused === null)).toBe(true)
    }
  })
  it('uses at most sixteen actual dated bins for an all-history range and keeps missing observation time unknown', () => {
    const old = running('old', observedAt - 100 * 86400, observedAt - 100 * 86400 + 300)
    const result = retainedHistoryAnalytics([old], 'all', observedAt)
    expect(result.bins.length).toBeLessThanOrEqual(16)
    expect(result.series.reduce((sum, row) => sum + (row.inProgress ?? 0), 0)).toBe(300)
    expect(retainedHistoryAnalytics([old], 'all', null)).toMatchObject({ asOfUnix: null, bins: [], series: [], observedIntervalCount: 0 })
  })
})

function nativeQueues(visible: Record<string, unknown>): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'queue-fixture', scope: 'admin', maps: [], order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {}, visible_order_ids: visible }
}
const apparatusRow = (suffix: string): Row => ({ apparatus_id: `apparatus:default:${suffix}`, display: { display_name: suffix } })

describe('apparatus visible queue distribution from native identities', () => {
  it('counts zero only for a valid native empty list and bins exact counts as 0/1/2/3+', () => {
    const items = ['zero', 'one', 'two', 'many', 'missing'].map(apparatusRow)
    const result = apparatusQueueDistribution(items, nativeQueues({
      'apparatus:default:zero': [], 'apparatus:default:one': ['order-one'],
      'apparatus:default:two': ['order-two-a', 'order-two-b'],
      'apparatus:default:many': ['order-a', 'order-b', 'order-c', 'order-d'],
    }))
    expect(result.rows.map(row => row.value)).toEqual(['0 buyurtma', '1 buyurtma', '2 buyurtma', '4 buyurtma', '—'])
    expect(result.bins.map(bin => bin.count)).toEqual([1, 1, 1, 1])
    expect(result).toMatchObject({ knownCount: 4, unknownCount: 1 })
  })
  it('keeps malformed lists, duplicate/blank/non-string order IDs, and absent keys unknown', () => {
    const cases: unknown[] = [null, {}, ['same', 'same'], [''], [' spaced '], [42], undefined]
    for (const value of cases) {
      const result = apparatusQueueDistribution([apparatusRow('one')], nativeQueues({ 'apparatus:default:one': value }))
      expect(result.rows[0].orderCount).toBeNull(); expect(result.rows[0].value).toBe('—')
      expect(result.bins.every(bin => bin.count === 0)).toBe(true)
      expect(result).toMatchObject({ knownCount: 0, unknownCount: 1 })
    }
  })
  it('does not join malformed or duplicate loaded apparatus identities to a known zero', () => {
    const rows = [apparatusRow('duplicate'), apparatusRow('duplicate'), { apparatus_id: ' apparatus:default:space ' }, { apparatus_id: 'apparatus:default:Uppercase' }, { apparatus_id: 'apparatus:default:a:extra' }, { name: 'missing identity' }]
    const result = apparatusQueueDistribution(rows, nativeQueues({ 'apparatus:default:duplicate': [], ' apparatus:default:space ': [], 'apparatus:default:Uppercase': [], 'apparatus:default:a:extra': [] }))
    expect(result.rows.every(row => row.orderCount === null)).toBe(true)
    expect(result.unknownCount).toBe(6); expect(result.knownCount).toBe(0)
  })
  it('uses only loaded apparatus IDs and preserves exact retained snapshot counts', () => {
    const snapshot = nativeQueues({ 'apparatus:default:one': ['saved'], 'apparatus:default:outside': [] })
    const result = apparatusQueueDistribution([{ runtime_projection: apparatusRow('one') }], snapshot)
    expect(result.rows).toHaveLength(1); expect(result.rows[0].value).toBe('1 buyurtma')
    expect(apparatusQueueDistribution([apparatusRow('one')]).rows[0].value).toBe('—')
  })
})

describe('material × micron native variant presence', () => {
  it('sorts actual microns and distinguishes known absence from missing or malformed variant arrays', () => {
    const result = materialMicronMatrix([
      { id: 'pet', name: 'PET', variants: [{ micron: 20 }, { micron: 12 }] },
      { id: 'pe', name: 'PE', variants: [{ micron: 50 }] },
      { id: 'empty', name: 'Empty configured', variants: [] },
      { id: 'missing', name: 'Missing' },
      { id: 'invalid', name: 'Invalid', variants: [{ micron: 0 }, { micron: 75 }] },
    ])
    expect(result.columns).toEqual([12, 20, 50])
    expect(result.rows.map(row => row.values)).toEqual([[1, 1, 0], [0, 0, 1], [0, 0, 0], [null, null, null], [null, null, null]])
    expect(result.unknownRows).toBe(2)
  })
  it('refuses numeric strings, nonpositive/fractional/out-of-u32 values and duplicate native micron variants', () => {
    for (const variants of [[{ micron: '12' }], [{ micron: -1 }], [{ micron: 12.5 }], [{ micron: 4_294_967_296 }], [{ micron: 12 }, { micron: 12 }], '12']) {
      const result = materialMicronMatrix([{ id: 'known', variants: [{ micron: 12 }] }, { id: 'invalid', variants }])
      expect(result.rows[1].values).toEqual([null]); expect(result.unknownRows).toBe(1)
    }
  })
  it('keeps duplicate/missing native material identities unknown and discloses actual row/column truncation', () => {
    const result = materialMicronMatrix([
      { id: 'duplicate', variants: [] }, { id: 'duplicate', variants: [] }, { variants: [] },
      ...Array.from({ length: 9 }, (_, index) => ({ id: `material-${index}`, name: `Material ${index}`, variants: Array.from({ length: 15 }, (_, micron) => ({ micron: micron + 1 })) })),
    ])
    expect(result.columns).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    expect(result.rows).toHaveLength(8); expect(result.omittedRows).toBe(4); expect(result.omittedColumns).toBe(3)
    expect(result.rows.slice(0, 3).every(row => row.values.every(value => value === null))).toBe(true)
  })
  it('does not invent a micron column when no complete valid native variants have been read', () => {
    expect(materialMicronMatrix([{ id: 'empty', variants: [] }, { id: 'missing' }]).columns).toEqual([])
  })
})

describe('pure operational timezone date bins', () => {
  it('splits recorded spans at Asia/Tashkent midnight rather than UTC midnight', () => {
    const midnight = Date.UTC(2026, 9, 13, 19) / 1000, asOf = midnight + 3600
    const result = retainedHistoryAnalytics([running('local-midnight', midnight - 300, midnight + 600, asOf)], 'all', asOf, { timeZone: 'Asia/Tashkent' })
    expect(result.timeZone).toBe('Asia/Tashkent')
    expect(result.bins.map(bin => bin.startUnix)).toEqual([midnight - 86400, midnight])
    expect(result.series.map(row => row.inProgress)).toEqual([300, 600])
    expect(result.bins[0].label).not.toBe(result.bins[1].label)
  })
  it('uses a 23-hour spring-forward date and a 25-hour fall-back date without losing elapsed seconds', () => {
    const cases = [
      { start: Date.UTC(2026, 2, 8, 5) / 1000, end: Date.UTC(2026, 2, 9, 4) / 1000, seconds: 23 * 3600 },
      { start: Date.UTC(2026, 10, 1, 4) / 1000, end: Date.UTC(2026, 10, 2, 5) / 1000, seconds: 25 * 3600 },
    ]
    for (const [index, entry] of cases.entries()) {
      const asOf = entry.end + 3600
      const result = retainedHistoryAnalytics([running(`dst-${index}`, entry.start, entry.end, asOf)], 'all', asOf, { timeZone: 'America/New_York' })
      expect(result.bins[0]).toMatchObject({ startUnix: entry.start, endUnix: entry.end })
      expect(result.bins[0].endUnix - result.bins[0].startUnix).toBe(entry.seconds)
      expect(result.series[0].inProgress).toBe(entry.seconds)
      expect(result.series[1].inProgress).toBeNull()
    }
  })
  it('preserves a real hour across repeated or skipped local clock times', () => {
    for (const [index, start] of [Date.UTC(2026, 10, 1, 5, 30) / 1000, Date.UTC(2026, 2, 8, 6, 30) / 1000].entries()) {
      const end = start + 3600, asOf = end + 3600
      const result = retainedHistoryAnalytics([running(`clock-${index}`, start, end, asOf)], 'all', asOf, { timeZone: 'America/New_York' })
      expect(result.series).toHaveLength(1); expect(result.series[0].inProgress).toBe(3600)
    }
  })
  it('handles fractional-hour offsets and a half-hour DST change without assuming midnight is an integer UTC hour', () => {
    const kathmandu = zonedHistoryDateBins(Date.UTC(2026, 9, 12, 18, 16) / 1000, Date.UTC(2026, 9, 13, 18, 16) / 1000, 'Asia/Kathmandu')
    expect(kathmandu[0].startUnix).toBe(Date.UTC(2026, 9, 12, 18, 15) / 1000)
    expect(kathmandu[0].endUnix).toBe(Date.UTC(2026, 9, 13, 18, 15) / 1000)
    const lordHowe = zonedHistoryDateBins(Date.UTC(2026, 9, 3, 14) / 1000, Date.UTC(2026, 9, 4, 14) / 1000, 'Australia/Lord_Howe')
    expect(lordHowe[0].startUnix).toBe(Date.UTC(2026, 9, 3, 13, 30) / 1000)
    expect(lordHowe[0].endUnix - lordHowe[0].startUnix).toBe(23.5 * 3600)
  })
  it('omits a skipped civil date instead of inventing a zero-length or zero-observed day', () => {
    const bins = zonedHistoryDateBins(Date.UTC(2011, 11, 29, 12) / 1000, Date.UTC(2011, 11, 30, 12) / 1000, 'Pacific/Apia')
    expect(bins).toHaveLength(2)
    expect(bins.map(bin => bin.startUnix)).toEqual([Date.UTC(2011, 11, 29, 10) / 1000, Date.UTC(2011, 11, 30, 10) / 1000])
    expect(bins.every(bin => bin.endUnix > bin.startUnix)).toBe(true)
  })
  it('keeps the retained trailing-window cutoff fixed at fetch as-of while date boundaries use the selected zone', () => {
    const asOf = Date.UTC(2026, 2, 9, 16) / 1000
    const result = retainedHistoryAnalytics([running('window', asOf - 8 * 86400, asOf - 6 * 86400, asOf)], '7d', asOf, { timeZone: 'America/New_York' })
    expect(result.asOfUnix).toBe(asOf); expect(result.timeZone).toBe('America/New_York')
    expect(result.series.reduce((sum, row) => sum + (row.inProgress ?? 0), 0)).toBe(86400)
    expect(result.bins.some(bin => bin.endUnix - bin.startUnix === 23 * 3600)).toBe(true)
  })
  it('rejects invalid zones and invalid date inputs without silently substituting UTC', () => {
    expect(historyTimeZone('not-a-timezone')).toBeNull()
    expect(zonedHistoryDateBins(observedAt, observedAt + 60, 'not-a-timezone')).toEqual([])
    expect(zonedHistoryDateBins(NaN, observedAt, 'Asia/Tashkent')).toEqual([])
    expect(zonedHistoryDateBins(observedAt, observedAt - 1, 'Asia/Tashkent')).toEqual([])
    const result = retainedHistoryAnalytics([running('known', observedAt - 600, observedAt - 300)], 'all', observedAt, { timeZone: 'not-a-timezone' })
    expect(result).toMatchObject({ timeZone: null, bins: [], series: [], observedIntervalCount: 1 })
  })
  it('limits long date ranges to sixteen local calendar bins and includes years when the range crosses years', () => {
    const start = Date.UTC(2025, 11, 30, 12) / 1000, end = Date.UTC(2026, 3, 30, 12) / 1000
    const bins = zonedHistoryDateBins(start, end, 'Asia/Tashkent')
    expect(bins.length).toBeLessThanOrEqual(16)
    expect(bins[0].label).toContain('2025'); expect(bins.at(-1)!.label).toContain('2026')
    expect(bins[0].startUnix).toBe(Date.UTC(2025, 11, 29, 19) / 1000)
  })
})
