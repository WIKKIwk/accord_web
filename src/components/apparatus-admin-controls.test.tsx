import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { ApparatusAdminControls, ApparatusAdminToolbar } from './apparatus-admin-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const apparatus: Row = { apparatus_id: 'apparatus:default:asset-001', physical_asset_id: 'physical-asset:001', lifecycle: { state: 'active', retirement_reason: null }, display: { display_name: 'Bosma 01' }, execution_profile: { operation: 'print' } }
function actor(capabilities = ['production.map.manage'], options: { demo?: boolean; role?: string; connection?: 'online' | 'offline' | 'checking' } = {}) {
  const session: Session = { token: 'fixture-token', profile: { role: options.role ?? 'admin', ref: 'fixture-admin', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo: options.demo ?? false, scope: 'apparatus-ui-fixture', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), restoring: false, connection: options.connection ?? 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
const render = (value: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{value}</QueryClientProvider>)
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('apparatus directory entry guards and honest lifecycle UI', () => {
  it('exposes actual canonical maintenance and creation actions with no reads or writes on render', () => {
    actor(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render(<><ApparatusAdminControls row={apparatus} /><ApparatusAdminToolbar /></>)
    for (const label of ['Apparatni tahrirlash', 'AASX faylidan yangilash', 'Foydalanishdan chiqarish', 'Apparat qo‘shish', 'physical-asset:001']) expect(html).toContain(label)
    expect(html).toContain('Bosma apparat navbat siyosati mobil qoidaga ko‘ra qulflangan')
    expect(html).not.toContain('type="file"'); expect(html).not.toContain('Apparat revisioni tasdiqlandi')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows read information while hiding mutations for broad native readers', () => {
    for (const capability of ['admin.access', 'apparatus.queue.read', 'preparation.access']) {
      actor([capability], { role: 'aparatchi' })
      const html = render(<><ApparatusAdminControls row={apparatus} /><ApparatusAdminToolbar /></>)
      expect(html).toContain('Apparat profili'); expect(html).toContain('apparatus:default:asset-001')
      expect(html).not.toContain('<button')
    }
  })

  it('uses actual capability rather than admin role labels and hides malformed identities', () => {
    actor([], { role: 'admin' })
    expect(render(<><ApparatusAdminControls row={apparatus} /><ApparatusAdminToolbar /></>)).toBe('')
    actor(['production.map.manage'], { role: 'aparatchi' })
    expect(render(<ApparatusAdminToolbar />)).toContain('Apparat qo‘shish')
    expect(render(<ApparatusAdminControls row={{ apparatus_id: 'Bosma 01' }} />)).toBe('')
    expect(render(<ApparatusAdminControls row={{ runtime_projection: apparatus, apparatus_id: 'apparatus:default:wrong' }} />)).toContain('apparatus:default:asset-001')
  })

  it('disables every demo or disconnected mutation entry', () => {
    for (const options of [{ demo: true }, { connection: 'offline' as const }, { connection: 'checking' as const }]) {
      actor(undefined, options); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
      const html = render(<><ApparatusAdminControls row={apparatus} /><ApparatusAdminToolbar /></>)
      expect((html.match(/<button/g) ?? []).length).toBe(4)
      expect((html.match(/disabled=""/g) ?? []).length).toBe(4)
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('shows final retirement and blocks profile/import/lifecycle actions without inventing restore or deletion', () => {
    actor()
    const html = render(<ApparatusAdminControls row={{ ...apparatus, lifecycle: { state: 'retired', retirement_reason: 'Eskirgan' } }} />)
    expect(html).toContain('Eskirgan'); expect(html).toContain('Qayta faol qilish amali mavjud emas')
    expect((html.match(/<button/g) ?? []).length).toBe(3)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3)
    expect(html).not.toContain('Qayta faol qilish</button>'); expect(html).not.toContain('O‘chirish')
  })

  it('blocks an unknown lifecycle and only states the printing lock for actual print operations', () => {
    actor()
    const html = render(<ApparatusAdminControls row={{ ...apparatus, lifecycle: {}, execution_profile: { operation: 'cut' } }} />)
    expect(html).toContain('Hayot sikli noma’lum')
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3)
    expect(html).not.toContain('Bosma apparat navbat siyosati')
  })
})
