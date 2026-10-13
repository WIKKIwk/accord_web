import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ApiClient, ApiError } from '@/lib/api'
import type { CalculateOrderTemplate, Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { useProductionWorkflow } from '@/lib/production-workflow'
import { newOrderDraft } from '@/lib/order-draft'
import { CalculatorManagementApi, CalculatorSaveUnknown, CalculatorSourceConflict, calculatorMemory, calculatorMemoryKey, draftFromCalculatorTemplate, parseOpenedCalculation, parsePendingCalculation } from '@/lib/calculator-management'
import type { CalculatorMode, CalculatorSource } from '@/lib/calculator-management'
import { CalculatorManagementActions, CalculatorManagementNotice, useCalculatorDraftState } from './calculator-management-controls'
import type { CalculatorManagement } from './calculator-management-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
vi.mock('@/lib/production-workflow', () => ({ useProductionWorkflow: vi.fn() }))
const template: CalculateOrderTemplate = { id: 'template-a', code: 'Z-a', name: 'Shablon', product: 'Mahsulot', item_code: 'SKU-1', status: 'rulon', kg: 100, frame_product_size_mm: 50, frame_count: 4, edge_allowance_mm: 15, waste_percent: 5, roll_count: 4, source_map_id: 'template-map-a', layers: [{ material: 'BOPP', micron: '20' }], production_options: { print_method: 'metal', cold_glue: false } }
const order = parseOpenedCalculation({ map: { id: 'zakaz-0042', order_number: '0042', nodes: [], edges: [] }, template: { ...template, order_number: '0042' }, revision: 2 }, 'zakaz-0042')
const pending = parsePendingCalculation({ id: 'zakaz-9011', template: { ...template, id: 'pending-template', code: 'TG-9011', order_number: '9011' }, completion: null }, 'zakaz-9011')
let scopeCount = 0
let fixtureIdentity: ReturnType<typeof useSession> | null = null
function session(capabilities = ['admin.access'], demo = false) {
  const session: Session = { token: 'fixture-session', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  const scope = `fixture-${++scopeCount}`, client = new ApiClient({ endpoint: 'https://erp.example.test', token: 'fixture-session' })
  fixtureIdentity = { session, scope, client, demo, endpoint: 'https://erp.example.test', restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() }
  vi.mocked(useSession).mockReturnValue(fixtureIdentity)
  calculatorMemory.activate(scope)
  return { session, scope, client, demo }
}
function management(source: CalculatorSource | null = null, error: unknown = null): CalculatorManagement {
  if (!fixtureIdentity) throw new Error('Initialize the synthetic session before building management controls')
  const identity = fixtureIdentity
  return { api: new CalculatorManagementApi(identity.client!, identity.session!), source, error, pending: false, demo: identity.demo, allowed: identity.session!.capabilities.some(cap => cap === 'admin.access' || cap === 'production.map.manage'), setError: vi.fn(), run: vi.fn(), reload: vi.fn(), clearAutomatic: vi.fn(), loadError: null, loading: false }
}
function render(children: ReactNode) { return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>) }
function actions(mode: CalculatorMode, source: CalculatorSource | null, error: unknown = null, result = true) {
  return render(<CalculatorManagementActions mode={mode} management={management(source, error)} result={result ? { width_mm: 215 } : null} prepareTemplate={() => template} productName="Mahsulot" busy={false} onSaved={vi.fn()} />)
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('calculator management actions and interruption notices', () => {
  it('offers only revisioned calculation save for an existing order', () => {
    session()
    const html = actions({ kind: 'order', id: 'zakaz-0042' }, { kind: 'order', order, template: order.template })
    expect(html).toContain('Buyurtma tahririni saqlash')
    expect(html).not.toContain('Shablon sifatida saqlash')
    expect(html).not.toContain('Shablonni o‘chirish')
    expect(actions({ kind: 'order', id: 'zakaz-0042' }, { kind: 'order', order, template: order.template }, null, false)).toContain('disabled=""')
  })

  it('separates explicit template update/delete from template reuse and new-order creation', () => {
    session()
    const source: CalculatorSource = { kind: 'template', template, templates: [template] }
    const edit = actions({ kind: 'template', id: 'template-a', edit: true }, source)
    expect(edit).toContain('Shablonni yangilash'); expect(edit).toContain('Shablonni o‘chirish'); expect(edit).not.toContain('Shablon xaritasidan buyurtma ochish')
    const reuse = actions({ kind: 'template', id: 'template-a', edit: false }, source)
    expect(reuse).toContain('Shablon sifatida saqlash'); expect(reuse).toContain('Shablon xaritasidan buyurtma ochish'); expect(reuse).not.toContain('Shablonni o‘chirish')
  })

  it('uses pending release and shows a read link after native completion', () => {
    session()
    const source: CalculatorSource = { kind: 'pending', pending, template: pending.template }
    const html = actions({ kind: 'pending', id: 'zakaz-9011' }, source)
    expect(html).toContain('Ishlab chiqarishga chiqarish'); expect(html).not.toContain('Avtomatik buyurtma'); expect(html).not.toContain('Shablon sifatida saqlash')
    const done = actions({ kind: 'pending', id: 'zakaz-9011' }, { ...source, pending: { ...pending, completion: { saved: { map: { id: 'zakaz-9011' } }, template: pending.template } } })
    expect(done).toContain('Ochilgan buyurtmani ko‘rish'); expect(done).toContain('/app/orders?selected=zakaz-9011'); expect(done).not.toContain('<button')
  })

  it('blocks every management write for demo or missing capabilities, and for conflicts or uncertain saves', () => {
    for (const setup of [{ caps: [], demo: false }, { caps: ['admin.access'], demo: true }]) {
      session(setup.caps, setup.demo)
      const html = actions({ kind: 'template', id: 'template-a', edit: true }, { kind: 'template', template, templates: [template] })
      expect((html.match(/<button/g) ?? []).length).toBe((html.match(/disabled=""/g) ?? []).length)
    }
    session()
    for (const error of [new CalculatorSourceConflict(), new ApiError(409, 'conflict'), new CalculatorSaveUnknown({ kind: 'automatic-open', template })]) expect(actions({ kind: 'new' }, null, error)).toContain('disabled=""')
  })

  it('never offers read recovery for an unkeyed order open but does offer native pending completion recovery', () => {
    session()
    for (const kind of ['automatic-open', 'template-open'] as const) {
      const html = render(<CalculatorManagementNotice management={management(null, new CalculatorSaveUnknown({ kind, template }))} onSaved={vi.fn()} />)
      expect(html).toContain('/app/orders'); expect(html).toContain('Ro‘yxatni tekshirish'); expect(html).not.toContain('Saqlangan holatni tekshirish')
    }
    const html = render(<CalculatorManagementNotice management={management(null, new CalculatorSaveUnknown({ kind: 'pending-release', pending, template: pending.template }))} onSaved={vi.fn()} />)
    expect(html).toContain('Saqlangan holatni tekshirish')
  })

  it('shows stale-source reload and safe 403 explanations without internal response strings', () => {
    session()
    expect(render(<CalculatorManagementNotice management={management(null, new CalculatorSourceConflict())} onSaved={vi.fn()} />)).toContain('Joriy nusxani yuklash')
    const html = render(<CalculatorManagementNotice management={management(null, new ApiError(403, 'private_internal_guard'))} onSaved={vi.fn()} />)
    expect(html).toContain('ruxsat yetarli emas'); expect(html).not.toContain('private_internal_guard')
  })

  it('preserves a managed draft without reading or changing the unfinished shared new order', () => {
    const identity = session(), mode: CalculatorMode = { kind: 'template', id: 'template-a', edit: false }
    const shared = { draft: { ...newOrderDraft(), product: 'Unfinished new order' }, setDraft: vi.fn(), selectedMaterials: {}, setSelectedMaterials: vi.fn(), calculated: null, setCalculated: vi.fn(), map: null, setMap: vi.fn(), mapSignature: '', setMapSignature: vi.fn(), localImage: '', setLocalImage: vi.fn(), uncertain: false, setUncertain: vi.fn(), existingMapDrafts: {}, setExistingMapDrafts: vi.fn(), reset: vi.fn() }
    vi.mocked(useProductionWorkflow).mockReturnValue(shared)
    calculatorMemory.patch(identity.scope, calculatorMemoryKey(mode), { draft: { ...draftFromCalculatorTemplate(template, true), kg: '175' } })
    function Observer({ mode }: { mode: CalculatorMode }) { const state = useCalculatorDraftState(mode); return <p>{state.draft.product}:{state.draft.kg}:{String(state.retainedDraft)}</p> }
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(render(<Observer mode={mode} />)).toContain('Mahsulot:175:true')
    expect(render(<Observer mode={{ kind: 'new' }} />)).toContain('Unfinished new order::false')
    expect(shared.setDraft).not.toHaveBeenCalled(); expect(shared.reset).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
})
