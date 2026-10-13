import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { AdminIdentityControls, AdminRoleCreateButton } from './admin-identity-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const allCaps = ['admin.access', 'role.capability.read', 'role.capability.manage', 'catalog.item.read', 'catalog.item_group.read', 'party.customer.read', 'party.customer.manage', 'party.customer.code.manage']
function actor(capabilities: string[] = allCaps, demo = false, role = 'admin', ref = 'admin') {
  const session: Session = { token: 'test-token', profile: { role, ref, display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo, scope: 'test-scope', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: 'test-token' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('identity maintenance entry points', () => {
  it('shows only worker actions authorized by the exact resource capabilities', () => {
    actor(['admin.access'])
    const html = renderToStaticMarkup(<AdminIdentityControls kind="workers" row={{ id: 'worker_1', name: 'Ali', level: 'Master', code: 'SECRET-CODE' }} />)
    expect(html).toContain('Tahrirlash')
    expect(html).toContain('Kodni yangilash')
    expect(html).toContain('Faolsizlantirish')
    expect(html).not.toContain('Rol va ruxsat doirasi')
    expect(html).not.toContain('Omborlar')
    expect(html).not.toContain('SECRET-CODE')
  })

  it('provides the material group endpoint even when the operator cannot manage role packages', () => {
    actor(['admin.access', 'catalog.item_group.read', 'party.customer.read'])
    const html = renderToStaticMarkup(<AdminIdentityControls kind="users" row={{ principal_role: 'material_taminotchi', entity_ref: 'MAT-001', name: 'Hasan' }} />)
    expect(html).toContain('Mahsulot guruhlari')
    expect(html).not.toContain('Rol va ruxsat doirasi')
    expect(html).not.toContain('Kodni yangilash')
    expect(html).not.toContain('Tahrirlash')
  })

  it('exposes native system updates without inventing system-user removal or unsupported warehouse actions', () => {
    actor()
    const html = renderToStaticMarkup(<AdminIdentityControls kind="users" row={{ id: 'system_user:boyoqchi_1', principal_role: 'boyoqchi', entity_ref: 'boyoqchi_1', name: 'Vali' }} />)
    expect(html).toContain('Tahrirlash')
    expect(html).toContain('Rol va ruxsat doirasi')
    expect(html).toContain('Kodni yangilash')
    expect(html).not.toContain('Faolsizlantirish')
    expect(html).not.toContain('Omborlar')
  })

  it('renders no maintenance panel for protected and separately managed accounts', () => {
    actor()
    for (const role of ['admin', 'werka', 'supplier', 'customer']) expect(renderToStaticMarkup(<AdminIdentityControls kind="users" row={{ principal_role: role, entity_ref: role, name: role }} />)).toBe('')
  })

  it('does not let an operator deactivate themselves or replace their own role', () => {
    actor(allCaps, false, 'aparatchi', 'worker_1')
    const html = renderToStaticMarkup(<AdminIdentityControls kind="workers" row={{ id: 'worker_1', name: 'Ali', level: 'Brigader' }} />)
    expect(html).toContain('Tahrirlash')
    expect(html).not.toContain('Faolsizlantirish')
    expect(html).not.toContain('Rol va ruxsat doirasi')
  })

  it('keeps system roles protected and exposes custom-role maintenance only with read/manage permissions', () => {
    actor()
    const native = renderToStaticMarkup(<AdminIdentityControls kind="roles" row={{ id: 'admin', label: 'Admin', system: true, base_role: 'admin', capability_codes: ['admin.access'] }} />)
    expect(native).toContain('oldindan belgilangan')
    expect(native).not.toContain('<button')
    const custom = { id: 'quality', label: 'Sifat', system: false, capability_codes: ['catalog.item.read'] }
    expect(renderToStaticMarkup(<AdminIdentityControls kind="roles" row={custom} />)).toContain('Rolni tahrirlash')
    expect(renderToStaticMarkup(<AdminRoleCreateButton />)).toContain('Rol yaratish')
    actor(['admin.access', 'role.capability.read'])
    expect(renderToStaticMarkup(<AdminIdentityControls kind="roles" row={custom} />)).toBe('')
    expect(renderToStaticMarkup(<AdminRoleCreateButton />)).toBe('')
  })

  it('disables all maintenance in demo mode and never requests or rotates a code while rendering', () => {
    actor(allCaps, true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = renderToStaticMarkup(<AdminIdentityControls kind="workers" row={{ id: 'worker_1', name: 'Ali', level: 'Brigader' }} />)
    expect(html).toContain('Ko‘rish rejimida')
    expect((html.match(/<button/g) ?? []).length).toBe((html.match(/disabled=""/g) ?? []).length)
    expect(fetch).not.toHaveBeenCalled()
  })
})
