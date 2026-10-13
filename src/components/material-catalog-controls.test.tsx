import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { MaterialCatalogControls, MaterialCatalogToolbar } from './material-catalog-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const material = { id: 'material-a', name: 'BOPP', active: true, density_g_cm3: 0.9, variants: [{ micron: 20, coefficient: 1.08 }] }
function actor(capabilities = ['admin.access'], demo = false) {
  const session: Session = { token: 'test-token', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo, scope: 'test-scope', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: 'test-token' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('material catalog maintenance entry points', () => {
  it('renders useful micron/GSM/coefficient detail and supported active-state controls', () => {
    actor()
    const html = renderToStaticMarkup(<MaterialCatalogControls row={material} />)
    expect(html).toContain('Mikronlar')
    expect(html).toContain('GSM, g/m²')
    expect(html).toContain('Koeffitsiyent')
    expect(html).toContain('Materialni tahrirlash')
    expect(html).toContain('Hisoblashda yashirish')
    expect(html).not.toContain('O‘chirish')
    expect(html).not.toContain('Hisoblashda ko‘rsatish')
  })

  it('shows restoration for hidden material and density-only empty-variant detail', () => {
    actor()
    const html = renderToStaticMarkup(<MaterialCatalogControls row={{ ...material, active: false, variants: [] }} />)
    expect(html).toContain('Hisoblashda ko‘rsatish')
    expect(html).toContain('Mikron variantlari yo‘q')
    expect(html).not.toContain('Hisoblashda yashirish')
  })

  it('keeps material/micron detail readable with production permission but exposes no mutation controls', () => {
    actor(['production.map.manage'])
    const html = renderToStaticMarkup(<MaterialCatalogControls row={material} />)
    expect(html).toContain('Koeffitsiyent')
    expect(html).not.toContain('<button')
    expect(renderToStaticMarkup(<MaterialCatalogToolbar />)).toBe('')
  })

  it('provides reachable material creation and whole-active-catalog sequencing', () => {
    actor()
    const html = renderToStaticMarkup(<MaterialCatalogToolbar />)
    expect(html).toContain('Material qo‘shish')
    expect(html).toContain('Tartibni o‘zgartirish')
  })

  it('disables demo writes and performs no mutation or catalog read while rendering', () => {
    actor(['admin.access'], true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const controls = renderToStaticMarkup(<MaterialCatalogControls row={material} />)
    const toolbar = renderToStaticMarkup(<MaterialCatalogToolbar />)
    for (const html of [controls, toolbar]) expect((html.match(/<button/g) ?? []).length).toBe((html.match(/disabled=""/g) ?? []).length)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not construct an editor from a malformed or unidentified material row', () => {
    actor()
    expect(renderToStaticMarkup(<MaterialCatalogControls row={{ name: 'BOPP' }} />)).toBe('')
    expect(renderToStaticMarkup(<MaterialCatalogControls row={{ ...material, id: '', variants: [] }} />)).toBe('')
  })
})
