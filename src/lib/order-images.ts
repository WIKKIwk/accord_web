import { ApiClient, ApiError, isRecord } from './api'
import type { BinaryRequestOptions } from './api'
import type { Query, Session } from './api-types'
import { hasCapability } from './permissions'

export const orderImagePath = '/v1/mobile/admin/production-maps/order-image/view'
export const templateImagePath = '/v1/mobile/calculate/orders/image/view'
export const pendingImagePath = '/v1/mobile/admin/pending-orders/image'
export type OrderImageVariant = 'thumb-v1' | 'full'
/** An optional image_id changes a client version key only; native resolution still belongs to order_id. */
export interface OrderImageReference { order_id: string; image_id?: string }
export interface TemplateImageReference { image_id: string }
export interface PendingImageReference { id: string }
export type OrderImageMime = 'image/jpeg' | 'image/png' | 'image/webp'
export type OrderImageResult =
  | { kind: 'image'; blob: Blob; mime: OrderImageMime; etag?: string; cache_control?: string; vary?: string }
  | { kind: 'missing'; reason: 'no_image' | 'order_missing' | 'route_unavailable' | 'unknown'; code: string }
export const orderThumbnailMaxBytes = 1024 * 1024
export const orderFullImageMaxBytes = 8 * 1024 * 1024

const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase())
const nonempty = (value: unknown): string | null => typeof value === 'string' && nativeTrim(value) ? nativeTrim(value) : null
const safeImageId = (value: unknown): string | null => { const id = nonempty(value); return id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null }
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Serverdan kutilgan rasm baytlari kelmadi.') }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
export function canReadOrderImages(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'raw_material.assign', 'qolip.manage', 'preparation.access'].some(code => hasCapability(session, code))
}
export function canReadTemplateImages(session: Session | null | undefined): boolean {
  return ['admin.access', 'production.map.manage'].some(code => hasCapability(session, code))
}
export function canReadPendingImages(session: Session | null | undefined): boolean { return canReadTemplateImages(session) }
/** Production authority is the raw map ID, including legacy maps without photo metadata. */
export function parseOrderImageReference(value: unknown): OrderImageReference | null {
  if (!isRecord(value)) return null
  const row = Object.hasOwn(value, 'map') ? isRecord(value.map) ? value.map : null : value
  if (!row) return null
  const id = nonempty(row.id)
  if (!id) return null
  // Flattened map rows and saved {map} rows are supported; conflicting outer identity is ambiguous.
  const outer = row !== value ? nonempty(value.id) : null
  if (outer && asciiLower(outer) !== asciiLower(id)) return null
  const image_id = safeImageId(row.image_id)
  return Object.freeze({ order_id: asciiLower(id), ...(image_id ? { image_id } : {}) })
}
/** Owner-scoped calculate-template images have their own native ID and permission contract. */
export function parseTemplateImageReference(value: unknown): TemplateImageReference | null {
  if (!isRecord(value) || Object.hasOwn(value, 'map')) return null
  const row = Object.hasOwn(value, 'template') ? isRecord(value.template) ? value.template : null : value
  const image_id = row && safeImageId(row.image_id)
  return image_id ? Object.freeze({ image_id }) : null
}
/** Pending images use the outer pending record, never its nested template's identity. */
export function parsePendingImageReference(value: unknown): PendingImageReference | null {
  if (!isRecord(value)) return null
  const id = nonempty(value.id); return id ? Object.freeze({ id }) : null
}
export function orderImageRequest(reference: OrderImageReference, variant: OrderImageVariant = 'thumb-v1'): { path: string; query: Query } {
  const parsed = parseOrderImageReference({ id: reference.order_id, image_id: reference.image_id })
  if (!parsed || !['thumb-v1', 'full'].includes(variant)) throw new Error('Buyurtmaning server ID sini tanlang.')
  return { path: orderImagePath, query: { order_id: parsed.order_id, ...(parsed.image_id ? { image_id: parsed.image_id } : {}), ...(variant === 'thumb-v1' ? { variant } : {}) } }
}
function missing(error: ApiError): OrderImageResult {
  const reason = error.code === 'rasm topilmadi' || error.code === 'not_found' ? 'no_image'
    : error.code === 'order topilmadi' || error.code === 'pending_order_not_found' ? 'order_missing'
      : error.code === 'http_404' ? 'route_unavailable' : 'unknown'
  return { kind: 'missing', reason, code: error.code }
}
function mime(value: string): OrderImageMime {
  if (value === 'image/jpg') return 'image/jpeg'
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(value)) return invalid()
  return value as OrderImageMime
}
async function raster(blob: Blob, type: OrderImageMime, signal?: AbortSignal): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer()); abort(signal)
  const matches = type === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : type === 'image/png' ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      : bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!matches) return invalid()
  // Browser decoding remains necessary; a raster signature does not prove source pixels or dimensions.
}

/** Read-only native routes. No external assets, image-ID authority, private production fallback or full-image prefetch. */
export class OrderImagesApi {
  private readonly client: ApiClient
  private readonly session: Session
  constructor(client: ApiClient, session: Session) { this.client = client; this.session = session }
  private require(allowed: boolean): void { if (!allowed) throw new ApiError(403, 'forbidden') }
  private async read(path: string, query: Query, thumbnail: boolean, signal?: AbortSignal): Promise<OrderImageResult> {
    abort(signal)
    const options: BinaryRequestOptions = { query, signal, maxBytes: thumbnail ? orderThumbnailMaxBytes : orderFullImageMaxBytes }
    try {
      const result = await this.client.getBinary(path, options); abort(signal)
      if (result.status !== 200) return invalid()
      const type = mime(result.mime)
      if (thumbnail && type !== 'image/webp') return invalid()
      await raster(result.blob, type, signal); abort(signal)
      return { kind: 'image', blob: result.blob, mime: type, ...(result.etag ? { etag: result.etag } : {}), ...(result.cache_control ? { cache_control: result.cache_control } : {}), ...(result.vary ? { vary: result.vary } : {}) }
    } catch (error) {
      abort(signal)
      if (error instanceof ApiError && error.status === 404) return missing(error)
      throw error
    }
  }
  async thumbnail(reference: OrderImageReference, signal?: AbortSignal): Promise<OrderImageResult> {
    this.require(canReadOrderImages(this.session)); const request = orderImageRequest(reference, 'thumb-v1')
    return this.read(request.path, request.query, true, signal)
  }
  async full(reference: OrderImageReference, signal?: AbortSignal): Promise<OrderImageResult> {
    this.require(canReadOrderImages(this.session)); const request = orderImageRequest(reference, 'full')
    return this.read(request.path, request.query, false, signal)
  }
  async templateThumbnail(reference: TemplateImageReference, signal?: AbortSignal): Promise<OrderImageResult> {
    this.require(canReadTemplateImages(this.session)); const id = safeImageId(reference.image_id)
    if (!id) throw new Error('Shablon rasmining server ID si noto‘g‘ri.')
    return this.read(templateImagePath, { id, variant: 'thumb-v1' }, true, signal)
  }
  async templateFull(reference: TemplateImageReference, signal?: AbortSignal): Promise<OrderImageResult> {
    this.require(canReadTemplateImages(this.session)); const id = safeImageId(reference.image_id)
    if (!id) throw new Error('Shablon rasmining server ID si noto‘g‘ri.')
    return this.read(templateImagePath, { id }, false, signal)
  }
  async pendingFull(reference: PendingImageReference, signal?: AbortSignal): Promise<OrderImageResult> {
    this.require(canReadPendingImages(this.session)); const id = nonempty(reference.id)
    if (!id) throw new Error('Kutilayotgan buyurtmaning server ID si noto‘g‘ri.')
    return this.read(pendingImagePath, { id }, false, signal)
  }
}
