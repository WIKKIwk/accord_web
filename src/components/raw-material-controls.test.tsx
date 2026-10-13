import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient, ApiError } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { RawMaterialControls, OrderRawMaterialControls } from './raw-material-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const barcode = 'MAT-1'
const stock = { id: 'stock-1', barcode, warehouse: 'Raw', item_code: 'PET', item_name: 'PET', qty: 80, uom: 'kg', status: 'available', reserved_order_id: '', width_mm: 100, micron: 12 }
const assignment = { order_id: 'zakaz-1', barcode, apparatus_id: 'canonical-print', apparatus: 'Old display name', item_code: 'PET', item_name: 'PET', item_group: 'Rulon', assigned_at: '2026-10-13T10:00:00Z', assigned_by_display_name: 'Ali', stock_status: 'available', execution_status: 'awaiting_delivery', stock_warehouse: 'Raw', stock_uom: 'kg', stock_qty: 80, received_qty: 0, consumed_qty: 0, remaining_qty: 80, reserved_order_id: '' }
const order = { map: { id: 'zakaz-1', title: 'Packing order', code: 'O-001' }, program: {} }

function actor(capabilities = ['admin.access', 'raw_material.assign'], demo = false, scope = 'scope-one') {
  const session: Session = { token: 'local-test', profile: { role: 'admin', display_name: 'Fixture' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, scope, demo, endpoint: 'http://127.0.0.1:5199', client: new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'local-test' }), restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}

function queryCache({ linked = null, stockRows = [stock], scope = 'scope-one' }: { linked?: Row | null; stockRows?: Row[]; scope?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  queryClient.setQueryData(['raw-material-admin', scope, 'lookup', barcode], { ...stock, assignment: linked, order: linked ? order : null, queue_states: linked ? { 'canonical-print': { 'zakaz-1': 'queued' } } : {}, logs: [] })
  queryClient.setQueryData(['raw-material-admin', scope, 'stock', 'Raw'], stockRows)
  queryClient.setQueryData(['raw-material-admin', scope, 'candidate-orders', barcode], [{ order, apparatus_options: ['canonical-print'] }])
  queryClient.setQueryData(['raw-material-admin', scope, 'diagnostic', barcode, '', ''], { ...stock, compatible: true, reason: 'compatible', stock_status: 'available', order_id: 'zakaz-1', apparatus: 'canonical-print', apparatus_options: ['canonical-print'], order_width_mm: 100, roll_width_mm: 100, minimum_width_mm: 90, maximum_width_mm: 130 })
  queryClient.setQueryData(['raw-material-admin', scope, 'history', 'Raw', barcode], [])
  queryClient.setQueryData(['raw-material-admin', scope, 'order-assignments', 'zakaz-1'], linked ? [linked] : [])
  queryClient.setQueryData(['raw-material-admin', scope, 'order-candidates', 'zakaz-1'], [{ ...stock, apparatus_options: ['canonical-print'] }])
  return queryClient
}

function render(queryClient: QueryClient, row: Row = stock, mode: 'stock' | 'order' = 'stock') {
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{mode === 'stock' ? <RawMaterialControls row={row} /> : <OrderRawMaterialControls row={row} />}</QueryClientProvider>)
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('raw material controls integration surface', () => {
  it('shows actual stock identity, width, micron, server assignment status, actor and bounded history', () => {
    actor()
    const html = render(queryCache({ linked: assignment }))
    expect(html).toContain('stock-1')
    expect(html).toContain('100 mm / 12 µm')
    expect(html).toContain('canonical-print')
    expect(html).toContain('Packing order')
    expect(html).toContain('Yetkazish kutilmoqda')
    expect(html).toContain('Ali')
    expect(html).toContain('Apparat navbati: queued')
    expect(html).toContain('To‘liq tarix yoki umumiy son emas')
    expect(html).toContain('Bu cheklangan tarixda rulon hodisasi topilmadi')
    expect(html).toContain('Biriktirishni uzish')
  })

  it('does not turn admin.access into assignment permission', () => {
    actor(['admin.access'])
    const html = render(queryCache({ linked: assignment }))
    expect(html).toContain('Yetkazish kutilmoqda')
    expect(html).toContain('raw_material.assign ruxsati')
    expect(html).not.toContain('Biriktirishni uzish')
    expect(html).not.toContain('Buyurtmaga biriktirish')
  })

  it('shows an explicit assignment-read denial to catalog-only readers', () => {
    actor(['catalog.item.read'])
    const html = render(queryCache({ linked: assignment }))
    expect(html).toContain('Biriktirish holatini o‘qish uchun ruxsat berilmagan')
    expect(html).not.toContain('Packing order')
    expect(html).not.toContain('Biriktirishni uzish')
  })

  it('locks unlink for in-use, consumed and reserved rolls while showing real state', () => {
    actor()
    for (const changed of [{ stock_status: 'in_use', execution_status: 'in_use', reserved_order_id: 'zakaz-1' }, { stock_status: 'consumed', execution_status: 'consumed', consumed_qty: 80 }, { reserved_order_id: 'zakaz-2' }]) {
      const html = render(queryCache({ linked: { ...assignment, ...changed } }))
      expect(html).toContain('Band, ishlatilayotgan yoki sarflangan rulonni uzib bo‘lmaydi')
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Biriktirishni uzish/)
    }
  })

  it('fails closed when the bounded snapshot cannot confirm the selected stock id', () => {
    actor()
    const html = render(queryCache({ stockRows: [{ ...stock, id: 'replacement-stock' }] }))
    expect(html).toContain('eng ko‘p 500 ta qoldiq yozuvida tasdiqlanmadi')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Buyurtmaga biriktirish/)
  })

  it('exports order detail controls with real assignment list and canonical barcode picker', () => {
    actor()
    const html = render(queryCache({ linked: assignment }), order, 'order')
    expect(html).toContain('Buyurtma xomashyosi')
    expect(html).toContain('canonical-print')
    expect(html).toContain('MAT-1')
    expect(html).toContain('Rulon holati va biriktirish')
    expect(html).toContain('Mos mavjud rulon')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('purchase_id')
    expect(html).not.toContain('layer_index')
  })

  it('renders no old-account assignment data when the session scope changes', () => {
    const queryClient = queryCache({ linked: assignment })
    actor(['admin.access', 'raw_material.assign'], false, 'scope-two')
    const html = render(queryClient)
    expect(html).not.toContain('Packing order')
    expect(html).not.toContain('Ali')
    expect(html).not.toContain('Yetkazish kutilmoqda')
  })

  it('renders loading state and keeps writes closed until live identity data arrives', () => {
    actor()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const html = render(queryClient)
    expect(html).toContain('data-slot="skeleton"')
    expect(html).not.toContain('Buyurtmaga biriktirish')
    expect(html).not.toContain('Biriktirishni uzish')
  })

  it('shows a failed refresh while preventing writes from its retained assignment snapshot', () => {
    actor()
    const queryClient = queryCache({ linked: assignment })
    queryClient.getQueryCache().find({ queryKey: ['raw-material-admin', 'scope-one', 'lookup', barcode] })!.setState({ status: 'error', error: new ApiError(503, 'fixture_unavailable', 'Holatni yuklab bo‘lmadi.') })
    const html = render(queryClient)
    expect(html).toContain('Holatni yuklab bo‘lmadi')
    expect(html).toContain('Qayta yuklash')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Biriktirishni uzish/)
  })

  it('explains incompatible width with both widths and disables an empty candidate write', () => {
    actor()
    const queryClient = queryCache()
    queryClient.setQueryData(['raw-material-admin', 'scope-one', 'candidate-orders', barcode], [])
    queryClient.setQueryData(['raw-material-admin', 'scope-one', 'diagnostic', barcode, '', ''], { ...stock, compatible: false, reason: 'raw_material_roll_size_mismatch', stock_status: 'available', apparatus_options: [], order_width_mm: 500, roll_width_mm: 100, minimum_width_mm: 490, maximum_width_mm: 530 })
    const html = render(queryClient)
    expect(html).toContain('Rulon kengligi buyurtma uchun ruxsat etilgan oraliqqa mos emas')
    expect(html).toContain('Buyurtma kengligi: 500 mm')
    expect(html).toContain('Rulon kengligi: 100 mm')
    expect(html).toContain('Server mos faol buyurtma qaytarmadi')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Buyurtmaga biriktirish/)
  })

  it('makes no requests and offers no enabled writes in demo mode', () => {
    actor(['admin.access', 'raw_material.assign'], true)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const html = render(queryCache({ linked: assignment }))
    expect(html).toContain('Ko‘rish rejimida biriktirish bajarilmaydi')
    expect(html).not.toContain('Biriktirishni uzish')
    expect(html).not.toContain('Buyurtmaga biriktirish')
    expect(fetch).not.toHaveBeenCalled()
  })
})
