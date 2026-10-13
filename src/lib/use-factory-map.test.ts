import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { ProductionSnapshot, Row } from './api-types'
import { FactoryMapStore, loadFactoryPages, saveFactoryPlacement } from './use-factory-map'

const base = '/v1/mobile/admin'
const apparatusId = 'apparatus:default:asset-1'
function machine(objectId = '', revision = 4): Row {
  return { apparatus_id: apparatusId, display: { display_name: 'Bosma' }, lifecycle: { state: 'active' }, source_revision: revision, placement: objectId ? { factory_map_object_id: objectId } : null }
}
function snapshot(rev = 1, epoch = 'one'): ProductionSnapshot {
  return { ok: true, rev, epoch, scope: 'admin', maps: [], order_statuses: {}, order_customers: {}, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {} }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}
function fakeClient(request = vi.fn(async (path: string) => path === `${base}/apparatus` ? [machine()] : []), productionSnapshot = vi.fn(async () => snapshot())): ApiClient {
  return { request, productionSnapshot } as unknown as ApiClient
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('factory map placement compare-and-swap', () => {
  function server(write: (body: Row) => Promise<unknown>, current: () => Row = () => machine()) {
    const request = vi.fn(async (path: string, method: string, options: { body?: Row; headers?: Record<string, string> }) => {
      if (method === 'PATCH') return write(options.body!)
      if (path === `${base}/apparatus`) return [current()]
      if (path === `${base}/apparatus/${encodeURIComponent(apparatusId)}`) return current()
      throw new Error(`Unexpected ${method} ${path}`)
    })
    return { client: fakeClient(request as never), request }
  }

  it('writes only native placement with the freshly read revision and an idempotency key', async () => {
    const { client, request } = server(async () => machine('node:39', 6), () => machine('', 5))
    const published = vi.fn()
    const result = await saveFactoryPlacement(client, machine('', 4), 'node:33', new AbortController().signal, published)
    expect(result).toEqual(machine('node:39', 6))
    const patch = request.mock.calls.find(call => call[1] === 'PATCH')!
    expect(patch[2].body).toEqual({ expected_revision: 5, patch: { placement: { factory_map_object_id: 'node:39' } } })
    expect(patch[2].headers?.['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    expect(published.mock.lastCall?.[0]).toEqual([machine('node:39', 6)])
  })

  it('clears only placement and leaves apparatus profile and queue fields intact', async () => {
    const { client, request } = server(async () => machine('', 5), () => machine('node:20'))
    await saveFactoryPlacement(client, machine('node:20'), '', new AbortController().signal)
    expect(request.mock.calls.find(call => call[1] === 'PATCH')?.[2].body).toEqual({ expected_revision: 4, patch: { placement: null } })
  })

  it('accepts readback of a committed mutation after a lost response without sending it again', async () => {
    let current = machine()
    const { client, request } = server(async () => { current = machine('node:18:instance:0', 5); throw new ApiError(0, 'network') }, () => current)
    expect(await saveFactoryPlacement(client, machine(), 'node:18:instance:0', new AbortController().signal)).toEqual(current)
    expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1)
  })

  it('retries an unrelated revision conflict once with a fresh revision and a new key', async () => {
    let current = machine()
    let writes = 0
    const { client, request } = server(async () => {
      if (++writes === 1) { current = machine('', 8); throw new ApiError(409, 'apparatus_revision_conflict') }
      return machine('node:20', 9)
    }, () => current)
    await saveFactoryPlacement(client, machine(), 'node:20', new AbortController().signal)
    const patches = request.mock.calls.filter(call => call[1] === 'PATCH')
    expect(patches.map(call => call[2].body?.expected_revision)).toEqual([4, 8])
    expect(patches[0][2].headers?.['Idempotency-Key']).not.toEqual(patches[1][2].headers?.['Idempotency-Key'])
  })

  it('does not replace another administrator’s changed placement after a revision conflict', async () => {
    let current = machine()
    const { client, request } = server(async () => { current = machine('node:7', 5); throw new ApiError(409, 'apparatus_revision_conflict') }, () => current)
    await expect(saveFactoryPlacement(client, machine(), 'node:20', new AbortController().signal)).rejects.toThrow('boshqa joyda o‘zgartirilgan')
    expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1)
  })

  it('does not automatically retry a network failure that readback confirms was not applied', async () => {
    const { client, request } = server(async () => { throw new ApiError(0, 'network') })
    await expect(saveFactoryPlacement(client, machine(), 'node:20', new AbortController().signal)).rejects.toMatchObject({ code: 'network' })
    expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1)
  })

  it('treats already applied placement as success without a second mutation', async () => {
    const { client, request } = server(async () => { throw new Error('Must not write') }, () => machine('node:20', 8))
    await saveFactoryPlacement(client, machine(), 'node:20:instance:3', new AbortController().signal)
    expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(0)
  })

  it('reports an uncertain result when the write response and authoritative readback are both lost', async () => {
    let writing = false
    const request = vi.fn(async (path: string, method: string) => {
      if (method === 'PATCH') { writing = true; throw new ApiError(0, 'network') }
      if (writing) throw new ApiError(0, 'network')
      return path === `${base}/apparatus` ? [machine()] : machine()
    })
    await expect(saveFactoryPlacement(fakeClient(request as never), machine(), 'node:20', new AbortController().signal)).rejects.toThrow('Biriktirish natijasi aniq emas')
    expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1)
  })
})

describe('factory inventory pagination', () => {
  it('loads every native raw material page without interpreting kg as a roll count', async () => {
    const request = vi.fn(async (_path: string, _method: string, options: { query: Row }) => options.query.offset === 0 ? [{ asset_ref: 'a', qty: 900 }, { asset_ref: 'b', qty: 300 }] : [{ asset_ref: 'c', qty: 50 }])
    const result = await loadFactoryPages(fakeClient(request as never), `${base}/inventory/assets`, 2, 'asset_ref', new AbortController().signal, { asset_kind: 'raw_material', current_user_states_only: true })
    expect(result.map(row => row.asset_ref)).toEqual(['a', 'b', 'c'])
    expect(request.mock.calls.map(call => call[2].query)).toEqual([
      { asset_kind: 'raw_material', current_user_states_only: true, offset: 0, limit: 2 },
      { asset_kind: 'raw_material', current_user_states_only: true, offset: 2, limit: 2 },
    ])
  })

  it('rejects repeating pagination rather than publishing a partial inventory count', async () => {
    const request = vi.fn(async () => [{ asset_ref: 'a' }, { asset_ref: 'b' }])
    await expect(loadFactoryPages(fakeClient(request as never), `${base}/inventory/assets`, 2, 'asset_ref', new AbortController().signal)).rejects.toThrow('Ro‘yxat yuklanayotganda o‘zgardi')
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('visible factory polling lifecycle', () => {
  it('polls production every fifteen seconds while an independent inventory request is slow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const stock = deferred<Row[]>()
    const request = vi.fn(async (path: string) => path === `${base}/inventory/assets` ? stock.promise : path === `${base}/apparatus` ? [machine()] : [])
    const production = vi.fn(async () => snapshot())
    const store = new FactoryMapStore(fakeClient(request as never, production), false, 'one')
    store.start()
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ loading: false, fresh: true, stockFresh: false })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(production).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.filter(call => call[0] === `${base}/inventory/assets`)).toHaveLength(1)
    store.stop()
    stock.resolve([])
  })

  it('expires a previously fresh state after thirty seconds even while the next request hangs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const hanging = deferred<ProductionSnapshot>()
    const production = vi.fn().mockResolvedValueOnce(snapshot()).mockImplementation(() => hanging.promise)
    const store = new FactoryMapStore(fakeClient(undefined, production), false, 'one')
    store.start()
    await store.refresh()
    expect(store.getSnapshot().fresh).toBe(true)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(store.getSnapshot().fresh).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getSnapshot().fresh).toBe(false)
    expect(production).toHaveBeenCalledTimes(2)
    store.stop()
    hanging.resolve(snapshot(2))
  })

  it('cancels hidden-page reads, ignores late results and refreshes when visible again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const late = deferred<ProductionSnapshot>()
    let firstSignal: AbortSignal | undefined
    const production = vi.fn().mockImplementationOnce((signal: AbortSignal) => { firstSignal = signal; return late.promise }).mockResolvedValue(snapshot(3))
    const store = new FactoryMapStore(fakeClient(undefined, production), false, 'one')
    store.start()
    store.setVisible(false)
    expect(firstSignal?.aborted).toBe(true)
    late.resolve(snapshot(100))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(production).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ snapshot: null, fresh: false, stockFresh: false })
    store.setVisible(true)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ snapshot: { rev: 3 }, fresh: true })
    store.stop()
  })

  it('does not overwrite newer revisions or return to a retired server epoch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const production = vi.fn().mockResolvedValueOnce(snapshot(5)).mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(1, 'two')).mockResolvedValueOnce(snapshot(100, 'one'))
    const store = new FactoryMapStore(fakeClient(undefined, production), false, 'one')
    store.start()
    await store.refresh()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot().snapshot?.rev).toBe(5)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot().snapshot).toMatchObject({ rev: 1, epoch: 'two' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot().snapshot).toMatchObject({ rev: 1, epoch: 'two' })
    store.stop()
  })

  it('expires stock independently and never replaces complete stock with a failed partial refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    let inventoryCalls = 0
    const request = vi.fn(async (path: string) => {
      if (path === `${base}/apparatus`) return [machine()]
      if (path === `${base}/inventory/assets` && ++inventoryCalls > 1) throw new ApiError(503, 'unavailable')
      return []
    })
    const store = new FactoryMapStore(fakeClient(request as never), false, 'one')
    store.start()
    await store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    const complete = store.getSnapshot().stockStateData
    expect(store.getSnapshot().stockFresh).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getSnapshot()).toMatchObject({ stockFresh: false, fresh: true })
    expect(store.getSnapshot().stockStateData).toBe(complete)
    store.stop()
  })

  it('keeps demo placement in the preview session RAM across navigation and resets on a new scope', async () => {
    const first = new FactoryMapStore(null, true, 'demo:polling-test-one')
    first.start()
    await first.refresh()
    const observed = first.getSnapshot().apparatusRows[0]
    await first.savePlacement(observed, '')
    first.stop()
    const returned = new FactoryMapStore(null, true, 'demo:polling-test-one')
    returned.start()
    await returned.refresh()
    expect(returned.getSnapshot().apparatusRows[0].placement).toBeNull()
    returned.stop()
    const newScope = new FactoryMapStore(null, true, 'demo:polling-test-two')
    newScope.start()
    await newScope.refresh()
    expect(newScope.getSnapshot().apparatusRows[0].placement).not.toBeNull()
    newScope.stop()
  })

  it('does not let an older polling list overwrite a newly saved apparatus placement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const oldList = deferred<Row[]>()
    let listCalls = 0
    const request = vi.fn(async (path: string, method: string) => {
      if (method === 'PATCH') return machine('node:20', 5)
      if (path === `${base}/apparatus`) return ++listCalls === 2 ? oldList.promise : [machine()]
      if (path === `${base}/apparatus/${encodeURIComponent(apparatusId)}`) return machine()
      return []
    })
    const store = new FactoryMapStore(fakeClient(request as never), false, 'one')
    store.start()
    await store.refresh()
    const pending = store.refresh()
    await store.savePlacement(machine(), 'node:20')
    oldList.resolve([machine()])
    await pending
    expect(store.getSnapshot().apparatusRows).toEqual([machine('node:20', 5)])
    store.stop()
  })

  it('aborts a mutation on unmount and prevents a late reply from changing retired page state', async () => {
    const written = deferred<Row>()
    let writeSignal: AbortSignal | undefined
    const request = vi.fn(async (path: string, method: string, options: { signal: AbortSignal }) => {
      if (method === 'PATCH') { writeSignal = options.signal; return written.promise }
      if (path === `${base}/apparatus`) return [machine()]
      if (path === `${base}/apparatus/${encodeURIComponent(apparatusId)}`) return machine()
      return []
    })
    const store = new FactoryMapStore(fakeClient(request as never), false, 'one')
    store.start()
    await store.refresh()
    const saving = store.savePlacement(machine(), 'node:20')
    // Allow both preflight reads to finish and the PATCH to begin.
    await new Promise(resolve => setTimeout(resolve, 0))
    store.stop()
    expect(writeSignal?.aborted).toBe(true)
    written.resolve(machine('node:20', 5))
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.getSnapshot().apparatusRows).toEqual([machine()])
  })
})
