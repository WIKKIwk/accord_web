import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ApiClient, ApiError, record, rows, text } from './api'
import type { ProductionSnapshot, Row } from './api-types'
import { demoProductionSnapshot, getDemoPage } from './demo'
import { canonicalFactoryMapObjectId, factoryMapApparatus, stateRollInventory, validateFactoryMapPlacement } from './factory-map'
import type { FactoryStockSnapshot } from './factory-map'
import { useSession } from './session'

const base = '/v1/mobile/admin'
const freshness = 30_000
const polling = 15_000

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ma’lumotlar yuklanmadi.'
}

/** Complete pagination or no count: qty is never interpreted as the number of rolls. */
export async function loadFactoryPages(client: ApiClient, path: string, size: number, identity: string, signal: AbortSignal, query: Record<string, string | number | boolean> = {}): Promise<Row[]> {
  const result: Row[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset < 250_000; offset += size) {
    checkCancellation(signal)
    const page = rows(await client.request(path, 'GET', { query: { ...query, limit: size, offset }, signal, timeoutMs: 10_000 }))
    for (const item of page) {
      const key = text(item[identity], '').trim().toLowerCase()
      if (!key || seen.has(key)) throw new Error('Ro‘yxat yuklanayotganda o‘zgardi. Qoldiqni yangilang.')
      seen.add(key)
    }
    result.push(...page)
    if (page.length < size) return result
  }
  throw new Error('Qoldiq ro‘yxati to‘liq yuklanmadi.')
}

async function freshApparatus(client: ApiClient, id: string, signal: AbortSignal): Promise<{ current: Row; all: Row[] }> {
  const [all, current] = await Promise.all([
    client.request(`${base}/apparatus`, 'GET', { query: { limit: 500 }, signal, timeoutMs: 10_000 }).then(value => rows(value)),
    client.request(`${base}/apparatus/${encodeURIComponent(id)}`, 'GET', { signal, timeoutMs: 10_000 }).then(value => record(value)),
  ])
  checkCancellation(signal)
  if (factoryMapApparatus(current).id !== id || !all.some(row => factoryMapApparatus(row).id === id)) throw new Error('Apparat topilmadi. Ro‘yxatni yangilang.')
  return { current, all: all.map(row => factoryMapApparatus(row).id === id ? current : row) }
}

/** The same placement compare-and-swap and readback as mobile; queue fields are untouched. */
export async function saveFactoryPlacement(client: ApiClient, observed: Row, target: string, signal: AbortSignal, publish: (all: Row[]) => void = () => {}): Promise<Row> {
  const id = factoryMapApparatus(observed).id
  if (!id) throw new Error('Apparat tanlanmagan.')
  const objectId = canonicalFactoryMapObjectId(target)
  let { current, all } = await freshApparatus(client, id, signal)
  publish(all)
  if (factoryMapApparatus(current).objectId === objectId) return current
  validateFactoryMapPlacement(current, observed, all, objectId)
  for (let attempt = 0; attempt < 2; attempt++) {
    checkCancellation(signal)
    try {
      const saved = record(await client.request(`${base}/apparatus/${encodeURIComponent(id)}`, 'PATCH', {
        body: { expected_revision: factoryMapApparatus(current).revision, patch: { placement: objectId ? { factory_map_object_id: objectId } : null } },
        headers: { 'Idempotency-Key': crypto.randomUUID() }, signal,
      }))
      checkCancellation(signal)
      const projected = factoryMapApparatus(saved)
      if (projected.id !== id || projected.objectId !== objectId) throw new Error('Biriktirish natijasi tasdiqlanmadi.')
      publish(all.map(row => factoryMapApparatus(row).id === id ? saved : row))
      return saved
    } catch (error) {
      checkCancellation(signal)
      try {
        const fresh = await freshApparatus(client, id, signal)
        current = fresh.current
        all = fresh.all
        publish(all)
      } catch {
        checkCancellation(signal)
        throw new Error('Biriktirish natijasi aniq emas. Xarita biriktirishlarini yangilab tekshiring.')
      }
      if (factoryMapApparatus(current).objectId === objectId) return current
      validateFactoryMapPlacement(current, observed, all, objectId)
      if (attempt > 0 || !(error instanceof ApiError) || error.code !== 'apparatus_revision_conflict') throw error
    }
  }
  throw new Error('Apparat biriktirilmadi.')
}

interface FactoryState {
  apparatusRows: Row[]
  apparatusError: string
  snapshot: ProductionSnapshot | null
  receivedAt: number
  liveError: string
  loading: boolean
  refreshing: boolean
  fresh: boolean
  stockStateData: FactoryStockSnapshot | null
  stockError: string
  stockFresh: boolean
  saving: boolean
}

interface CatalogCache { items: Row[]; groups: Row[]; receivedAt: number }

// One current preview session, entirely in RAM. Re-entering preview changes scope.
let previewBindings: { scope: string; rows: Row[] } | null = null

/** A mounted visible page owns these requests. No page, hidden tab or old session keeps polling. */
export class FactoryMapStore {
  private state: FactoryState = { apparatusRows: [], apparatusError: '', snapshot: null, receivedAt: 0, liveError: '', loading: true, refreshing: false, fresh: false, stockStateData: null, stockError: '', stockFresh: false, saving: false }
  private listeners = new Set<() => void>()
  private active = false
  private mounted = false
  private generation = 0
  private lifetime = 0
  private bindingRevision = 0
  private poll: ReturnType<typeof setInterval> | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private readController: AbortController | null = null
  private stockController: AbortController | null = null
  private saveController: AbortController | null = null
  private pending: Promise<void> | null = null
  private stockPending: Promise<void> | null = null
  private catalog: CatalogCache | null = null
  private retiredEpochs = new Set<string>()
  private client: ApiClient | null
  private demo: boolean
  private scope: string

  constructor(client: ApiClient | null, demo: boolean, scope: string) { this.client = client; this.demo = demo; this.scope = scope }

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): FactoryState => this.state
  private update(patch: Partial<FactoryState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }

  start(visible = true): void {
    this.mounted = true
    this.setVisible(visible)
  }

  stop(): void {
    this.mounted = false
    this.lifetime++
    this.saveController?.abort()
    this.saveController = null
    this.setVisible(false)
  }

  setVisible(visible: boolean): void {
    if (visible === this.active) return
    this.active = visible && this.mounted
    if (this.poll) clearInterval(this.poll)
    if (this.expiry) clearTimeout(this.expiry)
    this.poll = this.expiry = null
    if (!this.active) {
      this.generation++
      this.readController?.abort()
      this.stockController?.abort()
      this.readController = null
      this.stockController = null
      this.pending = null
      this.stockPending = null
      this.update({ fresh: false, stockFresh: false, refreshing: false })
      return
    }
    void this.refresh()
    this.poll = setInterval(() => { void this.refresh() }, polling)
  }

  private current(generation: number, controller: AbortController): boolean {
    return this.mounted && this.active && this.generation === generation && this.readController === controller && !controller.signal.aborted
  }

  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry)
    const now = Date.now()
    const fresh = this.active && !this.state.liveError && !this.state.apparatusError && this.state.receivedAt > 0 && now < this.state.receivedAt + freshness
    const stockFresh = this.active && !this.state.stockError && Boolean(this.state.stockStateData && now < this.state.stockStateData.receivedAt + freshness)
    if (fresh !== this.state.fresh || stockFresh !== this.state.stockFresh) this.update({ fresh, stockFresh })
    const times = [this.state.fresh ? this.state.receivedAt + freshness : 0, this.state.stockFresh ? (this.state.stockStateData?.receivedAt ?? 0) + freshness : 0].filter(time => time > now)
    if (!times.length) return
    this.expiry = setTimeout(() => {
      this.update({ fresh: this.active && !this.state.liveError && !this.state.apparatusError && this.state.receivedAt > 0 && Date.now() < this.state.receivedAt + freshness, stockFresh: this.active && !this.state.stockError && Boolean(this.state.stockStateData && Date.now() < this.state.stockStateData.receivedAt + freshness) })
      this.scheduleExpiry()
    }, Math.max(1, Math.min(...times) - now))
  }

  private async stock(signal: AbortSignal): Promise<FactoryStockSnapshot> {
    const startedAt = Date.now()
    if (this.demo) {
      const locations = getDemoPage('locations', { limit: 500 }).items
      return { locations, rolls: stateRollInventory(getDemoPage('assets', { limit: 500 }).items, locations, getDemoPage('items', { limit: 500 }).items, getDemoPage('item-groups', { limit: 500 }).items), receivedAt: startedAt }
    }
    if (!this.client) throw new Error('Sessiya mavjud emas.')
    const [locations, assets] = await Promise.all([
      this.client.request(`${base}/inventory/locations`, 'GET', { signal, timeoutMs: 10_000 }).then(value => rows(value)),
      loadFactoryPages(this.client, `${base}/inventory/assets`, 500, 'asset_ref', signal, { asset_kind: 'raw_material', current_user_states_only: true }),
    ])
    const known = new Set(this.catalog?.items.map(item => text(item.code, '').trim().toLowerCase()))
    const missing = assets.some(asset => !known.has(text(asset.item_code, '').trim().toLowerCase()))
    if (!this.catalog || startedAt - this.catalog.receivedAt >= 60_000 || missing) {
      const [items, groups] = await Promise.all([
        loadFactoryPages(this.client, `${base}/items`, 200, 'code', signal),
        this.client.request(`${base}/item-groups/tree`, 'GET', { signal, timeoutMs: 10_000 }).then(value => rows(value)),
      ])
      checkCancellation(signal)
      this.catalog = { items, groups, receivedAt: Date.now() }
    }
    checkCancellation(signal)
    return { locations, rolls: stateRollInventory(assets, locations, this.catalog.items, this.catalog.groups), receivedAt: startedAt }
  }

  private refreshStock(): Promise<void> {
    if (this.stockPending) return this.stockPending
    const controller = new AbortController()
    this.stockController = controller
    const generation = this.generation
    const current = () => this.active && this.mounted && generation === this.generation && this.stockController === controller && !controller.signal.aborted
    this.stockPending = this.stock(controller.signal).then(stockStateData => {
      if (!current()) return
      this.update({ stockStateData, stockError: '', stockFresh: Date.now() < stockStateData.receivedAt + freshness })
      this.scheduleExpiry()
    }, error => { if (current()) this.update({ stockError: errorMessage(error), stockFresh: false }) }).finally(() => {
      if (this.stockController === controller) { this.stockController = null; this.stockPending = null }
    })
    return this.stockPending
  }

  refresh = (): Promise<void> => {
    if (!this.active || !this.mounted) return Promise.resolve()
    void this.refreshStock()
    if (this.pending) return this.pending
    const controller = new AbortController()
    const generation = this.generation
    const bindingRevision = this.bindingRevision
    this.readController = controller
    this.update({ refreshing: true })
    const apparatus = this.demo
      ? Promise.resolve(previewBindings?.scope === this.scope ? previewBindings.rows : getDemoPage('apparatus', { limit: 500 }).items)
      : this.client?.request(`${base}/apparatus`, 'GET', { query: { limit: 500 }, signal: controller.signal, timeoutMs: 10_000 }).then(value => rows(value)) ?? Promise.reject(new Error('Sessiya mavjud emas.'))
    const live = this.demo ? Promise.resolve(demoProductionSnapshot) : this.client?.productionSnapshot(controller.signal) ?? Promise.reject(new Error('Sessiya mavjud emas.'))
    this.pending = Promise.all([
      apparatus.then(apparatusRows => { if (this.current(generation, controller) && !this.saveController && bindingRevision === this.bindingRevision) this.update({ apparatusRows, apparatusError: '' }) }, error => { if (this.current(generation, controller) && !this.saveController && bindingRevision === this.bindingRevision) this.update({ apparatusError: errorMessage(error), fresh: false }) }),
      live.then(snapshot => {
        if (!this.current(generation, controller)) return
        const previous = this.state.snapshot
        if (this.retiredEpochs.has(snapshot.epoch) || previous && previous.epoch === snapshot.epoch && snapshot.rev < previous.rev) return
        if (previous && previous.epoch !== snapshot.epoch) this.retiredEpochs.add(previous.epoch)
        this.update({ snapshot, receivedAt: Date.now(), liveError: '' })
      }, error => { if (this.current(generation, controller)) this.update({ liveError: errorMessage(error), fresh: false }) }),
    ]).then(() => {
      if (!this.current(generation, controller)) return
      this.update({ loading: false, refreshing: false, fresh: !this.state.liveError && !this.state.apparatusError && this.state.receivedAt > 0 && Date.now() < this.state.receivedAt + freshness })
      this.scheduleExpiry()
    }).finally(() => {
      if (this.readController === controller) { this.readController = null; this.pending = null }
    })
    return this.pending
  }

  savePlacement = async (observed: Row, target: string): Promise<Row> => {
    if (!this.mounted) throw new Error('Xarita yopilgan.')
    if (this.saveController) throw new Error('Biriktirish saqlanmoqda. Kuting.')
    const controller = new AbortController()
    this.bindingRevision++
    this.saveController = controller
    const lifetime = this.lifetime
    this.update({ saving: true })
    const publish = (apparatusRows: Row[]) => {
      if (this.mounted && this.lifetime === lifetime && !controller.signal.aborted) this.update({ apparatusRows, apparatusError: '' })
    }
    try {
      if (this.demo) {
        const all = previewBindings?.scope === this.scope ? previewBindings.rows : this.state.apparatusRows
        const id = factoryMapApparatus(observed).id
        const current = all.find(row => factoryMapApparatus(row).id === id)
        if (!current) throw new Error('Apparat topilmadi.')
        const objectId = canonicalFactoryMapObjectId(target)
        if (factoryMapApparatus(current).objectId === objectId) return current
        validateFactoryMapPlacement(current, observed, all, objectId)
        const saved = { ...current, source_revision: factoryMapApparatus(current).revision + 1, placement: objectId ? { factory_map_object_id: objectId } : null }
        const apparatusRows = all.map(row => factoryMapApparatus(row).id === id ? saved : row)
        previewBindings = { scope: this.scope, rows: apparatusRows }
        publish(apparatusRows)
        return saved
      }
      if (!this.client) throw new Error('Sessiya mavjud emas.')
      return await saveFactoryPlacement(this.client, observed, target, controller.signal, publish)
    } finally {
      this.bindingRevision++
      if (this.saveController === controller) this.saveController = null
      if (this.mounted && this.lifetime === lifetime) this.update({ saving: false })
    }
  }
}

export function useFactoryMap() {
  const { client, demo, scope } = useSession()
  const store = useMemo(() => new FactoryMapStore(client, demo, scope), [client, demo, scope])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    const visibility = () => store.setVisible(document.visibilityState !== 'hidden')
    store.start(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => { document.removeEventListener('visibilitychange', visibility); store.stop() }
  }, [store])
  return { ...state, refresh: store.refresh, savePlacement: store.savePlacement }
}
