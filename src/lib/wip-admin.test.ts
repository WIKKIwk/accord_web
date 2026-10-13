import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import type { ProductionSnapshot, Row, Session } from './api-types'
import {
  WIP_API_LIMITATIONS, OpeningWipAttemptRegistry, cancelOpeningWip, createOpeningWip, openingWipCancelIssue, openingWipCreateCommand,
  openingWipDestinations, openingWipIntakePreview, openingWipMatchesCommand, openingWipOrderIssue, openingWipRecords,
  openingWipSources, parseOpeningWipRecord, reconcileOpeningWipCancel, reconcileOpeningWipCreate, wipBatchDetail,
  wipPermissions, wipRoutePreview,
} from './wip-admin'
import type { OpeningWipCommand, OpeningWipDetail, OpeningWipRecord, OpeningWipRollDraft } from './wip-admin'

const orderId = 'zakaz-wip-1', print = 'apparatus:test:print-1', laminate = 'apparatus:test:laminate-1', cut = 'apparatus:test:cut-1'
const client = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-wip-fixture' })
const session = (capabilities = ['admin.access', 'production.map.manage'], role = 'admin'): Session => ({ token: 'fixture', profile: { role, display_name: 'Local fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] })
const catalog = [
  { apparatus_id: print, source_revision: 1, display: { display_name: 'Printer' }, lifecycle: { state: 'active' }, execution_profile: { operation: 'print' } },
  { apparatus_id: laminate, source_revision: 1, display: { display_name: 'Laminator' }, lifecycle: { state: 'active' }, execution_profile: { operation: 'laminate' } },
  { apparatus_id: cut, source_revision: 1, display: { display_name: 'Cutter' }, lifecycle: { state: 'active' }, execution_profile: { operation: 'cut' } },
]
const map: Row = {
  id: orderId, title: 'Local WIP order', product_code: 'PET',
  nodes: [{ id: 'start', kind: 'start' }, { id: 'print', kind: 'apparatus', apparatus_id: print, title: 'Printer' }, { id: 'laminate', kind: 'apparatus', apparatus_id: laminate, title: 'Laminator' }, { id: 'cut', kind: 'apparatus', apparatus_id: cut, title: 'Cutter' }, { id: 'end', kind: 'end' }],
  edges: [{ from: 'start', to: 'print' }, { from: 'print', to: 'laminate' }, { from: 'laminate', to: 'cut' }, { from: 'cut', to: 'end' }],
}
function snapshot(nextMap = map): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'local-epoch', scope: 'all', maps: [{ map: structuredClone(nextMap), program: { map_id: orderId, operations: [] } }], order_statuses: { [orderId]: { lifecycle_status: 'released', order_status: 'not_started' } }, order_customers: {}, sequences: {}, queue_states: {}, stage_states: { [orderId]: { print: 'pending', laminate: 'pending', cut: 'pending' } }, queue_action_controls: {}, order_controls: {} }
}
const roll: OpeningWipRollDraft = { basis: 'measured', metres: '100,5', kg: '25.5', bobinaKg: '1.5', diameter: '' }
const command = (current = snapshot(), source = 'print', rolls = [roll], currentCatalog = catalog) => openingWipCreateCommand(current, currentCatalog, session(), orderId, source, rolls, 'Local fixture', 'retained-key-1')
function recordFor(request: OpeningWipCommand = command()): OpeningWipRecord {
  return parseOpeningWipRecord({
    intake: { intake_id: 'intake-1', idempotency_key: request.body.idempotency_key, order_id: request.body.order_id, entry_apparatus: request.body.source_apparatus, source_apparatus: request.body.source_apparatus, source_operation: request.sourceOperation, resume_stage_node_id: request.body.source_stage_node_id, resume_apparatus: '', current_location: '', history_status: 'unavailable_before_cutover', status: 'confirmed', note: request.body.note ?? '', actor: { role: 'admin', ref_: 'fixture', display_name: 'Fixture' }, created_at_unix: 1791885600, updated_at_unix: 1791885600 },
    batches: request.body.batches.map((input, index) => ({ ...input, batch_id: `intake-1:roll-${index + 1}`, intake_id: 'intake-1', order_id: request.body.order_id, sequence_no: index + 1, qr_payload: `progress:intake-1:roll-${index + 1}`, quantity: input.finished_goods_meter, uom: 'm', wip_status: 'waiting', created_at_unix: 1791885600, updated_at_unix: 1791885600, label_item_code: 'PET', label_item_name: 'PET', used_by_session_id: '', used_by_apparatus: '', processed_by_session_id: '', processed_by_apparatus: '' })),
  })
}
const detailFor = (value = recordFor(), index = 0): OpeningWipDetail => ({ intake: value.intake, batch: value.batches[index] })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

interface ServerOptions { records?: OpeningWipRecord[]; snapshot?: ProductionSnapshot; catalog?: Row[]; mutationResult?: unknown; mutationStatus?: number; persist?: boolean; loseFirstWrite?: boolean; failReadback?: boolean }
function server(options: ServerOptions = {}) {
  let records = structuredClone(options.records ?? [])
  let writes = 0
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname
    if (path.endsWith('/sequence')) return response(options.snapshot ?? snapshot())
    if (path.endsWith('/apparatus')) return response(options.catalog ?? catalog)
    if (path.endsWith('/opening-wip') && init.method === 'GET') return options.failReadback && writes ? response({ error: 'local_unavailable' }, 503) : response({ records })
    if (path.endsWith('/opening-wip') && init.method === 'POST') {
      writes++
      const body = JSON.parse(init.body as string)
      const expected = { ...command(), body }
      const result = records.find(value => value.intake.idempotency_key === body.idempotency_key) ?? recordFor(expected)
      if (options.persist !== false && !options.mutationStatus) records = [...records.filter(value => value.intake.idempotency_key !== body.idempotency_key), result]
      if (options.loseFirstWrite && writes === 1) throw new TypeError('Local lost response')
      return response(Object.hasOwn(options, 'mutationResult') ? options.mutationResult : { record: result }, options.mutationStatus)
    }
    if (path.endsWith('/opening-wip') && init.method === 'DELETE') {
      writes++
      const batchId = url.searchParams.get('batch_id')
      const old = records.find(value => value.batches.some(batch => batch.batch_id === batchId))!
      const next = { ...old, batches: old.batches.map(batch => batch.batch_id === batchId ? { ...batch, wip_status: 'void' } : batch) }
      if (next.batches.every(batch => batch.wip_status === 'void')) next.intake = { ...next.intake, status: 'cancelled' }
      if (options.persist !== false && !options.mutationStatus) records = records.map(value => value.intake.intake_id === next.intake.intake_id ? next : value)
      return response(Object.hasOwn(options, 'mutationResult') ? options.mutationResult : { ok: true, intake: next.intake, batch: next.batches.find(batch => batch.batch_id === batchId) }, options.mutationStatus)
    }
    throw new Error(`Unexpected local fixture request ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('opening WIP capabilities and source policy', () => {
  it('separates collection read, intake preview, creation and actual-admin cancellation', () => {
    expect(wipPermissions(session(['apparatus.queue.read'], 'aparatchi'))).toEqual({ read: true, preview: false, create: false, cancel: false })
    expect(wipPermissions(session(['apparatus.queue.manage'], 'aparatchi'))).toEqual({ read: false, preview: true, create: false, cancel: false })
    expect(wipPermissions(session(['production.map.manage'], 'aparatchi'))).toEqual({ read: true, preview: true, create: true, cancel: false })
    expect(wipPermissions(session(['admin.access'], 'aparatchi')).cancel).toBe(false)
    expect(wipPermissions(session(['admin.access'])).cancel).toBe(true)
    expect(wipPermissions(null).create).toBe(false)
  })

  it('uses canonical source stage occurrences and excludes final output, task nodes and inactive apparatus', () => {
    const sources = openingWipSources(snapshot(), orderId, catalog)
    expect(sources.map(value => value.nodeId)).toEqual(['print', 'laminate'])
    expect(sources[0]).toMatchObject({ apparatusId: print, operation: 'print', revision: 1, next: [{ nodeId: 'laminate', apparatusId: laminate }] })
    expect(openingWipSources(snapshot(), orderId, catalog.map(value => value.apparatus_id === print ? { ...value, lifecycle: { state: 'retired' } } : value)).map(value => value.nodeId)).toEqual(['laminate'])
    expect(openingWipSources(snapshot(), orderId, catalog.map(value => ({ ...value, source_revision: undefined })))).toEqual([])
    const unknown = snapshot(); unknown.stage_states[orderId] = {}
    expect(openingWipSources(unknown, orderId, catalog)).toEqual([])
  })

  it('blocks frozen, requested-freeze, early-close, terminal and unknown order states', () => {
    const cases = [
      { lifecycle_status: 'production_completed', order_status: 'completed' }, { lifecycle_status: 'closed', order_status: 'completed' },
      { lifecycle_status: 'future', order_status: 'not_started' }, { lifecycle_status: 'released', order_status: 'future' },
    ]
    for (const status of cases) { const current = snapshot(); current.order_statuses[orderId] = status; expect(openingWipOrderIssue(current, orderId)).not.toBe(''); expect(openingWipSources(current, orderId, catalog)).toEqual([]) }
    for (const control of [{ state: 'frozen' }, { state: 'freeze_requested', freeze_request: { status: 'pending', request_id: 'f-1', target_apparatus: print } }, { state: 'active', early_close: { closed_at_unix: 1791885600 } }]) { const current = snapshot(); current.order_controls[orderId] = control; expect(openingWipOrderIssue(current, orderId)).not.toBe('') }
    const done = snapshot(); done.stage_states[orderId] = { print: 'completed', laminate: 'completed', cut: 'completed' }
    expect(openingWipSources(done, orderId, catalog)).toEqual([])
  })

  it('preserves repeated use of one machine as separate node identities and source choices', () => {
    const repeated = { ...map, nodes: [...(map.nodes as Row[]).filter(node => node.id !== 'end'), { id: 'second-print', kind: 'apparatus', apparatus_id: print, title: 'Second printer occurrence' }, { id: 'end', kind: 'end' }], edges: [{ from: 'start', to: 'print' }, { from: 'print', to: 'laminate' }, { from: 'laminate', to: 'second-print' }, { from: 'second-print', to: 'cut' }, { from: 'cut', to: 'end' }] }
    const current = snapshot(repeated); current.stage_states[orderId]['second-print'] = 'pending'
    const sources = openingWipSources(current, orderId, catalog)
    expect(sources.filter(value => value.apparatusId === print).map(value => value.nodeId)).toEqual(['print', 'second-print'])
    expect(command(current, 'second-print').body).toMatchObject({ source_apparatus: print, source_stage_node_id: 'second-print' })
  })

  it('follows valid condition branches and alternative peer edges without guessing a display title identity', () => {
    const alternative = 'apparatus:test:print-2'
    const nextMap = { ...map, nodes: [{ id: 'start', kind: 'start' }, { id: 'condition', kind: 'condition' }, { id: 'print', kind: 'apparatus', apparatus_id: print, alternative_group_id: 'alt-print', title: 'Shared label' }, { id: 'peer', kind: 'apparatus', apparatus_id: alternative, alternative_group_id: 'alt-print', title: 'Shared label' }, ...(map.nodes as Row[]).filter(node => ['laminate', 'cut', 'end'].includes(String(node.id)))], edges: [{ from: 'start', to: 'condition' }, { from: 'condition', to: 'print', branch: 'true' }, { from: 'print', to: 'laminate' }, { from: 'laminate', to: 'cut' }, { from: 'cut', to: 'end' }] }
    const current = snapshot(nextMap); current.stage_states[orderId]['peer'] = 'pending'
    const extraCatalog = [...catalog, { ...catalog[0], apparatus_id: alternative }]
    expect(openingWipSources(current, orderId, extraCatalog).find(value => value.nodeId === 'peer')).toMatchObject({ apparatusId: alternative, next: [{ nodeId: 'laminate', apparatusId: laminate }] })
    const invalidBranch = snapshot({ ...nextMap, edges: (nextMap.edges as Row[]).map(edge => edge.from === 'condition' ? { ...edge, branch: 'maybe' } : edge) })
    expect(openingWipSources(invalidBranch, orderId, extraCatalog)).toEqual([])
  })

  it('keeps quantity basis separate from unit and measured values separate from roll count', () => {
    const value = command(snapshot(), 'print', [roll, { ...roll, basis: 'estimated', metres: '50', kg: '10' }])
    expect(value.body).toEqual({ idempotency_key: 'retained-key-1', order_id: orderId, source_apparatus: print, source_stage_node_id: 'print', note: 'Local fixture', batches: [{ quantity_basis: 'measured', finished_goods_meter: 100.5, finished_goods_kg: 25.5, bobina_kg: 1.5 }, { quantity_basis: 'estimated', finished_goods_meter: 50, finished_goods_kg: 10, bobina_kg: 1.5 }] })
    expect(value.body.batches).toHaveLength(2)
    expect(value.body).not.toHaveProperty('current_location')
    expect(value.body).not.toHaveProperty('next_apparatus')
  })

  it('requires positive finite native roll measurements and 1–500 rolls', () => {
    for (const invalidValue of ['', '0', '-1', 'NaN', 'Infinity', '0x10']) expect(() => command(snapshot(), 'print', [{ ...roll, metres: invalidValue }])).toThrow()
    expect(() => command(snapshot(), 'print', [])).toThrow()
    expect(() => command(snapshot(), 'print', Array.from({ length: 501 }, () => roll))).toThrow()
    expect(() => command(snapshot(), 'print', [{ ...roll, basis: 'unknown' as OpeningWipRollDraft['basis'] }])).toThrow()
    expect(() => command(snapshot(), 'print', [{ ...roll, diameter: '100' }])).toThrow('Diametr')
    expect(command(snapshot(), 'print', [{ ...roll, kg: '1', bobinaKg: '2' }]).body.batches[0]).toMatchObject({ finished_goods_kg: 1, bobina_kg: 2 })
  })

  it('requires diameter for a cut source with a real downstream apparatus and sends it only there', () => {
    const last = 'apparatus:test:package-1'
    const current = snapshot({ ...map, nodes: [...(map.nodes as Row[]).filter(node => node.id !== 'end'), { id: 'package', kind: 'apparatus', apparatus_id: last }, { id: 'end', kind: 'end' }], edges: [...(map.edges as Row[]).filter(edge => edge.from !== 'cut'), { from: 'cut', to: 'package' }, { from: 'package', to: 'end' }] })
    current.stage_states[orderId]['package'] = 'pending'
    const cutCatalog = [...catalog, { ...catalog[0], apparatus_id: last, execution_profile: { operation: 'package' } }]
    expect(() => command(current, 'cut', [roll], cutCatalog)).toThrow('diametri')
    expect(command(current, 'cut', [{ ...roll, diameter: '300,5' }], cutCatalog).body.batches[0].diameter).toBe(300.5)
  })

  it('allows cancellation only for an unused waiting roll under an actual admin principal', () => {
    expect(openingWipCancelIssue(detailFor(), session())).toBe('')
    expect(openingWipCancelIssue(detailFor(), session(['admin.access'], 'aparatchi'))).toContain('haqiqiy admin')
    for (const status of ['in_use', 'processed', 'void', 'unknown']) expect(openingWipCancelIssue({ ...detailFor(), batch: { ...detailFor().batch, wip_status: status } }, session())).not.toBe('')
    for (const key of ['used_by_session_id', 'used_by_apparatus', 'processed_by_session_id', 'processed_by_apparatus']) expect(openingWipCancelIssue({ ...detailFor(), batch: { ...detailFor().batch, [key]: 'used' } }, session())).not.toBe('')
  })
})

describe('opening WIP native writes and retained identity', () => {
  it('creates only through opening-wip, preserves source/quantities and validates native readback', async () => {
    const fetch = server(), expected = command()
    const result = await createOpeningWip(client, session(), expected)
    expect(openingWipMatchesCommand(result, expected)).toBe(true)
    const posts = fetch.mock.calls.filter(([, init]) => init.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(new URL(String(posts[0][0])).pathname).toBe('/v1/mobile/admin/production-maps/opening-wip')
    expect(JSON.parse(posts[0][1].body as string)).toEqual(expected.body)
    expect(fetch.mock.calls.filter(([url, init]) => String(url).includes('/opening-wip') && init.method === 'GET')).toHaveLength(2)
  })

  it('never submits arbitrary location, legacy stage fields or tampered roll values', async () => {
    for (const changes of [{ current_location: 'guessed-location' }, { entry_apparatus: 'Printer' }, { batches: [{ quantity_basis: 'measured', finished_goods_meter: -1, finished_goods_kg: 1, bobina_kg: 1 }] }]) {
      const fetch = server(), original = command()
      await expect(createOpeningWip(client, session(), { ...original, body: { ...original.body, ...changes } })).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('keeps source and order conflicts recoverable and sends no write from a stale snapshot', async () => {
    const original = command()
    for (const changes of ['frozen', 'completed', 'graph', 'revision']) {
      const current = snapshot(), currentCatalog = structuredClone(catalog)
      if (changes === 'frozen') current.order_controls[orderId] = { state: 'frozen' }
      if (changes === 'completed') current.order_statuses[orderId] = { lifecycle_status: 'production_completed', order_status: 'completed' }
      if (changes === 'graph') current.maps[0].map.title = 'Changed map'
      if (changes === 'revision') currentCatalog[0].source_revision = 2
      const fetch = server({ snapshot: current, catalog: currentCatalog })
      await expect(createOpeningWip(client, session(), original)).rejects.toMatchObject({ uncertain: false })
      expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
    }
  })

  it('requires exact commit identity, source operation, quantities and batch count instead of HTTP 200', async () => {
    const original = recordFor()
    const replies: unknown[] = [{ ok: true }, { record: { ...original, intake: { ...original.intake, order_id: 'other-order' } } }, { record: { ...original, intake: { ...original.intake, source_apparatus: laminate } } }, { record: { ...original, intake: { ...original.intake, source_operation: 'cut' } } }, { record: { ...original, batches: original.batches.map(batch => ({ ...batch, finished_goods_kg: 0 })) } }, { record: { ...original, batches: [] } }]
    for (const mutationResult of replies) { server({ mutationResult }); await expect(createOpeningWip(client, session(), command())).rejects.toMatchObject({ uncertain: true }) }
  })

  it('does not report successful creation when readback fails or misses the returned intake', async () => {
    server({ failReadback: true })
    await expect(createOpeningWip(client, session(), command())).rejects.toMatchObject({ uncertain: true })
    server({ persist: false })
    await expect(createOpeningWip(client, session(), command())).rejects.toMatchObject({ uncertain: true })
  })

  it('recovers a lost committed response using the same key without making another POST', async () => {
    const fetch = server({ loseFirstWrite: true })
    const retained = command()
    await expect(createOpeningWip(client, session(), retained)).rejects.toMatchObject({ uncertain: true })
    const recovered = await createOpeningWip(client, session(), retained)
    expect(recovered.intake.idempotency_key).toBe(retained.body.idempotency_key)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('recovers same-key records after production advances and rejects a conflicting key payload', async () => {
    const current = snapshot(); current.order_statuses[orderId] = { lifecycle_status: 'production_completed', order_status: 'completed' }
    let fetch = server({ records: [recordFor()], snapshot: current })
    expect((await createOpeningWip(client, session(), command())).intake.intake_id).toBe('intake-1')
    expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
    const conflicting = recordFor(); conflicting.batches[0].finished_goods_meter = 1
    fetch = server({ records: [conflicting] })
    await expect(createOpeningWip(client, session(), command())).rejects.toMatchObject({ uncertain: false })
    expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })

  it('does not infer a write was absent from a missing bounded intake read', async () => {
    server()
    expect(await reconcileOpeningWipCreate(client, command())).toBe(null)
    expect(WIP_API_LIMITATIONS.join(' ')).toContain('missing row in that snapshot cannot prove')
  })

  it('keeps backend 403 and 409 failures deterministic with the draft recoverable', async () => {
    for (const mutationStatus of [403, 409]) {
      const fetch = server({ mutationStatus, mutationResult: { error: mutationStatus === 403 ? 'forbidden' : 'opening_wip_idempotency_conflict' } })
      await expect(createOpeningWip(client, session(), command())).rejects.toMatchObject({ uncertain: false })
      expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    }
  })

  it('uses exact batch cancellation, preserves sibling rolls and confirms void rather than disappearance', async () => {
    const opening = recordFor(command(snapshot(), 'print', [roll, roll])), selected = detailFor(opening)
    const fetch = server({ records: [opening] })
    expect((await cancelOpeningWip(client, session(), selected)).batch.wip_status).toBe('void')
    const deleted = fetch.mock.calls.find(([, init]) => init.method === 'DELETE')!
    const url = new URL(String(deleted[0]))
    expect(url.pathname).toBe('/v1/mobile/admin/production-maps/opening-wip')
    expect(url.searchParams.get('batch_id')).toBe(selected.batch.batch_id)
    expect(deleted[1].body).toBeUndefined()
    const records = await openingWipRecords(client, orderId)
    expect(records[0].batches[1].wip_status).toBe('waiting')
    expect(records[0].intake.status).toBe('confirmed')
  })

  it('rejects used and changed batches before DELETE and requires the actual admin role', async () => {
    const selected = detailFor()
    const used = recordFor(); used.batches[0].used_by_session_id = 'current-session'
    const replaced = recordFor(); replaced.batches[0].finished_goods_kg = 30
    for (const existing of [used, replaced]) {
      const fetch = server({ records: [existing] })
      await expect(cancelOpeningWip(client, session(), selected)).rejects.toMatchObject({ uncertain: false })
      expect(fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
    }
    const fetch = server({ records: [recordFor()] })
    await expect(cancelOpeningWip(client, session(['admin.access'], 'aparatchi'), selected)).rejects.toThrow('haqiqiy admin')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never accepts false void responses, another batch/order or changed quantity', async () => {
    const selected = detailFor()
    const replies = [{ ok: false, ...selected }, { ok: true }, { ok: true, intake: selected.intake, batch: { ...selected.batch, wip_status: 'waiting' } }, { ok: true, intake: selected.intake, batch: { ...selected.batch, wip_status: 'void', order_id: 'other-order' } }, { ok: true, intake: selected.intake, batch: { ...selected.batch, wip_status: 'void', finished_goods_kg: 30 } }]
    for (const mutationResult of replies) { server({ records: [recordFor()], mutationResult }); await expect(cancelOpeningWip(client, session(), selected)).rejects.toMatchObject({ uncertain: true }) }
  })

  it('reconciles cancellation with read-only confirmed status and never retries DELETE itself', async () => {
    const selected = detailFor()
    let fetch = server({ records: [recordFor()] })
    expect((await reconcileOpeningWipCancel(client, selected)).confirmed).toBe(false)
    const cancelled = recordFor(); cancelled.batches[0].wip_status = 'void'; cancelled.intake.status = 'cancelled'
    fetch = server({ records: [cancelled] })
    expect((await reconcileOpeningWipCancel(client, selected)).confirmed).toBe(true)
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it('preserves a waiting roll and its quantities when backend lineage protection rejects cancellation', async () => {
    const existing = recordFor(), selected = detailFor(existing), before = structuredClone(selected)
    const fetch = server({ records: [existing], mutationStatus: 409, mutationResult: { error: 'opening_wip_delete_locked', detail: 'Rulon ishlab chiqarish tarixiga ulangan.' } })
    await expect(cancelOpeningWip(client, session(), selected)).rejects.toMatchObject({ uncertain: false, message: 'Rulon ishlab chiqarish tarixiga ulangan.' })
    expect(selected).toEqual(before)
    const current = (await openingWipRecords(client, orderId))[0]
    expect(current.batches[0]).toMatchObject({ wip_status: 'waiting', finished_goods_meter: 100.5, finished_goods_kg: 25.5 })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1)
  })

  it('does not write after cancellation and treats a late interrupted write as uncertain', async () => {
    const controller = new AbortController(); controller.abort()
    let fetch = server()
    await expect(createOpeningWip(client, session(), command(), controller.signal)).rejects.toMatchObject({ uncertain: false })
    expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
    const duringWrite = new AbortController(); fetch = server()
    const respond = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url, init) => { const result = await respond(url, init); if (init.method === 'POST') duringWrite.abort(); return result })
    await expect(createOpeningWip(client, session(), command(), duringWrite.signal)).rejects.toMatchObject({ uncertain: true })
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })
})

describe('WIP route and opening intake read-only previews', () => {
  const batch = { batch_id: 'progress-1', order_id: orderId, wip_status: 'waiting', next_apparatus: 'historical-not-current', current_location: 'Actual station', produced_qty: 100.5, uom: 'm', qr_payload: 'progress:progress-1' }
  const route = { source_stage_node_id: 'print', stage_node_id: 'laminate', consumer_apparatus_ids: [laminate], map_fingerprint: 'native-map-fingerprint', remapped: true }
  it('uses server route consumers and a real scoped intake lookup instead of historical next apparatus', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ok: true, batch, active_order_validated: true, input_route: route, input_route_error: null })).mockResolvedValueOnce(response({ ok: true, batch, active_order_validated: true, validated_apparatus: laminate, validated_order_id: orderId, input_route: route }))
    vi.stubGlobal('fetch', fetch)
    expect((await wipRoutePreview(client, batch)).route).toEqual(route)
    await wipRoutePreview(client, batch, laminate)
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ progress_batch_id: 'progress-1', qr_payload: 'progress:progress-1', apparatus: laminate, order_id: orderId, require_active_order: true })
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe('/v1/mobile/admin/production-maps/progress-qr/lookup')
  })

  it('refuses HTTP 200 without exact active-order, batch and canonical consumer validation', async () => {
    const valid = { ok: true, batch, active_order_validated: true, input_route: route }
    for (const reply of [{ ...valid, ok: false }, { ...valid, active_order_validated: false }, { ...valid, batch: { ...batch, order_id: 'other-order' } }, { ...valid, input_route: { ...route, consumer_apparatus_ids: ['Laminator display'] } }, { ...valid, validated_apparatus: print, validated_order_id: orderId }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reply)))
      await expect(wipRoutePreview(client, batch, laminate)).rejects.toThrow()
    }
  })

  it('displays unresolved route errors as facts without inventing WIP move or undo endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: true, batch, active_order_validated: true, input_route: null, input_route_error: 'wip_route_ambiguous' })))
    expect(await wipRoutePreview(client, batch)).toMatchObject({ route: null, routeError: 'wip_route_ambiguous' })
    expect(WIP_API_LIMITATIONS.join(' ')).toContain('no batch move or undo method')
  })

  it('previews exact opening roll at its current next stage without marking it in use', async () => {
    const detail = detailFor()
    expect(openingWipDestinations(snapshot(), detail)).toEqual([{ nodeId: 'laminate', apparatusId: laminate, label: 'Laminator' }])
    const fetch = vi.fn().mockResolvedValue(response({ ok: true, batch: detail.batch }))
    vi.stubGlobal('fetch', fetch)
    expect((await openingWipIntakePreview(client, detail, laminate)).wip_status).toBe('waiting')
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe('/v1/mobile/admin/production-maps/opening-wip/lookup')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ apparatus: laminate, order_id: orderId, batch_id: detail.batch.batch_id, qr_payload: detail.batch.qr_payload })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reads exact WIP batch from a bounded order feed and refuses another order identity', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ batches: [batch] })).mockResolvedValueOnce(response({ batches: [{ ...batch, order_id: 'other-order' }] }))
    vi.stubGlobal('fetch', fetch)
    expect(await wipBatchDetail(client, batch)).toEqual(batch)
    expect(Object.fromEntries(new URL(String(fetch.mock.calls[0][0])).searchParams)).toEqual({ order_id: orderId, status: 'all', limit: '500' })
    await expect(wipBatchDetail(client, batch)).rejects.toThrow()
  })
})

describe('opening WIP interruption registry', () => {
  function registry() { const value = new OpeningWipAttemptRegistry(); value.activate('session-one'); return value }
  it('retains the dispatched native key and exact payload after page unmount and forbids a fresh duplicate', () => {
    const value = registry(), request = command()
    const lease = value.begin('session-one', 'opening-page', request)
    value.dispatched(lease)
    value.interrupt(lease)
    const reopened = value.get('session-one', 'opening-page')!
    expect(reopened.phase).toBe('uncertain')
    expect(reopened.command.body).toEqual(request.body)
    expect(() => value.begin('session-one', 'opening-page', { ...request, body: { ...request.body, idempotency_key: 'new-key' } })).toThrow('Avvalgi')
    expect(() => value.clear('session-one', 'opening-page')).toThrow()
  })

  it('blocks the same unresolved order through a different page context and permits exact-key recovery there', () => {
    const value = registry(), request = command()
    const initial = value.begin('session-one', 'opening-page', request)
    value.dispatched(initial); value.interrupt(initial)
    expect(value.get('session-one', 'order-detail', orderId)?.command.body.idempotency_key).toBe(request.body.idempotency_key)
    expect(() => value.begin('session-one', 'order-detail', { ...request, body: { ...request.body, idempotency_key: 'new-key' } })).toThrow()
    const recovered = value.begin('session-one', 'order-detail', request, true)
    expect(recovered.context).toBe('opening-page')
    value.finish(recovered, { result: recordFor(request) })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('confirmed')
  })

  it('marks pre-dispatch cancellation recoverable without inventing an uncertain server write', () => {
    const value = registry(), request = command()
    const lease = value.begin('session-one', 'opening-page', request)
    value.interrupt(lease)
    expect(value.get('session-one', 'opening-page')).toMatchObject({ phase: 'blocked', dispatched: false, command: { body: { idempotency_key: 'retained-key-1' } } })
    value.clear('session-one', 'opening-page')
    expect(value.get('session-one', 'opening-page')).toBe(null)
  })

  it('keeps uncertainty after a bounded read misses the key or a recovery preflight is rejected', () => {
    const value = registry(), request = command()
    const initial = value.begin('session-one', 'opening-page', request)
    value.dispatched(initial); value.interrupt(initial)
    let retry = value.begin('session-one', 'opening-page', request, true)
    value.finish(retry, { missing: true })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('uncertain')
    retry = value.begin('session-one', 'opening-page', request, true)
    value.finish(retry, { error: 'Order frozen during recovery', uncertain: false })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('uncertain')
    expect(value.get('session-one', 'opening-page')?.command.body).toEqual(request.body)
  })

  it('ignores late old leases after interruption or a later recovery attempt', () => {
    const value = registry(), request = command()
    const old = value.begin('session-one', 'opening-page', request)
    value.dispatched(old); value.interrupt(old)
    value.finish(old, { result: recordFor(request) })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('uncertain')
    const current = value.begin('session-one', 'opening-page', request, true)
    value.finish(old, { error: 'Old request failed', uncertain: false })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('pending')
    value.finish(current, { result: recordFor(request) })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('confirmed')
  })

  it('clears all context state for another authentication scope and rejects callbacks from the prior scope', () => {
    const value = registry(), request = command()
    const old = value.begin('session-one', 'opening-page', request)
    value.dispatched(old)
    value.activate('session-two')
    value.finish(old, { result: recordFor(request) })
    value.interrupt(old)
    expect(value.get('session-one', 'opening-page')).toBe(null)
    expect(value.get('session-two', 'opening-page')).toBe(null)
    expect(() => value.begin('session-one', 'opening-page', request)).toThrow('Sessiya')
  })

  it('stores immutable DTO copies and refuses recovery using an edited payload or false result', () => {
    const value = registry(), request = command(), before = structuredClone(request)
    const initial = value.begin('session-one', 'opening-page', request)
    request.body.batches[0].finished_goods_meter = 1
    expect(value.get('session-one', 'opening-page')?.command.body).toEqual(before.body)
    value.dispatched(initial); value.interrupt(initial)
    expect(() => value.begin('session-one', 'opening-page', request, true)).toThrow()
    const retry = value.begin('session-one', 'opening-page', before, true)
    const wrong = recordFor(before); wrong.intake.idempotency_key = 'wrong-key'
    value.finish(retry, { result: wrong })
    expect(value.get('session-one', 'opening-page')?.phase).toBe('uncertain')
  })

  it('retains confirmed results across reopening and requires an explicit reset before another creation', () => {
    const value = registry(), request = command()
    const lease = value.begin('session-one', 'opening-page', request)
    value.dispatched(lease); value.finish(lease, { result: recordFor(request) })
    expect(value.get('session-one', 'opening-page')?.result?.intake.intake_id).toBe('intake-1')
    expect(() => value.begin('session-one', 'opening-page', request)).toThrow('tasdiqlangan')
    value.clear('session-one', 'opening-page')
    expect(() => value.begin('session-one', 'opening-page', { ...request, body: { ...request.body, idempotency_key: 'explicit-new-key' } })).not.toThrow()
  })
})
