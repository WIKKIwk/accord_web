import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { OrderImageThumbnail } from './order-image-controls'
import { orderPhotoKey, orderPhotoLabel, orderPhotoReference } from '@/lib/order-photo'
vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const session: Session = { token: 'SYNTHETIC-IMAGE-SESSION', capabilities: ['admin.access'], profile: { role: 'admin', ref: 'qa-admin', display_name: 'QA Admin' }, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
function context({ capabilities = session.capabilities, demo = false } = {}) { vi.mocked(useSession).mockReturnValue({ client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), session: { ...session, capabilities }, scope: 'QA-IMAGE-SCOPE', demo } as ReturnType<typeof useSession>) }
beforeEach(() => { vi.restoreAllMocks(); context() })
describe('order-photo authority and lazy UI', () => {
  it('keeps blank-number templates and history labels specific', () => {
    expect(orderPhotoLabel('templates', { name: 'QA Flexo xaritasi', order_number: '', id: 'template-1' })).toBe('QA Flexo xaritasi')
    expect(orderPhotoLabel('pending', { id: 'pending-1', template: { order_number: '2001' } })).toBe('2001')
    expect(orderPhotoLabel('completed', { order_number: ' ', order_id: 'zakaz-history', id: 'event-1' })).toBe('zakaz-history')
    expect(orderPhotoLabel('orders', { order_number: 'qa-1001', id: 'zakaz-qa-1001' })).toBe('qa-1001')
  })
  it('uses exact native authority for production maps and legacy rows', () => {
    expect(orderPhotoReference('orders', { id: 'zakaz-123', image_url: 'https://outside.invalid/image' })).toEqual({ kind: 'production', image: { order_id: 'zakaz-123' } })
    expect(orderPhotoReference('maps', { map: { id: 'zakaz-123', image_id: 'qa_image' }, program: {} })).toEqual({ kind: 'production', image: { order_id: 'zakaz-123', image_id: 'qa_image' } })
    expect(orderPhotoReference('maps', { id: 'wrong', map: { id: 'real' } })).toBeNull()
  })
  it('uses completed/closed order_id instead of composite or event identity', () => {
    for (const kind of ['completed', 'closed'] as const) expect(orderPhotoReference(kind, { id: 'event-other', order_id: 'zakaz-history', apparatus: 'apparatus:qa:cut-1' })).toEqual({ kind: 'production', image: { order_id: 'zakaz-history' } })
  })
  it('keeps pending and owner-template authorities separate', () => {
    expect(orderPhotoReference('pending', { id: 'pending-1', template: { id: 'template-2', image_id: 'private' } })).toEqual({ kind: 'pending', image: { id: 'pending-1' } })
    expect(orderPhotoReference('templates', { id: 'template-2', image_id: 'private' })).toEqual({ kind: 'template', image: { image_id: 'private' } })
    expect(orderPhotoReference('templates', { id: 'template-2', image_url: 'https://outside.invalid/image' })).toBeNull()
    expect(orderPhotoReference('items', { id: 'not-order' })).toBeNull()
  })
  it('reserves fixed thumbnail geometry and exposes an accessible trigger without eager requests', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<OrderImageThumbnail photo={orderPhotoReference('orders', { id: 'zakaz-123' })} title="QA 123" />)
    expect(html).toContain('h-10 w-12'); expect(html).toContain('QA 123: rasmni kattalashtirish'); expect(html).toContain('data-image-state="idle"'); expect(html).not.toContain('<img'); expect(html).not.toContain(session.token); expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps pending full-image loading user-driven, without a thumbnail request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), photo = orderPhotoReference('pending', { id: 'pending-1' }); const html = renderToStaticMarkup(<OrderImageThumbnail photo={photo} title="QA Pending" />)
    expect(html).toContain('data-image-state="on-demand"'); expect(html).not.toContain('disabled=""'); expect(fetch).not.toHaveBeenCalled()
  })
  it('does not promote missing or denied images to an active viewer', () => {
    let html = renderToStaticMarkup(<OrderImageThumbnail photo={null} title="QA absent" />); expect(html).toContain('Rasm yo‘q'); expect(html).toContain('disabled=""')
    context({ capabilities: ['apparatus.queue.manage'] }); html = renderToStaticMarkup(<OrderImageThumbnail photo={orderPhotoReference('orders', { id: 'zakaz-123' })} title="QA denied" />)
    expect(html).toContain('data-image-state="denied"'); expect(html).toContain('disabled=""')
  })
  it('never sends demo images to an ERP', () => {
    context({ demo: true }); const fetch = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<OrderImageThumbnail photo={orderPhotoReference('orders', { id: 'zakaz-123' })} title="QA demo" />); expect(html).toContain('disabled=""'); expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps resource and version-hint caches distinct without claiming image immutability', () => {
    const one = orderPhotoReference('orders', { id: 'zakaz-1', image_id: 'one' })!, two = orderPhotoReference('orders', { id: 'zakaz-1', image_id: 'two' })!, template = orderPhotoReference('templates', { image_id: 'one' })!
    expect(orderPhotoKey(one)).not.toBe(orderPhotoKey(two)); expect(orderPhotoKey(one)).not.toBe(orderPhotoKey(template))
  })
})
