import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClient, ApiError } from '@/lib/api'
import type { Row, Session } from '@/lib/api-types'
import { apparatusAasxMime, apparatusCreateDraft, apparatusDefaultForm, parseApparatusCanonicalRevision, parseApparatusProjection, type ApparatusAdminSnapshot } from '@/lib/apparatus-admin'
import { useSession } from '@/lib/session'
import { ApparatusAdminControls, ApparatusAdminToolbar, ApparatusMaintenanceReadView } from './apparatus-admin-controls'

vi.mock('@/lib/session', () => ({ useSession: vi.fn() }))
const apparatus: Row = { apparatus_id: 'apparatus:default:asset-001', physical_asset_id: 'physical-asset:001', lifecycle: { state: 'active', retirement_reason: null }, display: { display_name: 'Bosma 01' }, execution_profile: { operation: 'print' } }
function actor(capabilities = ['production.map.manage'], options: { demo?: boolean; role?: string; connection?: 'online' | 'offline' | 'checking' } = {}) {
  const session: Session = { token: 'fixture-token', profile: { role: options.role ?? 'admin', ref: 'fixture-admin', display_name: 'Admin' }, capabilities, assigned_apparatus: [], assigned_apparatus_labels: [], assigned_item_groups: [], assigned_warehouses: [] }
  vi.mocked(useSession).mockReturnValue({ session, demo: options.demo ?? false, scope: 'apparatus-ui-fixture', endpoint: 'https://erp.example.test', client: new ApiClient({ endpoint: 'https://erp.example.test', token: session.token }), restoring: false, connection: options.connection ?? 'online', login: vi.fn(), logout: vi.fn(), enterDemo: vi.fn(), reconnect: vi.fn() })
}
const render = (value: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{value}</QueryClientProvider>)
function canonical(revision: number, name: string): ApparatusAdminSnapshot {
  const draft = apparatusCreateDraft({ ...apparatusDefaultForm(), name }, { equipmentClass: 'equipment-class:print', physicalAsset: 'physical-asset:001', hierarchy: { enterprise_id: 'enterprise:qa', site_id: 'site:qa', area_id: 'area:production', work_center_id: 'work-center:print', work_unit_id: 'work-unit:print-1' } })
  const id = String(apparatus.apparatus_id), suffix = id.slice('apparatus:'.length)
  return {
    revision: parseApparatusCanonicalRevision({ ...draft, schema_version: 1, apparatus_id: id, revision_metadata: { revision, committed_at_unix_ms: 1_792_000_000_000 + revision, command_id: `apparatus-command:fixture-${revision}`, actor_id: 'principal:fixture-admin', source: 'admin', source_reference: null }, aas_identity: { shell_id: `urn:mini-rs-erp:aas:apparatus:${suffix}`, submodel_id: `urn:mini-rs-erp:submodel:apparatus:${suffix}`, semantic_id: 'urn:mini-rs-erp:semantic-id:submodel:apparatus:1', idta_release: '26-01', aas_metamodel_version: '3.2.0', aasx_part_5_version: 'IDTA-01005 v3.2', package_format: 'Open Packaging Conventions', media_type: apparatusAasxMime } }),
    projection: parseApparatusProjection({ ...draft, apparatus_id: id, source_revision: revision, source_aasx_sha256: String(revision).repeat(64), capabilities: { print: 1 } }),
  }
}
function deferredRead() {
  let resolve!: (value: ApparatusAdminSnapshot) => void, reject!: (error: unknown) => void
  const promise = new Promise<ApparatusAdminSnapshot>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
function afterMountRead<TKey extends readonly unknown[]>(observer: QueryObserver<ApparatusAdminSnapshot, Error, ApparatusAdminSnapshot, ApparatusAdminSnapshot, TKey>) {
  return new Promise<void>(resolve => {
    const unsubscribe = observer.subscribe(result => { if (result.isFetchedAfterMount && !result.isFetching) { unsubscribe(); resolve() } })
  })
}
function maintenanceView(source: Parameters<typeof ApparatusMaintenanceReadView>[0]['source'], action: 'edit' | 'retire' | 'import' = 'retire') {
  const write = { pending: false, error: null, unknown: null, run: vi.fn(async () => {}), clear: vi.fn(), canWrite: true, canRecover: true, discard: vi.fn() }
  const options = { data: { operations: ['print' as const], technologies: ['rotogravure' as const], capabilities: ['print' as const] }, error: null, isPending: false }
  const references = { data: { activeOrderIds: [], unknownOrderIds: [], historicalOrderIds: [] }, error: null, isPending: false, isFetching: false }
  return { html: render(<ApparatusMaintenanceReadView source={source} action={action} options={options} references={references} write={write} onDone={vi.fn()} retry={vi.fn()} />), write }
}
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

describe('apparatus maintenance fresh canonical baseline', () => {
  it('waits for the mounted dialog read instead of pinning cached revision 1, including each reopening', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }), key = ['apparatus-admin-source', 'apparatus-ui-fixture', apparatus.apparatus_id]
    client.setQueryData(key, canonical(1, 'Bosma old name'))
    const first = deferredRead(), observer = new QueryObserver(client, { queryKey: key, queryFn: () => first.promise, staleTime: 0, retry: false })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const cached = observer.getCurrentResult()
      expect(cached).toMatchObject({ isPending: false, isFetching: true, isFetchedAfterMount: false })
      expect(cached.data?.projection.source_revision).toBe(1)
      for (const action of ['edit', 'retire', 'import'] as const) {
        const { html, write } = maintenanceView(cached, action)
        expect(html).toContain('Amaldagi apparat profili yuklanmoqda')
        expect(html).not.toContain('<form'); expect(html).not.toContain('Bosma old name')
        expect(write.run).not.toHaveBeenCalled()
      }
      const ready = afterMountRead(observer); first.resolve(canonical(2, 'Bosma renamed')); await ready
      const fresh = observer.getCurrentResult(), { html } = maintenanceView(fresh)
      expect(html).toContain('Revision 2'); expect(html).toContain('Foydalanishdan chiqarish sababi')
      expect(maintenanceView(fresh, 'edit').html).toContain('value="Bosma renamed"')
      unsubscribe()
      const second = deferredRead(), reopened = new QueryObserver(client, { queryKey: key, queryFn: () => second.promise, staleTime: 0, retry: false }), close = reopened.subscribe(() => {})
      try {
        expect(reopened.getCurrentResult().data?.projection.source_revision).toBe(2)
        expect(maintenanceView(reopened.getCurrentResult()).html).not.toContain('<form')
        const reloaded = afterMountRead(reopened); second.resolve(canonical(3, 'Bosma latest')); await reloaded
        expect(maintenanceView(reopened.getCurrentResult()).html).toContain('Revision 3')
      } finally { close() }
    } finally { unsubscribe(); client.clear() }
  })

  it('shows a failed canonical read instead of turning cached data into a writable retirement form', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }), key = ['apparatus-admin-source', 'apparatus-ui-fixture', apparatus.apparatus_id]
    client.setQueryData(key, canonical(1, 'Bosma old name'))
    const response = deferredRead(), observer = new QueryObserver(client, { queryKey: key, queryFn: () => response.promise, staleTime: 0, retry: false }), close = observer.subscribe(() => {})
    try {
      const failed = afterMountRead(observer); response.reject(new ApiError(502, 'invalid_response', 'Canonical revision tasdiqlanmadi.')); await failed
      const { html, write } = maintenanceView(observer.getCurrentResult())
      expect(html).toContain('Canonical revision tasdiqlanmadi.'); expect(html).toContain('Qayta yuklash')
      expect(html).not.toContain('<form'); expect(html).not.toContain('Amalni ko‘rib chiqish')
      expect(write.run).not.toHaveBeenCalled()
    } finally { close(); client.clear() }
  })

  it('does not unmount an initialized maintenance form merely because a later read is fetching', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }), key = ['apparatus-admin-source', 'apparatus-ui-fixture', apparatus.apparatus_id]
    const first = deferredRead(), later = deferredRead(), read = vi.fn<() => Promise<ApparatusAdminSnapshot>>().mockReturnValueOnce(first.promise).mockReturnValue(later.promise)
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read, staleTime: 0, retry: false }), close = observer.subscribe(() => {})
    try {
      const ready = afterMountRead(observer); first.resolve(canonical(2, 'Bosma renamed')); await ready
      expect(maintenanceView(observer.getCurrentResult(), 'edit').html).toContain('value="Bosma renamed"')
      const pending = observer.refetch(), current = observer.getCurrentResult()
      expect(current).toMatchObject({ isFetchedAfterMount: true, isFetching: true })
      const { html } = maintenanceView(current, 'edit')
      expect(html).toContain('<form'); expect(html).toContain('value="Bosma renamed"')
      expect(html).not.toContain('Amaldagi apparat profili yuklanmoqda')
      later.resolve(canonical(3, 'Bosma latest')); await pending
    } finally { close(); client.clear() }
  })
})
