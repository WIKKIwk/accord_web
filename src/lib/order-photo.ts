import type { ResourceKind, Row } from './api-types'
import { parseOrderImageReference, parsePendingImageReference, parseTemplateImageReference } from './order-images'
import type { OrderImageReference, PendingImageReference, TemplateImageReference } from './order-images'

export type OrderPhotoReference = { kind: 'production'; image: OrderImageReference } | { kind: 'template'; image: TemplateImageReference } | { kind: 'pending'; image: PendingImageReference }
/** Use a readable row label; an empty order number must not hide the template name. */
export function orderPhotoLabel(kind: ResourceKind, row: Row): string {
  const nested = row.template && typeof row.template === 'object' && !Array.isArray(row.template) ? row.template as Row : {}
  const candidates = kind === 'templates' ? [row.name, row.order_number, row.code, row.title, row.id] : [row.order_number, nested.order_number, row.order_id, row.id, row.title]
  for (const value of candidates) if (typeof value === 'string' && value.trim()) return value.trim()
  return 'Buyurtma'
}
export function orderPhotoReference(kind: ResourceKind, row: Row): OrderPhotoReference | null {
  if (kind === 'templates') { const image = parseTemplateImageReference(row); return image ? { kind: 'template', image } : null }
  if (kind === 'pending') { const image = parsePendingImageReference(row); return image ? { kind: 'pending', image } : null }
  const source = ['completed', 'closed'].includes(kind) ? { id: row.order_id, image_id: row.image_id } : row
  if (!['orders', 'maps', 'closed', 'completed'].includes(kind)) return null
  const image = parseOrderImageReference(source); return image ? { kind: 'production', image } : null
}
export const orderPhotoKey = (photo: OrderPhotoReference): string => JSON.stringify(photo.kind === 'production' ? [photo.kind, photo.image.order_id, photo.image.image_id ?? ''] : photo.kind === 'template' ? [photo.kind, photo.image.image_id] : [photo.kind, photo.image.id])
