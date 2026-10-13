import { ApiClient, ApiError, isRecord, record } from './api'
import type { Row } from './api-types'

const base = '/v1/mobile/admin/production-maps'
const invalid = (message: string): never => { throw new ApiError(502, 'invalid_response', message) }
const id = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** Retained history has no cursor, date range or total-count contract. */
export async function readManufacturingClosed(client: ApiClient, signal?: AbortSignal): Promise<Row[]> {
  const payload = record(await client.get(`${base}/closed-orders`, undefined, signal))
  if (payload.ok !== true || !Array.isArray(payload.closed_orders) || payload.closed_orders.length > 200) return invalid('Yopilgan buyurtmalar tarixi to‘liq shaklda kelmadi.')
  const entries = payload.closed_orders
  if (entries.some(row => !isRecord(row) || !id(row.order_id) || !Array.isArray(row.logs)) || new Set(entries.map(row => row.order_id)).size !== entries.length) return invalid('Tarixdagi buyurtma identifikatorlari yoki hodisalar mos kelmadi.')
  return entries
}

export async function readManufacturingMap(client: ApiClient, orderId: string, signal?: AbortSignal): Promise<Row> {
  if (!orderId.trim()) throw new Error('Buyurtmani tanlang.')
  const payload = record(await client.get(base, { id: orderId }, signal)), map = record(payload.map)
  if (map.id !== orderId || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) return invalid('Tarix uchun olingan xarita tanlangan buyurtmaga mos kelmadi.')
  return map
}

/** Native WIP response deliberately has no ok field; 500 is a cap, not a total. */
export async function readManufacturingBatches(client: ApiClient, orderId: string, signal?: AbortSignal): Promise<Row[]> {
  if (!orderId.trim()) throw new Error('Buyurtmani tanlang.')
  const payload = record(await client.get(`${base}/wip-batches`, { order_id: orderId, status: 'all', limit: 500 }, signal))
  if (!Array.isArray(payload.batches) || payload.batches.length > 500) return invalid('Buyurtma partiyalari to‘liq shaklda kelmadi.')
  const batches = payload.batches
  if (batches.some(row => !isRecord(row) || !id(row.batch_id) || row.order_id !== orderId) || new Set(batches.map(row => row.batch_id)).size !== batches.length) return invalid('Partiya tanlangan buyurtmaga mos kelmadi.')
  return batches
}

/** Semantic read POST. Never reprint, correct or infer an order from a roll title. */
export async function readManufacturingReport(client: ApiClient, orderId: string, batchId: string, signal?: AbortSignal): Promise<Row> {
  if (!orderId.trim() || !batchId.trim()) throw new Error('Buyurtma va partiyani tanlang.')
  const report = record(await client.post(`${base}/progress-qr/report`, { progress_batch_id: batchId }, signal)), batch = record(report.scanned_batch)
  if (report.ok !== true || report.history_scope !== 'batch_lineage' || typeof report.lineage_complete !== 'boolean' || batch.batch_id !== batchId || batch.order_id !== orderId || !Array.isArray(report.logs) || !Array.isArray(report.run_sessions) || !Array.isArray(report.progress_batches)) return invalid('Rulon tarixi tanlangan buyurtma va partiyaga mos kelmadi.')
  if (isRecord(report.order) && report.order.id !== orderId) return invalid('Rulon hisoboti boshqa buyurtma xaritasini qaytardi.')
  return report
}
