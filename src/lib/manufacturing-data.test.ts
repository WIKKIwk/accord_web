import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import { readManufacturingBatches, readManufacturingClosed, readManufacturingMap, readManufacturingReport } from './manufacturing-data'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const client = () => new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'synthetic-session' })
function reply(body: unknown) { const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body))); vi.stubGlobal('fetch', fetch); return fetch }
const report = { ok: true, history_scope: 'batch_lineage', lineage_complete: true, scanned_batch: { batch_id: 'batch-1', order_id: 'order-1' }, order: { id: 'order-1' }, logs: [], run_sessions: [], progress_batches: [] }

describe('manufacturing history source boundaries', () => {
  it('reads the retained closed-order feed without inventing offset or total', async () => {
    const fetch = reply({ ok: true, closed_orders: [{ order_id: 'order-1', logs: [] }] })
    expect(await readManufacturingClosed(client())).toHaveLength(1)
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:5199/v1/mobile/admin/production-maps/closed-orders')
  })
  it('rejects duplicate or malformed closed-order identities before aggregation', async () => {
    reply({ ok: true, closed_orders: [{ order_id: 'order-1', logs: [] }, { order_id: 'order-1', logs: [] }] })
    await expect(readManufacturingClosed(client())).rejects.toMatchObject({ code: 'invalid_response' })
    reply({ ok: true, closed_orders: [{ order_id: 'order-1' }] })
    await expect(readManufacturingClosed(client())).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('requires the selected native map identity', async () => {
    reply({ map: { id: 'other-order', nodes: [], edges: [] } })
    await expect(readManufacturingMap(client(), 'order-1')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('honors native WIP envelope and 500 limit while including processed rolls', async () => {
    const fetch = reply({ batches: [{ batch_id: 'batch-1', order_id: 'order-1', wip_status: 'processed' }] })
    expect(await readManufacturingBatches(client(), 'order-1')).toHaveLength(1)
    const url = new URL(fetch.mock.calls[0][0])
    expect(Object.fromEntries(url.searchParams)).toEqual({ order_id: 'order-1', status: 'all', limit: '500' })
  })
  it('rejects cross-order and duplicate batches', async () => {
    reply({ batches: [{ batch_id: 'batch-1', order_id: 'other-order' }] })
    await expect(readManufacturingBatches(client(), 'order-1')).rejects.toMatchObject({ code: 'invalid_response' })
    reply({ batches: [{ batch_id: 'batch-1', order_id: 'order-1' }, { batch_id: 'batch-1', order_id: 'order-1' }] })
    await expect(readManufacturingBatches(client(), 'order-1')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('uses only the audited semantic read endpoint for one selected roll', async () => {
    const fetch = reply(report)
    expect(await readManufacturingReport(client(), 'order-1', 'batch-1')).toEqual(report)
    expect(fetch.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ progress_batch_id: 'batch-1' })
    expect(String(fetch.mock.calls[0][0])).toContain('/progress-qr/report')
  })
  it.each([
    { ...report, scanned_batch: { batch_id: 'other-batch', order_id: 'order-1' } },
    { ...report, scanned_batch: { batch_id: 'batch-1', order_id: 'other-order' } },
    { ...report, order: { id: 'other-order' } },
    { ...report, ok: undefined },
    { ...report, history_scope: 'order' },
    { ...report, lineage_complete: undefined },
  ])('rejects mismatched report identity/scope or incomplete success envelope', async value => {
    reply(value)
    await expect(readManufacturingReport(client(), 'order-1', 'batch-1')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('discards an aborted source read', async () => {
    const controller = new AbortController()
    reply(report); controller.abort()
    await expect(readManufacturingReport(client(), 'order-1', 'batch-1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
