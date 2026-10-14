import { describe, expect, it } from 'vitest'
import type { WorkerGroup } from './worker-groups'
import { workerGroupOverviewSummary } from './worker-group-analytics'

function group(patch: Partial<WorkerGroup> = {}): WorkerGroup {
  return { apparatus_id: 'apparatus:qa:print', apparatus: 'Bosma', group_code: 'A', shift: 'kunduz', start_time: '08:00', end_time: '20:00', work_days_per_week: 6, start_day: 'monday', accounting_enabled: false, worker_ids: [], workers: [], ...patch }
}

describe('facts from the full native worker-group directory', () => {
  it('counts each recorded worker ID once without relying on hydrated workers or picker catalogs', () => {
    const summary = workerGroupOverviewSummary([
      group({ accounting_enabled: true, worker_ids: ['qa-worker-1', 'qa-worker-2'], workers: [{ id: 'qa-worker-1', name: 'A', phone: '', level: 'Master' }] }),
      group({ group_code: 'B', worker_ids: ['QA-WORKER-1', 'qa-worker-3', 'qa-worker-3'] }),
      group({ apparatus_id: 'apparatus:qa:cut', apparatus: 'Kesish', group_code: 'C' }),
    ])
    expect(summary).toMatchObject({ state: 'ready', groupCount: 3, recordedMemberCount: 3, accountingEnabledCount: 1, emptyGroupCount: 1 })
    expect(summary.apparatus).toEqual([{ id: 'apparatus:qa:print', label: 'Bosma', groupCount: 2 }, { id: 'apparatus:qa:cut', label: 'Kesish', groupCount: 1 }])
  })

  it('establishes exact zeros only for an available empty directory', () => {
    expect(workerGroupOverviewSummary([])).toEqual({ state: 'ready', groupCount: 0, recordedMemberCount: 0, accountingEnabledCount: 0, emptyGroupCount: 0, apparatus: [] })
    expect(workerGroupOverviewSummary([group()], false)).toEqual({ state: 'unavailable', groupCount: null, recordedMemberCount: null, accountingEnabledCount: null, emptyGroupCount: null, apparatus: [] })
  })

  it('keeps apparatus with the same display name separate by canonical ID', () => {
    const summary = workerGroupOverviewSummary([group(), group({ apparatus_id: 'apparatus:qa:print-2' })])
    expect(summary.apparatus).toEqual([
      { id: 'apparatus:qa:print', label: 'Bosma · apparatus:qa:print', groupCount: 1 },
      { id: 'apparatus:qa:print-2', label: 'Bosma · apparatus:qa:print-2', groupCount: 1 },
    ])
    const conflicting = workerGroupOverviewSummary([group(), group({ group_code: 'B', apparatus: 'Old name' })])
    expect(conflicting.apparatus).toEqual([{ id: 'apparatus:qa:print', label: 'apparatus:qa:print', groupCount: 2 }])
    expect(workerGroupOverviewSummary([group({ apparatus: '' })]).apparatus[0].label).toBe('apparatus:qa:print')
  })

  it.each([undefined, null, [''], [' worker'], [2], Array(1)])('does not turn malformed memberships %j into a zero or an empty group', worker_ids => {
    const summary = workerGroupOverviewSummary([group({ accounting_enabled: true }), { ...group({ group_code: 'B' }), worker_ids } as unknown as WorkerGroup])
    expect(summary).toMatchObject({ state: 'incomplete', groupCount: 2, recordedMemberCount: null, emptyGroupCount: null, accountingEnabledCount: 1 })
    expect(summary.apparatus[0].groupCount).toBe(2)
  })

  it('preserves known membership facts when accounting state is missing or malformed', () => {
    const summary = workerGroupOverviewSummary([{ ...group({ worker_ids: ['worker-id'] }), accounting_enabled: 'true' } as unknown as WorkerGroup])
    expect(summary).toMatchObject({ state: 'incomplete', groupCount: 1, recordedMemberCount: 1, accountingEnabledCount: null, emptyGroupCount: 0 })
  })

  it.each([
    [null],
    [group({ apparatus_id: 'legacy-name' })],
    [group({ group_code: '' })],
    [group({ group_code: 'lowercase' })],
    [group({ group_code: 'A  B' })],
    [group({ group_code: '-' })],
    [group(), group()],
    Array(1),
    undefined,
  ])('leaves malformed or duplicate group identities unknown: %j', input => {
    expect(workerGroupOverviewSummary(input as unknown as WorkerGroup[])).toEqual({ state: 'invalid', groupCount: null, recordedMemberCount: null, accountingEnabledCount: null, emptyGroupCount: null, apparatus: [] })
  })

  it('does not sort or mutate the supplied native rows or membership arrays', () => {
    const input = [group({ group_code: 'B', worker_ids: ['b', 'a'] }), group({ apparatus_id: 'apparatus:qa:cut', apparatus: 'Kesish' })]
    const original = structuredClone(input)
    workerGroupOverviewSummary(input)
    expect(input).toEqual(original)
  })
})
