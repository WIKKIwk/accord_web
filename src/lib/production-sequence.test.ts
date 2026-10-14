import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Session } from './api-types'
import { executeProductionSequenceMove, productionSequenceMove, productionSequenceQueue, productionSequenceReceipt } from './production-sequence'

const app = 'apparatus:test:print', ids = ['order-a', 'order-b', 'order-c', 'order-hidden'], version = 'a'.repeat(64)
const session = { token: 'synthetic', profile: { role: 'admin', ref: 'synthetic-admin', display_name: 'QA' }, capabilities: ['admin.access'] } as Session
function snapshot(): ProductionSnapshot {
  return { ok: true, rev: 1, epoch: 'synthetic-epoch', scope: '', maps: ids.map(id => ({ map: { id, order_number: id, nodes: [], edges: [] }, program: {} })),
    order_statuses: {}, order_controls: {}, order_customers: {}, queue_action_controls: {}, stage_states: {},
    queue_states: { [app]: Object.fromEntries(ids.map(id => [id, 'pending'])) }, sequences: { [app]: ids }, visible_order_ids: { [app]: ids.slice(0, 3) }, sequence_versions: { [app]: version } }
}
const plan = (value = snapshot()) => productionSequenceMove(value, app, ids[2], 0, session, 'original-key')!
const receipt = (value = plan()) => ({ ok: true, order_ids: [ids[2], ids[0], ids[1], ids[3]], version: 'b'.repeat(64), adjusted: false, epoch: value.epoch, revision: null })
function client(value = snapshot(), response: unknown = receipt()) {
  return { productionSnapshot: vi.fn().mockResolvedValue(value), request: vi.fn().mockResolvedValue(response) } as unknown as ApiClient
}
const signal = () => new AbortController().signal

describe('native apparatus sequence move planning', () => {
  it('uses a visible anchor while preserving all hidden canonical members and optional revision', () => {
    const command = plan()
    expect(command.body).toEqual({ apparatus: app, order_id: ids[2], before_order_id: ids[0], expected_version: version, idempotency_key: 'original-key' })
    expect(command.canonicalIds).toEqual(ids)
    expect(productionSequenceQueue(snapshot(), app, session)).toMatchObject({ valid: true, canReorder: true, revision: undefined })
  })
  it('uses after at the visible tail without replacing or deleting hidden canonical rows', () => {
    const command = productionSequenceMove(snapshot(), app, ids[0], 2, session, 'tail-key')!
    expect(command.body).toMatchObject({ after_order_id: ids[2] }); expect(command.body).not.toHaveProperty('before_order_id')
    expect(command.displayIds).toEqual([ids[1], ids[2], ids[0]])
  })
  it.each(['in_progress', 'print_preflight', 'paused'])('locks %s and clamps drops after the last active row', state => {
    const value = snapshot(); value.queue_states[app][ids[1]] = state
    expect(() => productionSequenceMove(value, app, ids[1], 0, session)).toThrow('surilmaydi')
    expect(productionSequenceMove(value, app, ids[2], 0, session)).toBeNull()
    const command = productionSequenceMove(value, app, ids[0], 1, session, 'clamp-key')!
    expect(command).toMatchObject({ clamped: true, fromPosition: 1, toPosition: 3 })
    expect(command.body).toMatchObject({ after_order_id: ids[2] })
  })
  it.each(['global', 'raw'])('keeps %s frozen rows visible but excludes both editable membership and anchors', kind => {
    const value = snapshot()
    if (kind === 'global') value.order_controls[ids[1]] = { state: 'frozen' }; else value.queue_states[app][ids[1]] = 'frozen'
    const queue = productionSequenceQueue(value, app, session)
    expect(queue.rows.find(row => row.id === ids[1])).toMatchObject({ frozen: true, locked: true })
    expect(queue.canonicalIds).not.toContain(ids[1])
    const command = productionSequenceMove(value, app, ids[0], 1, session, 'skip-frozen')!
    // Swapping past only a frozen row has no native editable change.
    expect(command).toBeNull()
  })
  it('skips a frozen tail anchor and uses the nearest eligible row', () => {
    const value = snapshot(); value.order_controls[ids[2]] = { state: 'frozen' }
    const command = productionSequenceMove(value, app, ids[0], 2, session, 'frozen-tail')!
    expect(command.body).toMatchObject({ after_order_id: ids[1] }); expect(command.canonicalIds).toEqual([ids[0], ids[1], ids[3]])
  })
  it('does not interpret a pending freeze request as frozen', () => {
    const value = snapshot(); value.order_controls[ids[2]] = { state: 'freeze_requested', freeze_request: { request_id: 'request', status: 'pending', target_apparatus: app } }
    expect(productionSequenceQueue(value, app, session).rows[2].locked).toBe(false)
    expect(plan(value).body.order_id).toBe(ids[2])
  })
  it.each([{ capabilities: ['apparatus.queue.read'] }, { capabilities: ['apparatus.queue.manage'] }, { capabilities: [] }])('does not authorize reorder from queue-only permissions $capabilities', ({ capabilities }) => {
    const actor = { ...session, capabilities }
    expect(productionSequenceQueue(snapshot(), app, actor).canReorder).toBe(false)
    expect(() => productionSequenceMove(snapshot(), app, ids[2], 0, actor)).toThrow('ruxsati')
  })
  it('allows production.map.manage without admin.access as the native handler does', () => {
    expect(productionSequenceQueue(snapshot(), app, { ...session, capabilities: ['production.map.manage'] }).canReorder).toBe(true)
  })
  it.each(['version', 'missing-state', 'duplicate', 'missing-map', 'missing-canonical'])('fails closed for malformed %s', issue => {
    const value = snapshot()
    if (issue === 'version') value.sequence_versions = { [app]: 'bad' }
    if (issue === 'missing-state') delete value.queue_states[app][ids[1]]
    if (issue === 'duplicate') value.visible_order_ids = { [app]: [ids[0], ids[0]] }
    if (issue === 'missing-map') value.maps = value.maps.filter(saved => saved.map.id !== ids[1])
    if (issue === 'missing-canonical') value.sequences[app] = [ids[0], ids[2]]
    expect(productionSequenceQueue(value, app, session).canReorder).toBe(false)
  })
  it('does not make a command for the same index and rejects malformed target/key', () => {
    expect(productionSequenceMove(snapshot(), app, ids[0], 0, session)).toBeNull()
    for (const target of [-1, 9, 1.2, NaN]) expect(() => productionSequenceMove(snapshot(), app, ids[0], target, session)).toThrow()
    expect(() => productionSequenceMove(snapshot(), app, ids[2], 0, session, ' ')).toThrow('identifikatori')
  })
})

describe('native sequence receipts and exact-key executor', () => {
  it('requires a complete receipt with stable nonmoved order and exact position unless adjusted', () => {
    const command = plan()
    expect(productionSequenceReceipt(receipt(), command)).toBe(true)
    for (const change of [{ order_ids: ids.slice(0, 3) }, { order_ids: [ids[2], ids[1], ids[0], ids[3]] }, { order_ids: ids }, { version: 'invalid' }, { adjusted: 'true' }, { revision: -1 }, { epoch: '' }]) expect(productionSequenceReceipt({ ...receipt(), ...change }, command)).toBe(false)
    expect(productionSequenceReceipt({ ...receipt(), adjusted: true, order_ids: ids }, command)).toBe(true)
    expect(productionSequenceReceipt({ ...receipt(), epoch: 'old-server-epoch', revision: undefined }, command)).toBe(true)
  })
  it('GETs fresh state then POSTs only the native move DTO and reads back', async () => {
    const api = client(), dispatch = vi.fn()
    const result = await executeProductionSequenceMove(api, session, plan(), signal(), undefined, false, dispatch)
    expect(api.request).toHaveBeenCalledExactlyOnceWith('/v1/mobile/admin/production-maps/sequence', 'POST', expect.objectContaining({ body: plan().body }))
    expect(api.productionSnapshot).toHaveBeenCalledTimes(2); expect(dispatch).toHaveBeenCalledOnce(); expect(result.receipt.adjusted).toBe(false)
  })
  it('rejects stale version before POST, including a changed frozen/active state', async () => {
    const value = snapshot(); value.sequence_versions = { [app]: 'c'.repeat(64) }
    const api = client(value)
    await expect(executeProductionSequenceMove(api, session, plan(), signal())).rejects.toMatchObject({ kind: 'conflict', definitive: true, snapshot: value })
    expect(api.request).not.toHaveBeenCalled()
  })
  it.each([new ApiError(0, 'network'), new ApiError(408, 'timeout'), new ApiError(429, 'rate-limit'), new ApiError(503, 'unavailable'), new Error('transport')])('retries transient failure with byte-identical body/key', async failure => {
    const api = client(); vi.mocked(api.request).mockRejectedValueOnce(failure)
    await executeProductionSequenceMove(api, session, plan(), signal())
    const calls = vi.mocked(api.request).mock.calls
    expect(calls).toHaveLength(2); expect(calls[0][2]?.body).toEqual(calls[1][2]?.body)
  })
  it('retries malformed confirmation, then retains uncertainty despite a matching current queue', async () => {
    const api = client(snapshot(), { ok: true })
    await expect(executeProductionSequenceMove(api, session, plan(), signal())).rejects.toMatchObject({ kind: 'uncertain', definitive: false })
    expect(api.request).toHaveBeenCalledTimes(2); expect(api.productionSnapshot).toHaveBeenCalledOnce()
  })
  it.each([400, 403, 409])('does not replay definitive %s; version conflict supplies fresh state for a new reviewed intent', async status => {
    const api = client(); vi.mocked(api.request).mockRejectedValue(new ApiError(status, 'native-refusal'))
    await expect(executeProductionSequenceMove(api, session, plan(), signal())).rejects.toMatchObject({ definitive: true, kind: status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'blocked' })
    expect(api.request).toHaveBeenCalledOnce()
  })
  it('recovers the original receipt after a server epoch/version/membership change without fresh preflight rebasing', async () => {
    const newer = snapshot(); newer.epoch = 'new-server-epoch'; newer.sequence_versions = { [app]: 'd'.repeat(64) }; newer.visible_order_ids = { [app]: [] }
    const api = client(newer)
    const result = await executeProductionSequenceMove(api, session, plan(), signal(), undefined, true)
    expect(api.productionSnapshot).toHaveBeenCalledOnce(); expect(api.request).toHaveBeenCalledWith(expect.any(String), 'POST', expect.objectContaining({ body: plan().body })); expect(result.snapshot?.epoch).toBe('new-server-epoch')
  })
  it('accepts a durable receipt even if readback is unavailable, without inventing displayed positions', async () => {
    const api = client(); vi.mocked(api.productionSnapshot).mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new ApiError(0, 'network'))
    expect((await executeProductionSequenceMove(api, session, plan(), signal())).snapshot).toBeUndefined()
  })
  it('does not publish a snapshot older than the receipt sequence revision', async () => {
    const value = snapshot(); value.sequence_revisions = { [app]: 2 }
    const api = client(value, { ...receipt(), revision: 3 })
    expect((await executeProductionSequenceMove(api, session, plan(), signal())).snapshot).toBeUndefined()
  })
  it('refuses actor/permission changes and aborted generations before any request', async () => {
    const api = client()
    for (const changed of [{ ...session, capabilities: ['apparatus.queue.manage'] }, { ...session, profile: { ...session.profile, ref: 'other-actor' } }]) await expect(executeProductionSequenceMove(api, changed, plan(), signal(), undefined, true)).rejects.toMatchObject({ kind: 'forbidden' })
    const controller = new AbortController(); controller.abort()
    await expect(executeProductionSequenceMove(api, session, plan(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.request).not.toHaveBeenCalled(); expect(api.productionSnapshot).not.toHaveBeenCalled()
  })
})
