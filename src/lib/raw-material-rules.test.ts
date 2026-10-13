import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, record } from './api'
import type { Row, Session } from './api-types'
import {
  MaterialRuleDraftRegistry, materialRuleCommand, materialRuleDraft, parseMaterialRulePolicy,
  parseMaterialRuleProjection, parseMaterialRuleReceipt, rawMaterialGroupOptions,
  rawMaterialRuleGroups, rawMaterialRulePermissions, rawMaterialRules, rawMaterialRuleSnapshot,
  reconcileMaterialRuleCommand, saveMaterialRuleCommand,
} from './raw-material-rules'
import type { MaterialRuleCommand, MaterialRulePolicy, MaterialRuleSnapshot } from './raw-material-rules'

const base = '/v1/mobile/admin', path = `${base}/raw-material-rules`
const id = 'apparatus:default:printer-1', otherId = 'apparatus:default:laminator-1'
const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-rule-test' })
const actor = (capabilities = ['raw_material.rule.manage', 'admin.access', 'catalog.item_group.read'], role = 'admin'): Session => ({ token: 'local-rule-test', profile: { role, ref: 'fixture-admin', display_name: 'Fixture actor' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
function snapshot(policy: MaterialRulePolicy = { mode: 'all_required', item_group_ids: ['PET'] }, revision = 3, apparatusId = id): MaterialRuleSnapshot {
  const hash = String(revision).repeat(64), operation = apparatusId === id ? 'print' : 'laminate'
  const rule = { apparatus_id: apparatusId, source_revision: revision, source_aasx_sha256: hash, policy, tooling: { mode: 'qolip_scan_required' as const, tooling_class_id: 'tooling:print' } }
  const apparatus = {
    apparatus_id: apparatusId, source_revision: revision, source_aasx_sha256: hash,
    display: { display_name: 'Native apparatus', description: 'Keep this exact description', catalog_order: 12 },
    equipment_class_id: 'equipment:class', physical_asset_id: 'physical:asset',
    hierarchy: { enterprise_id: 'enterprise:factory', site_id: 'site:main', area_id: 'area:production', work_center_id: 'center:print', work_unit_id: 'unit:1' },
    capabilities: { [operation]: 2, tooling: 1 },
    execution_profile: { operation, technology: operation === 'print' ? 'rotogravure' : 'adhesive_lamination', color_station_count: operation === 'print' ? 7 : null, virtual_tasks: 'disabled', capability_compatible_reroute: true },
    placement: { factory_map_object_id: 'printing_machine_01' }, training: { enabled: false, queue_enabled: false, material_tracking_enabled: false }, lifecycle: { state: 'active', retirement_reason: null },
  }
  return { rule, apparatus, name: 'Native apparatus', operation, active: true }
}
const catalog = ['PET', 'PE', 'INK'].map(name => ({ name, item_group_name: name, parent_item_group: 'Homashyo' }))
const changed = (current = snapshot(), session = actor(), key = 'web-material-policy:test-key') => materialRuleCommand(current, { mode: 'all_required', groupIds: ['PET', 'PE'], sets: [] }, session, ['INK', 'PE', 'PET'], key)
function receipt(command: MaterialRuleCommand, current = snapshot(command.body.material, command.body.expected_revision + 1, command.body.apparatus_id)): Row {
  const { source_revision: revision, source_aasx_sha256: hash, ...profile } = current.apparatus
  return {
    revision: { ...profile, schema_version: 1, capabilities: Object.entries(record(profile.capabilities)).map(([code, level]) => ({ code, level })),
      policies: { queue: 'free_pick', material: command.body.material, tooling: command.body.tooling },
      capacity: { capacity_slots: 2, setup_minutes: 12, cleanup_minutes: 7, efficiency_percent: 90, finite_capacity: true, availability: { mode: 'always' } },
      revision_metadata: { revision, committed_at_unix_ms: 1791885600000, command_id: `apparatus-command:${command.key}`, actor_id: 'principal:fixture-admin', source: 'admin', source_reference: null },
    }, runtime_projection: current.apparatus, aasx_sha256: hash,
  }
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
interface FixtureOptions {
  current?: MaterialRuleSnapshot; catalog?: Row[]; readStatus?: number; writeStatus?: number
  writeResponse?: (value: Row) => unknown; loseFirst?: boolean; skipCommit?: boolean
  beforeWrite?: (current: MaterialRuleSnapshot) => MaterialRuleSnapshot
}
/** Native per-apparatus CAS fixture: no replay cache and no whole-collection replacement. */
function server(options: FixtureOptions = {}) {
  let current = structuredClone(options.current ?? snapshot()), writes = 0, readsDenied = false
  const other = snapshot({ mode: 'not_required' }, 5, otherId)
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)), get = init.method === 'GET'
    if (get && (readsDenied || options.readStatus)) return response({ error: 'forbidden' }, options.readStatus ?? 403)
    if (get && url.pathname === path) return response([current.rule, other.rule])
    if (get && url.pathname === `${base}/apparatus/${encodeURIComponent(id)}`) return response(current.apparatus)
    if (get && url.pathname === `${base}/item-groups/tree`) return response(options.catalog ?? catalog)
    if (get || url.pathname !== path || init.method !== 'PUT') throw new Error(`Unexpected local request ${init.method} ${url.pathname}`)
    writes++
    if (options.writeStatus) return response({ error: options.writeStatus === 409 ? 'apparatus_revision_conflict' : 'local_native_refusal' }, options.writeStatus)
    const body = JSON.parse(String(init.body)) as MaterialRuleCommand['body']
    if (options.beforeWrite) current = options.beforeWrite(current)
    if (body.expected_revision !== current.rule.source_revision) return response({ error: 'apparatus_revision_conflict' }, 409)
    const key = new Headers(init.headers).get('Idempotency-Key')!
    const command: MaterialRuleCommand = { key, body, baseline: structuredClone(current) }
    const next = snapshot(body.material, current.rule.source_revision + 1)
    next.rule.tooling = structuredClone(body.tooling) as typeof next.rule.tooling
    next.apparatus = { ...current.apparatus, source_revision: next.rule.source_revision, source_aasx_sha256: next.rule.source_aasx_sha256 }
    const saved = receipt(command, next)
    if (!options.skipCommit) current = next
    if (options.loseFirst && writes === 1) throw new TypeError('Local response lost after commit')
    return response(options.writeResponse ? options.writeResponse(saved) : saved)
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, current: () => structuredClone(current), other: () => structuredClone(other), denyReads: () => { readsDenied = true }, writes: () => writes }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native rule read, scope and material contract', () => {
  it('requires the strict rule capability independently of role, apparatus and group reads', () => {
    expect(rawMaterialRulePermissions(actor(['admin.access', 'production.map.manage']))).toEqual({ manage: false, apparatus: true, groups: false })
    expect(rawMaterialRulePermissions(actor(['raw_material.rule.manage'], 'worker'))).toEqual({ manage: true, apparatus: false, groups: false })
    expect(rawMaterialRulePermissions(actor(['raw_material.rule.manage', 'raw_material.assign', 'gscale.catalog.read']))).toEqual({ manage: true, apparatus: true, groups: true })
    expect(rawMaterialRulePermissions(null)).toEqual({ manage: false, apparatus: false, groups: false })
    expect(() => changed(snapshot(), actor(['admin.access']))).toThrow()
  })

  it('reads the canonical material projection and matches the exact runtime revision', async () => {
    const local = server()
    expect(await rawMaterialRules(client)).toHaveLength(2)
    expect(await rawMaterialRuleSnapshot(client, id)).toEqual(snapshot())
    expect(local.fetch.mock.calls.every(([url, init]) => String(url).startsWith('http://127.0.0.1:5199/') && init.method === 'GET')).toBe(true)
    const mismatch = snapshot(); mismatch.apparatus.source_revision = 4
    server({ current: mismatch })
    await expect(rawMaterialRuleSnapshot(client, id)).rejects.toMatchObject({ code: 'invalid_response' })
    server(); await expect(rawMaterialRuleSnapshot(client, otherId)).rejects.toThrow()
  })

  it('rejects legacy, duplicate or malformed success envelopes instead of treating them as rules', async () => {
    for (const value of [[], { ok: true }, [{ apparatus: 'Printer', allowed_item_groups: ['PET'] }], [snapshot().rule, snapshot().rule]]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(value)))
      if (Array.isArray(value) && !value.length) expect(await rawMaterialRules(client)).toEqual([])
      else await expect(rawMaterialRules(client)).rejects.toMatchObject({ code: 'invalid_response' })
    }
    for (const invalid of [{ ...snapshot().rule, apparatus_id: ` ${id}` }, { ...snapshot().rule, source_revision: '3' }, { ...snapshot().rule, source_aasx_sha256: 'invalid' }]) expect(() => parseMaterialRuleProjection(invalid)).toThrow()
  })

  it('requires native operation, technology, capability, color and width compatibility before exposing writes', async () => {
    for (const update of [
      { execution_profile: { ...record(snapshot().apparatus.execution_profile), technology: 'slitting' } },
      { execution_profile: { ...record(snapshot().apparatus.execution_profile), color_station_count: 0 } },
      { execution_profile: { ...record(snapshot().apparatus.execution_profile), min_web_width_mm: 1200, max_web_width_mm: 200 } },
      { execution_profile: { ...record(snapshot().apparatus.execution_profile), virtual_tasks: 'input_bridge' } },
      { capabilities: { print: 0, tooling: 1 } }, { capabilities: { print: 1 } },
    ]) {
      const current = snapshot(); current.apparatus = { ...current.apparatus, ...update }
      const local = server({ current })
      await expect(rawMaterialRuleSnapshot(client, id)).rejects.toMatchObject({ code: 'invalid_response' })
      await expect(saveMaterialRuleCommand(client, actor(), changed())).rejects.toMatchObject({ uncertain: false })
      expect(local.writes()).toBe(0)
    }
  })

  it('uses only actual direct Homashyo group references and fails malformed references at the query boundary', async () => {
    const groups = [...catalog, { name: 'Finished', parent_item_group: 'Tayyor mahsulot' }, { name: 'Nested', parent_item_group: 'PET' }, { name: 'Ignored title', item_group_name: 'Canonical', parent_item_group: ' HOMASHYO ' }]
    expect(rawMaterialGroupOptions(groups)).toEqual(['Canonical', 'INK', 'PE', 'PET'])
    server({ catalog: [{ name: '', parent_item_group: 'Homashyo' }] })
    await expect(rawMaterialRuleGroups(client)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('supports native optional, all-required and set policies without inventing operation restrictions', () => {
    const current = snapshot()
    expect(materialRuleCommand(current, { mode: 'not_required', groupIds: [], sets: [] }, actor()).body.material).toEqual({ mode: 'not_required' })
    expect(materialRuleCommand(current, { mode: 'not_required', groupIds: ['PET'], sets: [] }, actor()).body.material).toEqual({ mode: 'not_required', item_group_ids: ['PET'] })
    const sets = { mode: 'requirement_sets' as const, groupIds: [], sets: [{ id: 'lining', groupIds: ['PET', 'PE'], minimum: '2' }, { id: 'ink', groupIds: ['INK'], minimum: '1' }] }
    expect(materialRuleCommand(current, sets, actor(), ['PE', 'PET', 'INK']).body.material).toEqual({ mode: 'requirement_sets', sets: [{ requirement_id: 'ink', item_group_ids: ['INK'], minimum_required_count: 1 }, { requirement_id: 'lining', item_group_ids: ['PE', 'PET'], minimum_required_count: 2 }] })
    expect(materialRuleCommand(snapshot(undefined, 5, otherId), { mode: 'not_required', groupIds: [], sets: [] }, actor()).body.apparatus_id).toBe(otherId)
  })

  it('enforces native sorted references, set uniqueness, u16 counts and Unicode character limits', () => {
    expect(parseMaterialRulePolicy({ mode: 'all_required', item_group_ids: ['😀'.repeat(256)] })).toMatchObject({ mode: 'all_required' })
    const invalid = [
      { mode: 'all_required', item_group_ids: [] }, { mode: 'all_required', item_group_ids: ['PET', 'PE'] }, { mode: 'not_required', item_group_ids: ['PET', 'PET'] },
      { mode: 'all_required', item_group_ids: ['😀'.repeat(257)] }, { mode: 'all_required', item_group_ids: ['P\nET'] }, { mode: 'not_required', unknown: true },
      { mode: 'requirement_sets', sets: [] }, { mode: 'requirement_sets', sets: [{ requirement_id: 'set', item_group_ids: ['PET'], minimum_required_count: 2 }] },
      { mode: 'requirement_sets', sets: [{ requirement_id: 'set', item_group_ids: ['PET'], minimum_required_count: 0 }] }, { mode: 'requirement_sets', sets: [{ requirement_id: 'set', item_group_ids: ['PET'], minimum_required_count: 1.5 }] },
      { mode: 'requirement_sets', sets: [{ requirement_id: 'set', item_group_ids: ['PET'], minimum_required_count: 1 }, { requirement_id: 'set', item_group_ids: ['PET'], minimum_required_count: 1 }] },
    ]
    invalid.forEach(policy => expect(() => parseMaterialRulePolicy(policy)).toThrow())
    expect(() => materialRuleCommand(snapshot(), { mode: 'requirement_sets', groupIds: [], sets: [{ id: '', groupIds: ['PET'], minimum: '1' }] }, actor())).toThrow('Har bir talabga')
  })

  it('preserves saved orphan groups and tooling while denying made-up new groups, retired edits and no-ops', () => {
    const orphan = snapshot({ mode: 'all_required', item_group_ids: ['Renamed group'] })
    expect(materialRuleCommand(orphan, { mode: 'not_required', groupIds: ['Renamed group'], sets: [] }, actor(['raw_material.rule.manage'])).body.tooling).toEqual(orphan.rule.tooling)
    expect(() => materialRuleCommand(snapshot(), { mode: 'all_required', groupIds: ['Invented'], sets: [] }, actor(), ['PET'])).toThrow('Homashyo')
    expect(() => materialRuleCommand(snapshot(), materialRuleDraft(snapshot().rule), actor())).toThrow('o‘zgarish')
    expect(() => changed({ ...snapshot(), active: false })).toThrow('Foydalanishdan')
    expect(() => changed(snapshot(), actor(), 'bad key')).toThrow('identifikatori')
  })
})

describe('single native CAS patch and truthful write receipts', () => {
  it('sends exactly one apparatus patch and native key, preserving other apparatus and canonical fields', async () => {
    const local = server(), command = changed(), other = local.other()
    const result = await saveMaterialRuleCommand(client, actor(), command)
    const write = local.fetch.mock.calls.find(([, init]) => init.method === 'PUT')!
    expect(JSON.parse(String(write[1].body))).toEqual(command.body)
    expect(Object.keys(JSON.parse(String(write[1].body))).sort()).toEqual(['apparatus_id', 'expected_revision', 'material', 'tooling'])
    expect(new Headers(write[1].headers).get('Idempotency-Key')).toBe(command.key)
    expect(write[1].credentials).toBe('omit')
    expect(local.writes()).toBe(1)
    expect(result.rule).toMatchObject({ source_revision: 4, policy: command.body.material, tooling: snapshot().rule.tooling })
    expect(result.snapshot.apparatus.display).toEqual(snapshot().apparatus.display)
    expect(local.other()).toEqual(other)
    expect(result.observed).toBe(false)
  })

  it('prevents dispatch after a stale revision, missing selected group or retired configuration', async () => {
    const command = changed()
    for (const options of [{ current: snapshot(undefined, 4) }, { catalog: [catalog[0]] }, { current: { ...snapshot(), active: false, apparatus: { ...snapshot().apparatus, lifecycle: { state: 'retired', retirement_reason: 'Native retirement' } } } }]) {
      const local = server(options)
      await expect(saveMaterialRuleCommand(client, actor(), command)).rejects.toMatchObject({ uncertain: false })
      expect(local.writes()).toBe(0)
    }
    const local = server({ catalog: [{ parent_item_group: 'Homashyo', name: '' }] })
    await expect(saveMaterialRuleCommand(client, actor(), command)).rejects.toMatchObject({ uncertain: false })
    expect(local.writes()).toBe(0)
  })

  it('preserves deterministic native 400/403/409 refusals and detects the actual CAS race', async () => {
    for (const writeStatus of [400, 403, 409]) {
      const local = server({ writeStatus })
      await expect(saveMaterialRuleCommand(client, actor(), changed())).rejects.toMatchObject({ uncertain: false })
      expect(local.current().rule.source_revision).toBe(3)
    }
    const race = server({ beforeWrite: () => snapshot({ mode: 'not_required' }, 4) })
    await expect(saveMaterialRuleCommand(client, actor(), changed())).rejects.toMatchObject({ uncertain: false })
    expect(race.current().rule.policy).toEqual({ mode: 'not_required' })
    expect(race.writes()).toBe(1)
  })

  it('refuses unrelated or partial HTTP200 receipts even when the request might have committed', async () => {
    const corruptions: ((receipt: Row) => unknown)[] = [
      () => ({ ok: true }), value => ({ ...value, revision: { ...record(value.revision), apparatus_id: otherId } }),
      value => ({ ...value, aasx_sha256: snapshot().rule.source_aasx_sha256 }),
      value => ({ ...value, runtime_projection: { ...record(value.runtime_projection), display: { display_name: 'Changed by someone else' } } }),
      value => ({ ...value, revision: { ...record(value.revision), display: { display_name: 'Contradictory canonical profile' } } }),
      ...['command_id', 'actor_id', 'revision', 'source', 'committed_at_unix_ms'].map(field => (value: Row) => ({ ...value, revision: { ...record(value.revision), revision_metadata: { ...record(record(value.revision).revision_metadata), [field]: field === 'revision' ? 7 : field === 'committed_at_unix_ms' ? 0 : 'wrong' } } })),
      value => ({ ...value, revision: { ...record(value.revision), policies: { ...record(record(value.revision).policies), material: { mode: 'not_required' } } } }),
      value => ({ ...value, revision: { ...record(value.revision), policies: { ...record(record(value.revision).policies), tooling: { mode: 'not_required' } } } }),
    ]
    for (const writeResponse of corruptions) {
      const local = server({ writeResponse })
      await expect(saveMaterialRuleCommand(client, actor(), changed())).rejects.toMatchObject({ uncertain: true })
      expect(local.writes()).toBe(1)
    }
    expect(() => parseMaterialRuleReceipt(receipt(changed()), changed(), { ...actor(), profile: { ...actor().profile, ref: 'different-actor' } })).toThrow()
  })

  it('marks dispatched transport/server failures uncertain, but aborted preflight never writes', async () => {
    server({ writeStatus: 503 })
    await expect(saveMaterialRuleCommand(client, actor(), changed())).rejects.toMatchObject({ uncertain: true })
    const local = server(), controller = new AbortController(); controller.abort()
    await expect(saveMaterialRuleCommand(client, actor(), changed(), controller.signal)).rejects.toMatchObject({ uncertain: false })
    expect(local.writes()).toBe(0)
  })

  it('recovers lost response by observing a newer matching policy without replaying or claiming attribution', async () => {
    const local = server({ loseFirst: true }), command = changed()
    await expect(saveMaterialRuleCommand(client, actor(), command)).rejects.toMatchObject({ uncertain: true })
    const observed = await reconcileMaterialRuleCommand(client, command)
    expect(observed.state).toBe('confirmed')
    expect(observed.current.rule.source_revision).toBe(4)
    expect(local.writes()).toBe(1)
    await expect(saveMaterialRuleCommand(client, actor(), command)).rejects.toMatchObject({ uncertain: false })
    expect(local.writes()).toBe(1)
  })

  it('does not call unchanged readback proof of absence and distinguishes superseding policies', async () => {
    const command = changed(), local = server({ skipCommit: true, writeResponse: () => ({ ok: true }) })
    await expect(saveMaterialRuleCommand(client, actor(), command)).rejects.toMatchObject({ uncertain: true })
    expect((await reconcileMaterialRuleCommand(client, command)).state).toBe('unchanged')
    expect(local.writes()).toBe(1)
    server({ current: snapshot({ mode: 'not_required' }, 4) })
    expect((await reconcileMaterialRuleCommand(client, command)).state).toBe('superseded')
    const denied = server(); denied.denyReads()
    await expect(reconcileMaterialRuleCommand(client, command)).rejects.toMatchObject({ status: 403 })
  })
})

describe('RAM draft and interrupted request ownership', () => {
  function registry() { const retained = new MaterialRuleDraftRegistry(); retained.activate('scope-A'); retained.select('scope-A', snapshot()); retained.edit('scope-A', materialRuleDraft({ ...snapshot().rule, policy: changed().body.material })); return retained }

  it('retains edited drafts across selection/read refresh but changes baseline only on explicit rebase', () => {
    const retained = registry(), draft = retained.get('scope-A')!.draft
    retained.select('scope-A', snapshot(undefined, 4))
    expect(retained.get('scope-A')!.snapshot.rule.source_revision).toBe(3)
    expect(retained.get('scope-A')!.draft).toEqual(draft)
    retained.select('scope-A', snapshot(undefined, 5, otherId)); retained.choose('scope-A', id)
    expect(retained.get('scope-A')!.draft).toEqual(draft)
    retained.rebase('scope-A', snapshot({ mode: 'not_required' }, 4))
    expect(retained.get('scope-A')!.draft.mode).toBe('not_required')
  })

  it('keeps a dispatched frozen request across close/unmount and rejects new or changed-body recovery', () => {
    const retained = registry(), command = changed(), lease = retained.begin('scope-A', command)
    retained.dispatched(lease); retained.interrupt(lease)
    const entry = retained.get('scope-A')!
    expect(entry).toMatchObject({ phase: 'uncertain', command })
    expect(() => retained.choose('scope-A', otherId)).toThrow()
    expect(() => retained.rebase('scope-A', snapshot(undefined, 4))).toThrow()
    expect(() => retained.begin('scope-A', changed(snapshot(), actor(), 'new-key'))).toThrow()
    expect(() => retained.begin('scope-A', { ...command, key: 'different-key' }, true)).toThrow()
    expect(() => retained.begin('scope-A', { ...command, body: { ...command.body, tooling: { mode: 'not_required' } } }, true)).toThrow()
    retained.finish(lease, { result: parseMaterialRuleReceipt(receipt(command), command, actor()) })
    expect(retained.get('scope-A')!.phase).toBe('uncertain')
    entry.command!.body.material = { mode: 'not_required' }
    expect(retained.get('scope-A')!.command!.body.material).toEqual(command.body.material)
  })

  it('preserves uncertainty when recovery is denied, interrupted before dispatch or sees the old revision', () => {
    const retained = registry(), command = changed(), original = retained.begin('scope-A', command)
    retained.dispatched(original); retained.interrupt(original)
    const read = retained.begin('scope-A', command, true)
    retained.finish(read, { error: '403 native read denied', uncertain: false })
    expect(retained.get('scope-A')!.phase).toBe('uncertain')
    const interruptedRead = retained.begin('scope-A', command, true)
    retained.interrupt(interruptedRead)
    expect(retained.get('scope-A')!.phase).toBe('uncertain')
    const unchanged = retained.begin('scope-A', command, true)
    retained.finish(unchanged, { error: 'Same revision is not absence proof', uncertain: true })
    expect(retained.get('scope-A')!.command).toEqual(command)
  })

  it('clears a pre-dispatch interruption and rejects overlapping or stale baseline attempts', () => {
    const retained = registry(), command = changed(), lease = retained.begin('scope-A', command)
    expect(() => retained.begin('scope-A', command)).toThrow()
    retained.interrupt(lease)
    expect(retained.get('scope-A')!.phase).toBe('editing')
    expect(() => retained.begin('scope-A', changed(snapshot(undefined, 4)))).toThrow()
    const next = retained.begin('scope-A', command)
    retained.dispatched(next); retained.finish(next, { error: 'Native deterministic rejection', uncertain: false })
    const beforeSend = retained.begin('scope-A', command)
    retained.interrupt(beforeSend)
    expect(retained.get('scope-A')!.phase).toBe('editing')
  })

  it('requires explicit current reload after success or supersession and ignores retired auth generations', () => {
    const retained = registry(), command = changed(), lease = retained.begin('scope-A', command)
    retained.finish(lease, { result: parseMaterialRuleReceipt(receipt(command), command, actor()) })
    expect(() => retained.begin('scope-A', command)).toThrow()
    retained.finish(lease, { error: 'A failed UI refresh after the receipt cannot undo acknowledgement', uncertain: true })
    expect(retained.get('scope-A')!.phase).toBe('confirmed')
    retained.rebase('scope-A', snapshot(command.body.material, 4))
    const next = materialRuleCommand(snapshot(command.body.material, 4), { mode: 'not_required', groupIds: [], sets: [] }, actor())
    const superseded = retained.begin('scope-A', next)
    retained.dispatched(superseded); retained.finish(superseded, { superseded: snapshot({ mode: 'all_required', item_group_ids: ['INK'] }, 5) })
    expect(retained.get('scope-A')!.phase).toBe('conflict')
    expect(() => retained.edit('scope-A', materialRuleDraft(snapshot().rule))).toThrow()
    expect(() => retained.begin('scope-A', next)).toThrow()
    retained.activate('scope-B'); expect(retained.get('scope-A')).toBeNull()
    retained.activate('scope-A'); retained.select('scope-A', snapshot())
    retained.finish(superseded, { error: 'Late old-session completion', uncertain: true })
    expect(retained.get('scope-A')!.phase).toBe('editing')
    expect(JSON.stringify(retained.get('scope-A'))).not.toContain('local-rule-test')
  })
})
