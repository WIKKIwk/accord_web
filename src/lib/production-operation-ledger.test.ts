import { describe, expect, it, vi } from 'vitest'
import { ProductionOperationLedger } from './production-operation-ledger'
import type { ProductionOperationChannel } from './production-operation-ledger'

const scope = 'fixture-auth-scope', orderId = 'zakaz-ledger-1'
const channels = ['assignment', 'legacy-control', 'completion', 'material-intake', 'material-link'] as const
function operation(channel: ProductionOperationChannel, id = orderId) {
  return { channel, orderId: id, plan: { orderId: id, kind: 'reorder', body: { order_id: id, idempotency_key: 'original-command', before_order_id: 'original-anchor' } }, proof: { actor: { role: 'admin', ref: 'fixture-user' } } }
}
function ledger() { const value = new ProductionOperationLedger(); value.activate(scope); return value }

describe('shared order production operation ownership', () => {
  it.each(channels)('reserves %s before async preflight and excludes every other channel in both directions', async owner => {
    const value = ledger(), lease = value.begin(scope, operation(owner))
    let finishPreflight!: () => void
    const preflight = new Promise<void>(resolve => { finishPreflight = resolve })
    for (const channel of channels) {
      expect(() => value.begin(scope, operation(channel))).toThrow('Avvalgi amal')
      expect(() => value.begin(scope, operation(channel), true)).toThrow('Avvalgi amal')
    }
    expect(value.get(scope, orderId)).toMatchObject({ channel: owner, phase: 'pending', dispatched: false })
    finishPreflight(); await preflight
    expect(value.dispatched(lease)).toBe(true)
    value.finish(lease, { confirmed: true }); expect(value.get(scope, orderId)).toBeNull()
  })

  it('allows unrelated orders while preserving exclusive ownership of the selected order', () => {
    const value = ledger(), first = value.begin(scope, operation('legacy-control')), second = value.begin(scope, operation('completion', 'zakaz-ledger-2'))
    value.dispatched(first); value.dispatched(second)
    value.finish(first, { confirmed: true })
    expect(value.get(scope, orderId)).toBeNull()
    expect(value.get(scope, 'zakaz-ledger-2')).toMatchObject({ channel: 'completion', dispatched: true })
  })
  it('refuses a previously opened confirmation after another panel reserves the order, before its preflight or write', async () => {
    const value = ledger(), original = operation('legacy-control'), preflight = vi.fn(), write = vi.fn()
    const previouslyOpenedConfirmation = async () => {
      value.begin(scope, original)
      await preflight(); write()
    }
    value.begin(scope, operation('assignment'))
    await expect(previouslyOpenedConfirmation()).rejects.toThrow('Avvalgi amal')
    expect(preflight).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  })

  it('releases an interrupted or failed undispatched preflight without holding unrelated business work', () => {
    const value = ledger(), first = value.begin(scope, operation('legacy-control'))
    value.interrupt(first); expect(value.get(scope, orderId)).toBeNull(); expect(value.dispatched(first)).toBe(false)
    const next = value.begin(scope, operation('assignment'))
    value.finish(next, { error: 'Read failed before write', uncertain: true })
    expect(value.get(scope, orderId)).toBeNull()
  })

  it.each(channels)('retains a dispatched %s intent across unmount, refresh, abort and late success', channel => {
    const value = ledger(), original = operation(channel), lease = value.begin(scope, original)
    value.dispatched(lease); value.interrupt(lease)
    value.activate(scope)
    value.finish(lease, { confirmed: true }); value.finish(lease, { error: 'late error', uncertain: false })
    expect(value.get(scope, orderId)).toMatchObject({ phase: 'uncertain', dispatched: true, plan: original.plan, proof: original.proof })
    expect(() => value.begin(scope, operation('completion'))).toThrow('Avvalgi amal')
    expect(value.dispatched(lease)).toBe(false)
  })

  it('keeps even a dispatched 4xx held when a native post-commit failure cannot be excluded', () => {
    const value = ledger(), lease = value.begin(scope, operation('legacy-control'))
    value.dispatched(lease); value.finish(lease, { error: 'Native 400 after commit', uncertain: false })
    expect(value.get(scope, orderId)).toMatchObject({ phase: 'uncertain', dispatched: true })
  })

  it('allows only the same owner and exact saved business plan/proof for recovery', () => {
    const value = ledger(), original = operation('legacy-control'), lease = value.begin(scope, original)
    value.dispatched(lease); value.interrupt(lease)
    const changedKey = structuredClone(original); changedKey.plan.body.idempotency_key = 'replacement-key'
    const changedBody = structuredClone(original); changedBody.plan.body.before_order_id = 'different-anchor'
    const changedProof = structuredClone(original); changedProof.proof.actor.ref = 'different-user'
    for (const changed of [changedKey, changedBody, changedProof, { ...original, channel: 'completion' as const }]) expect(() => value.begin(scope, changed, true)).toThrow('Avvalgi amal')
    const recovery = value.begin(scope, original, true)
    value.finish(recovery, { error: 'Recovery 403', uncertain: false })
    expect(value.get(scope, orderId)).toMatchObject({ phase: 'uncertain', plan: original.plan })
    const again = value.begin(scope, original, true); value.finish(again, { confirmed: true })
    expect(value.get(scope, orderId)).toBeNull()
  })

  it('isolates auth generations and ignores old receipts even after returning to the previous scope string', () => {
    const value = ledger(), lease = value.begin(scope, operation('assignment')); value.dispatched(lease)
    value.activate('different-auth-scope'); expect(value.get(scope, orderId)).toBeNull()
    value.activate(scope); const fresh = value.begin(scope, operation('completion'))
    value.finish(lease, { confirmed: true }); expect(value.dispatched(lease)).toBe(false)
    expect(value.get(scope, orderId)).toMatchObject({ channel: 'completion', serial: fresh.serial })
    expect(() => value.begin('different-auth-scope', operation('assignment'))).toThrow('Sessiya')
  })

  it('uses cloned business plans and rejects credentials rather than retaining sessions or clients', () => {
    const value = ledger(), original = operation('legacy-control')
    value.begin(scope, original); original.plan.body.idempotency_key = 'mutated-local-key'
    const read = value.get<typeof original.plan, typeof original.proof>(scope, orderId)!
    expect(read.plan.body.idempotency_key).toBe('original-command')
    read.plan.body.idempotency_key = 'mutated-reader-key'
    expect(value.get<typeof original.plan>(scope, orderId)?.plan.body.idempotency_key).toBe('original-command')
    for (const field of ['token', 'access_token', 'loginCode', 'avatar_url', 'password']) {
      const candidate = operation('completion', `credential-${field}`)
      expect(() => value.begin(scope, { ...candidate, proof: { nested: { [field]: 'fixture-secret' } } })).toThrow('kirish ma’lumotlari')
      expect(value.get(scope, candidate.orderId)).toBeNull()
    }
  })

  it('publishes revisions across channels and returns only channel-owned recovery data', () => {
    const value = ledger(), listener = vi.fn(), unsubscribe = value.subscribe(listener), revision = value.getRevision()
    const lease = value.begin(scope, operation('completion')); value.dispatched(lease); value.interrupt(lease)
    expect(value.getRevision()).toBeGreaterThan(revision); expect(listener).toHaveBeenCalledTimes(3)
    expect(value.get(scope, orderId, 'assignment')).toBeNull()
    expect(value.get(scope, orderId, 'completion')).toMatchObject({ phase: 'uncertain' })
    unsubscribe(); value.activate('next'); expect(listener).toHaveBeenCalledTimes(3)
  })
})
