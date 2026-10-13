import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { materialIntakeAttempts } from '@/lib/material-intake'
import type { MaterialIntakeCommand } from '@/lib/material-intake'
import { productionOperationLedger } from '@/lib/production-operation-ledger'
import { useSession } from '@/lib/session'
import { MaterialIntakeControls } from './material-intake-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const scope = 'material-ui-scope', orderId = 'order:material-ui', machine = 'apparatus:default:printer-1'
const retained: MaterialIntakeCommand = { action: 'intake', orderId, apparatusId: machine, stageNodeId: 'work', authScope: scope, epoch: 'fixture', scope: '', rev: 1, fingerprint: 'frozen-native-context', sourceRevision: 3, sourceHash: 'a'.repeat(64), actor: { role: 'admin', ref: 'fixture-admin' }, key: 'local-intake-correlation',
  stock: { barcode: 'RAW-RETAINED', warehouse: 'Main', item_code: 'FILM', qty: 20, uom: 'kg', source_receipt_id: 'actual-receipt' },
  baseline: { order_id: orderId, apparatus_id: machine, barcode: 'RAW-RETAINED', item_code: 'FILM', item_name: 'Real PET', item_group: 'Rulon', assigned_at: '2026-10-13T14:00:00Z', assigned_by_role: 'werka', assigned_by_ref: 'original', stock_status: 'available', execution_status: 'ready', stock_warehouse: 'Main', stock_uom: 'kg', stock_qty: 20, received_qty: 0, consumed_qty: 0, remaining_qty: 0, roll_width_mm: null, reserved_order_id: '' },
  body: { order_id: orderId, apparatus: machine, barcode: 'RAW-RETAINED' },
}
function actor(capabilities = ['admin.access', 'apparatus.queue.manage'], currentScope = scope, demo = false) {
  const session: Session = { token: 'local-ui-test', profile: { role: 'admin', ref: 'fixture-admin', display_name: 'Fixture' }, capabilities, assigned_apparatus: [machine], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: ['Main'] }
  vi.mocked(useSession).mockReturnValue({ session, scope: currentScope, demo, endpoint: 'http://127.0.0.1:5199', client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: session.token }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  materialIntakeAttempts.activate(currentScope)
}
const render = (row = { id: orderId }, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) => renderToStaticMarkup(<QueryClientProvider client={queryClient}><MaterialIntakeControls row={row} /></QueryClientProvider>)
afterEach(() => { materialIntakeAttempts.activate('reset-material-ui'); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('material intake entry permission and shared order ownership', () => {
  it('requires strict queue.manage and a native order identity without reading unauthorized data', () => {
    actor(['admin.access', 'raw_material.assign'])
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(render()).toContain('apparatus.queue.manage ruxsati kerak')
    actor()
    expect(render({ id: '' })).toContain('haqiqiy identifikatori kerak')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps demo and training material flows unavailable and makes no request before opening', () => {
    actor(undefined, scope, true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>/)
    expect(render()).toContain('Ko‘rish rejimida material qabuli')
    actor()
    expect(render({ id: 'training-order-1' })).toContain('alohida operator oqimida')
    render(); expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the owner of a blocked same-order flow and retains exact interrupted material context', () => {
    actor()
    productionOperationLedger.begin(scope, { channel: 'assignment', orderId, plan: { action: 'start' }, proof: {} })
    expect(render()).toContain('avvalgi ishlab chiqarish amali bor')
    materialIntakeAttempts.activate('temporary-other-scope'); actor()
    const lease = materialIntakeAttempts.begin(scope, retained)
    productionOperationLedger.dispatched(lease); materialIntakeAttempts.interrupt(lease)
    const html = render()
    expect(html).toContain('Avvalgi material so‘rovi saqlangan')
    expect(html).toContain('RAW-RETAINED')
    expect(html).toContain('Yangi amal qulflangan')
    expect(materialIntakeAttempts.get(scope, orderId)?.plan.body).toEqual(retained.body)
    actor(undefined, 'new-auth-scope')
    expect(render()).not.toContain('RAW-RETAINED')
    expect(materialIntakeAttempts.get(scope, orderId)).toBeNull()
  })
})
