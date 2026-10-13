import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { materialRuleCommand, materialRuleDrafts } from '@/lib/raw-material-rules'
import type { MaterialRuleSnapshot } from '@/lib/raw-material-rules'
import { useSession } from '@/lib/session'
import { RawMaterialRuleToolbar } from './raw-material-rule-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const scope = 'raw-rule-ui-scope'
const snapshot: MaterialRuleSnapshot = {
  rule: { apparatus_id: 'apparatus:default:printer-1', source_revision: 3, source_aasx_sha256: '3'.repeat(64), policy: { mode: 'all_required', item_group_ids: ['PET'] }, tooling: { mode: 'not_required' } },
  apparatus: {}, name: 'Only this session apparatus', operation: 'print', active: true,
}
function actor(capabilities = ['raw_material.rule.manage', 'admin.access'], currentScope = scope, demo = false) {
  const session: Session = { token: 'local-ui-test', profile: { role: 'admin', ref: 'fixture-admin', display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, scope: currentScope, demo, endpoint: 'http://127.0.0.1:5199', client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  materialRuleDrafts.activate(currentScope)
  return session
}
function render(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><RawMaterialRuleToolbar /></QueryClientProvider>)
}
afterEach(() => { materialRuleDrafts.activate('reset-rule-ui-test'); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('raw rule toolbar native permission and interrupted entry state', () => {
  it('denies the admin role alone and keeps rule management independent of stock and assignment access', () => {
    actor(['admin.access', 'raw_material.assign', 'gscale.catalog.read'])
    expect(render()).toContain('raw_material.rule.manage ruxsati kerak')
    expect(render()).not.toContain('>Xomashyo qoidalari</button>')
    actor(['raw_material.rule.manage'])
    expect(render()).toContain('Xomashyo qoidalari')
    expect(render()).not.toContain('raw_material.rule.manage ruxsati kerak')
  })

  it('keeps demo read-only and makes no API call while the toolbar dialog is closed', () => {
    actor(undefined, scope, true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = render()
    expect(html).toContain('Ko‘rish rejimida qoidalar o‘zgartirilmaydi')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/)
    expect(fetch).not.toHaveBeenCalled()
    actor(); render(); expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the retained unresolved identity after dialog unmount but does not leak it to another session', () => {
    const session = actor(), command = materialRuleCommand(snapshot, { mode: 'not_required', groupIds: [], sets: [] }, session, [], 'retained-native-key')
    materialRuleDrafts.select(scope, snapshot)
    const lease = materialRuleDrafts.begin(scope, command)
    materialRuleDrafts.dispatched(lease); materialRuleDrafts.interrupt(lease)
    const html = render()
    expect(html).toContain('Avvalgi qoida saqlash natijasi aniqlanmagan')
    expect(html).toContain(snapshot.rule.apparatus_id)
    expect(html).toContain('Yangi amal qulflangan')
    expect(materialRuleDrafts.get(scope)?.command).toEqual(command)
    const queries = new QueryClient()
    queries.setQueryData(['raw-material-rules', scope, 'list'], [snapshot.rule])
    queries.setQueryData(['raw-material-rules', scope, 'snapshot', snapshot.rule.apparatus_id], snapshot)
    actor(undefined, 'other-auth-scope')
    const next = render(queries)
    expect(next).not.toContain(snapshot.rule.apparatus_id)
    expect(next).not.toContain('Avvalgi qoida saqlash natijasi aniqlanmagan')
    expect(materialRuleDrafts.get(scope)).toBeNull()
  })
})
