import { isIdentityApparatusId } from './admin-identity'
import { normalizeWorkerGroupCode, workerGroupIdentity } from './worker-groups'
import type { WorkerGroup } from './worker-groups'

export interface WorkerGroupApparatusCount {
  id: string
  label: string
  groupCount: number
}

export interface WorkerGroupOverviewSummary {
  state: 'ready' | 'incomplete' | 'invalid' | 'unavailable'
  groupCount: number | null
  recordedMemberCount: number | null
  accountingEnabledCount: number | null
  emptyGroupCount: number | null
  apparatus: WorkerGroupApparatusCount[]
}

function unknown(state: 'invalid' | 'unavailable'): WorkerGroupOverviewSummary {
  return { state, groupCount: null, recordedMemberCount: null, accountingEnabledCount: null, emptyGroupCount: null, apparatus: [] }
}

/** Full native group GET facts, before local search. No worker/apparatus picker catalog is used. */
export function workerGroupOverviewSummary(groups: readonly WorkerGroup[], available = true): WorkerGroupOverviewSummary {
  if (!available) return unknown('unavailable')
  if (!Array.isArray(groups)) return unknown('invalid')

  const identities = new Set<string>()
  for (const group of groups) {
    if (!group || typeof group !== 'object' || typeof group.apparatus_id !== 'string' || !isIdentityApparatusId(group.apparatus_id)
      || typeof group.group_code !== 'string' || !group.group_code || group.group_code !== group.group_code.trim()) return unknown('invalid')
    try { if (normalizeWorkerGroupCode(group.group_code) !== group.group_code) return unknown('invalid') } catch { return unknown('invalid') }
    const identity = workerGroupIdentity(group)
    if (identities.has(identity)) return unknown('invalid')
    identities.add(identity)
  }

  const members = new Set<string>()
  const buckets = new Map<string, { count: number; names: Set<string>; unnamed: boolean }>()
  let membershipsKnown = true, accountingKnown = true, accountingEnabledCount = 0, emptyGroupCount = 0
  for (const group of groups) {
    // worker_ids is authoritative. Hydrated worker details may be absent for a recorded ID.
    if (!Array.isArray(group.worker_ids)) membershipsKnown = false
    else {
      if (!group.worker_ids.length) emptyGroupCount += 1
      for (const id of group.worker_ids) {
        if (typeof id !== 'string' || !id || id !== id.trim()) membershipsKnown = false
        else members.add(id.toLowerCase())
      }
    }
    if (typeof group.accounting_enabled !== 'boolean') accountingKnown = false
    else if (group.accounting_enabled) accountingEnabledCount += 1

    const bucket = buckets.get(group.apparatus_id) ?? { count: 0, names: new Set<string>(), unnamed: false }
    bucket.count += 1
    if (typeof group.apparatus === 'string' && group.apparatus && group.apparatus === group.apparatus.trim()) bucket.names.add(group.apparatus)
    else bucket.unnamed = true
    buckets.set(group.apparatus_id, bucket)
  }

  const apparatus = [...buckets].map(([id, bucket]) => ({ id, label: !bucket.unnamed && bucket.names.size === 1 ? [...bucket.names][0] : id, groupCount: bucket.count }))
  const labels = new Map<string, number>()
  for (const item of apparatus) labels.set(item.label, (labels.get(item.label) ?? 0) + 1)
  for (const item of apparatus) if ((labels.get(item.label) ?? 0) > 1) item.label = `${item.label} · ${item.id}`
  apparatus.sort((left, right) => right.groupCount - left.groupCount || left.id.localeCompare(right.id))

  return {
    state: membershipsKnown && accountingKnown ? 'ready' : 'incomplete',
    groupCount: groups.length,
    recordedMemberCount: membershipsKnown ? members.size : null,
    accountingEnabledCount: accountingKnown ? accountingEnabledCount : null,
    emptyGroupCount: membershipsKnown ? emptyGroupCount : null,
    apparatus,
  }
}
