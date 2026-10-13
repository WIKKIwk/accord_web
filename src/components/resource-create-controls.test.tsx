import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ApiClient, ApiError } from '@/lib/api'
import type { Session } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { ResourceCreateUnknown, resourceCreateIntent, resourceCreateMemory } from '@/lib/resource-create'
import { ResourceCreateNotice, useResourceCreate } from './resource-create-controls'
import type { ResourceCreateController } from './resource-create-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const body = { name: 'Ali', phone: '', level: 'Master' }, intent = resourceCreateIntent('workers', body)
let count = 0
function setup() {
  const scope = `create-scope-${++count}`, session: Session = { token: 'fixture-token', profile: { role: 'admin', ref: 'admin', display_name: 'Operator' }, capabilities: ['admin.access'], assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ scope, session, client: new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), endpoint: 'https://erp.example.test', demo: false, restoring: false, connection: 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
  resourceCreateMemory.activate(scope)
  return scope
}
function controller(patch: Partial<ResourceCreateController> = {}): ResourceCreateController {
  return { kind: 'workers', values: body, setValues: vi.fn(), error: new ResourceCreateUnknown(intent), intent, pending: false, blocked: true, canReview: true, review: null, submit: vi.fn().mockResolvedValue(undefined), reviewExisting: vi.fn().mockResolvedValue(undefined), acknowledgeExisting: vi.fn(), newDecision: vi.fn(), ...patch }
}
function render(state: ResourceCreateController) { return renderToStaticMarkup(<MemoryRouter><ResourceCreateNotice state={state} /></MemoryRouter>) }
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('generic create uncertainty and explicit review controls', () => {
  it('keeps an unresolved submission visible with read review and an explicit new-draft decision', () => {
    setup()
    const html = render(controller())
    expect(html).toContain('Saqlash natijasi tasdiqlanmadi')
    expect(html).toContain('Yuborilgan yozuv: Ali')
    expect(html).toContain('Qayta saqlash bloklangan')
    expect(html).toContain('Saqlangan yozuvlarni tekshirish')
    expect(html).toContain('Yangi yozuv boshlash')
    expect(html).not.toContain('yaratildi')
  })

  it('does not turn an empty bounded review into a failure claim or a retry POST', () => {
    setup()
    const html = render(controller({ review: { kind: 'workers', candidates: [], loaded: 500, limit: 500, offset: 0, atLimit: true, absenceConfirmed: false } }))
    expect(html).toContain('Bu ro‘yxatda mos yozuv topilmadi')
    expect(html).toContain('Saqlash natijasi hali tasdiqlanmagan')
    expect(html).toContain('so‘rov bajarilmaganini tasdiqlamaydi')
    expect(html).not.toContain('Keyingi yozuvlarni tekshirish')
    expect(html).not.toContain('Qayta saqlash</button>')
  })

  it('requires an explicit choice for matched existing data and shows paged directory continuation only where supported', () => {
    setup()
    const customer = resourceCreateIntent('customers', { name: 'Mijoz', phone: '' })
    const html = render(controller({ kind: 'customers', intent: customer, error: new ResourceCreateUnknown(customer), review: { kind: 'customers', candidates: [{ kind: 'customers', id: 'CUS-1', disposition: 'existing', row: { ref: 'CUS-1', name: 'Mijoz', phone: '' } }], loaded: 50, limit: 50, offset: 0, atLimit: true, absenceConfirmed: false } }))
    expect(html).toContain('Shu yozuvdan foydalanish')
    expect(html).toContain('CUS-1')
    expect(html).toContain('Keyingi yozuvlarni tekshirish')
    expect(html).not.toContain('yaratildi')
  })

  it('preserves unresolved intent when read permission is absent or a review returns 403', () => {
    setup()
    const html = render(controller({ error: new ApiError(403, 'private_read_guard'), canReview: false }))
    expect(html).toContain('ko‘rish ruxsati yetarli emas')
    expect(html).toContain('Qayta saqlash bloklangan')
    expect(html).not.toContain('Saqlangan yozuvlarni tekshirish</button>')
    expect(html).not.toContain('private_read_guard')
  })

  it('restores the retained same-session draft and blocked intent after remount without making a request', () => {
    const scope = setup(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    resourceCreateMemory.patch(scope, 'workers', { values: body }); resourceCreateMemory.markSent(scope, intent)
    function Observer() { const state = useResourceCreate('workers', { name: '', phone: '', level: 'Master' }, vi.fn()); return <p>{String(state.values.name)}:{String(state.blocked)}:{String(state.pending)}:{state.intent?.kind}</p> }
    const tree = () => <QueryClientProvider client={new QueryClient()}><Observer /></QueryClientProvider>
    expect(renderToStaticMarkup(tree())).toContain('Ali:true:false:workers')
    expect(renderToStaticMarkup(tree())).toContain('Ali:true:false:workers')
    expect(fetch).not.toHaveBeenCalled()
    setup()
    expect(renderToStaticMarkup(tree())).toContain(':false:false:')
  })
})
