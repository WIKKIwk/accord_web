import type { CalculateOrderTemplate, CalculateProductQuery, CalculatorInput, CreateResourceKind, Page, Profile, ProductionSnapshot, Query, ResourceKind, Row, Session, SettingsInput } from './api-types'
export type { CalculateLayerInput, CalculateOrderTemplate, CalculateProductionOptions, CalculateProductQuery, CalculatorInput, CreateResourceKind, Page, Profile, ProductionSnapshot, Query, ResourceKind, Row, SavedMap, Session, SettingsInput } from './api-types'

const base = '/v1/mobile/admin'

export interface ResourceDefinition {
  title: string
  path: string
  identity: string
  pagination: 'offset' | 'limit' | 'all' | 'envelope'
  search: 'server' | 'local' | 'none'
  params?: string[]
  listKey?: string
  maxLimit?: number
  required?: string[]
  createPath?: string
}

/** Wire contracts verified against Mini RS handlers; pagination is not invented. */
export const resourceDefinitions: Record<ResourceKind, ResourceDefinition> = {
  orders: { title: 'Buyurtmalar', path: `${base}/production-maps/sequence`, identity: 'id', pagination: 'all', search: 'local' },
  maps: { title: 'Texnologik xaritalar', path: `${base}/production-maps`, identity: 'id', pagination: 'all', search: 'local' },
  pending: { title: 'Kutilayotgan buyurtmalar', path: `${base}/pending-orders`, identity: 'id', pagination: 'all', search: 'local' },
  completed: { title: 'Yakunlangan ishlar', path: `${base}/production-maps/completed-orders`, identity: 'order_id', listKey: 'completed_orders', pagination: 'limit', maxLimit: 200, search: 'local' },
  closed: { title: 'Yopilgan buyurtmalar', path: `${base}/production-maps/closed-orders`, identity: 'order_id', listKey: 'closed_orders', pagination: 'limit', maxLimit: 200, search: 'local' },
  completion: { title: 'Yakunlash so‘rovlari', path: `${base}/production-maps/completion-requests`, identity: 'event_id', listKey: 'completion_requests', pagination: 'limit', maxLimit: 200, search: 'local' },
  wip: { title: 'Jarayondagi mahsulotlar', path: `${base}/production-maps/wip-batches`, identity: 'batch_id', listKey: 'batches', pagination: 'limit', maxLimit: 500, search: 'local', params: ['apparatus', 'next_apparatus', 'current_location', 'status', 'order_id', 'limit'] },
  'opening-wip': { title: 'Boshlang‘ich WIP', path: `${base}/production-maps/opening-wip`, identity: 'batch_id', listKey: 'records', pagination: 'limit', maxLimit: 500, search: 'local', params: ['order_id', 'status', 'limit'] },
  items: { title: 'Material va mahsulotlar', path: `${base}/items`, identity: 'code', pagination: 'offset', search: 'server', params: ['q', 'group', 'offset', 'limit'], createPath: `${base}/items` },
  'item-groups': { title: 'Mahsulot guruhlari', path: `${base}/item-groups/tree`, identity: 'name', pagination: 'all', search: 'local', createPath: `${base}/item-groups` },
  apparatus: { title: 'Apparatlar', path: `${base}/apparatus`, identity: 'apparatus_id', pagination: 'limit', maxLimit: 500, search: 'server', params: ['q', 'limit'] },
  workers: { title: 'Ishchilar', path: `${base}/workers`, identity: 'id', pagination: 'limit', maxLimit: 500, search: 'server', params: ['q', 'role', 'limit'], createPath: `${base}/workers` },
  suppliers: { title: 'Ta’minotchilar', path: `${base}/suppliers/list`, identity: 'ref', pagination: 'offset', maxLimit: 50, search: 'none', params: ['offset', 'limit'], createPath: `${base}/suppliers` },
  customers: { title: 'Mijozlar', path: `${base}/customers/list`, identity: 'ref', pagination: 'offset', maxLimit: 50, search: 'server', params: ['q', 'offset', 'limit'], createPath: `${base}/customers` },
  warehouses: { title: 'Omborlar', path: `${base}/warehouses`, identity: 'warehouse', pagination: 'limit', maxLimit: 500, search: 'server', params: ['q', 'parent', 'limit'], createPath: `${base}/warehouses` },
  stock: { title: 'Ombor qoldiqlari', path: `${base}/warehouses/items`, identity: 'code', pagination: 'offset', maxLimit: 200, search: 'server', params: ['q', 'warehouse', 'offset', 'limit'], required: ['warehouse'] },
  'raw-materials': { title: 'Xomashyo qoldiqlari', path: `${base}/raw-material-stock`, identity: 'barcode', pagination: 'limit', maxLimit: 500, search: 'local', params: ['warehouse', 'limit'] },
  users: { title: 'Foydalanuvchilar', path: `${base}/users/list`, identity: 'id', listKey: 'items', pagination: 'envelope', maxLimit: 50, search: 'server', params: ['q', 'role', 'offset', 'limit'] },
  roles: { title: 'Rollar va ruxsatlar', path: `${base}/roles`, identity: 'id', pagination: 'all', search: 'local' },
  activity: { title: 'Faoliyat tarixi', path: `${base}/activity`, identity: 'id', pagination: 'all', search: 'local' },
  materials: { title: 'Hisoblash materiallari', path: `${base}/calculate-materials`, identity: 'id', listKey: 'materials', pagination: 'all', search: 'local' },
  templates: { title: 'Buyurtma shablonlari', path: '/v1/mobile/calculate/orders', identity: 'id', listKey: 'templates', pagination: 'all', search: 'local' },
  locations: { title: 'Zavod joylari', path: `${base}/inventory/locations`, identity: 'id', pagination: 'all', search: 'local' },
  assets: { title: 'Inventar', path: `${base}/inventory/assets`, identity: 'asset_ref', pagination: 'offset', maxLimit: 500, search: 'server', params: ['warehouse_id', 'query', 'asset_kind', 'current_user_states_only', 'offset', 'limit'] },
}

const errorMessages: Record<string, string> = {
  invalid_credentials: 'Telefon raqami yoki kirish kodi noto‘g‘ri.',
  'invalid credentials': 'Telefon raqami yoki kirish kodi noto‘g‘ri.',
  'too many login attempts; try again later': 'Kirishga urinishlar ko‘payib ketdi. Birozdan keyin qayta urinib ko‘ring.',
  unauthorized: 'Sessiya tugagan. Qayta kiring.',
  forbidden: 'Bu amal uchun ruxsat berilmagan.',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message?: string) {
    super(message || errorMessages[code] || (status === 401 ? errorMessages.unauthorized : status === 403 ? errorMessages.forbidden : status === 404 ? 'Ma’lumot topilmadi.' : status === 409 ? 'Ma’lumot o‘zgargan. Yangilab qayta urinib ko‘ring.' : status >= 500 ? 'Serverda xatolik yuz berdi.' : 'So‘rov bajarilmadi.'))
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function record(value: unknown): Row {
  if (!isRecord(value)) throw new ApiError(502, 'invalid_response', 'Serverdan kutilgan ma’lumot kelmadi.')
  return value
}

export function rows(value: unknown, key?: string): Row[] {
  const list = key ? record(value)[key] : value
  if (!Array.isArray(list) || list.some(item => !isRecord(item))) throw new ApiError(502, 'invalid_response', 'Serverdan kutilgan ro‘yxat kelmadi.')
  return list as Row[]
}

export function valueAt(row: Row, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (Array.isArray(value)) return part === 'length' ? value.length : /^\d+$/.test(part) ? value[Number(part)] : undefined
    return isRecord(value) && Object.hasOwn(value, part) ? value[part] : undefined
  }, row)
}

export function text(value: unknown, fallback = '—'): string {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

export function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('uz-UZ', { maximumFractionDigits: 3 }) : '—'
}

export function normalizeEndpoint(input: string): string {
  const value = input.trim().replace(/\/+$/, '')
  if (!value) throw new Error('Server manzilini kiriting.')
  let url: URL
  try { url = new URL(value.includes('://') ? value : `https://${value}`) }
  catch { throw new Error('Server manzili noto‘g‘ri.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Server manzilini domen yoki HTTP(S) manzili sifatida kiriting.')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function isAdminSession(session: Session | null | undefined): boolean {
  return Boolean(session?.capabilities.includes('admin.access'))
}

function stringList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new ApiError(502, 'invalid_response', 'Kirish ma’lumotlari to‘liq kelmadi.')
  return value as string[]
}

function parseProfile(value: unknown): Profile {
  const profile = record(value)
  if (typeof profile.role !== 'string' || typeof profile.display_name !== 'string') throw new ApiError(502, 'invalid_response', 'Profil ma’lumotlari to‘liq kelmadi.')
  return profile as unknown as Profile
}

function stripCredentials(kind: ResourceKind, row: Row): Row {
  if (!['suppliers', 'customers', 'workers', 'users'].includes(kind)) return row
  const result = { ...row }
  delete result.code
  return result
}

function matchesSearch(value: unknown, needle: string, depth = 0): boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).toLocaleLowerCase('uz').includes(needle)
  if (depth >= 4) return false
  if (Array.isArray(value)) return value.some(item => matchesSearch(item, needle, depth + 1))
  return isRecord(value) && Object.values(value).some(item => matchesSearch(item, needle, depth + 1))
}

function pageRows(items: Row[], query: Query): Page {
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0))
  const limit = Math.max(1, Math.floor(Number(query.limit) || 25))
  return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit }
}

// Same normalization and multi-token matching as mobile search_normalizer.dart.
function productSearchText(value: string): string {
  const letters: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', қ: 'q', ғ: 'g', ҳ: 'h', ў: 'o' }
  return Array.from(value.toLowerCase(), letter => letters[letter] ?? letter).join('').replace(/['`ʻʼ’]/g, '').replace(/x/g, 'h').replace(/\s+/g, ' ').trim()
}

function productMatches(row: Row, query: string): boolean {
  const needle = productSearchText(query)
  if (!needle) return true
  const values = ['name', 'code', 'uom', 'warehouse'].map(key => productSearchText(text(row[key], ''))).filter(Boolean)
  if (values.some(value => value.includes(needle))) return true
  const tokens = needle.split(/[^a-z0-9]+/).filter(token => token.length >= 2)
  return tokens.length >= 2 && tokens.every(token => values.some(value => {
    const compact = value.replace(/[^a-z0-9]+/g, '')
    for (let start = 0; start <= compact.length - token.length; start++) {
      let differences = 0
      for (let index = 0; index < token.length; index++) if (compact[start + index] !== token[index]) differences++
      if (differences <= 1) return true
    }
    return false
  }))
}

function orderSaveResult(value: unknown): Row {
  const result = record(value)
  const saved = record(result.saved)
  const map = record(saved.map)
  if (result.ok !== true || typeof map.id !== 'string' || !map.id.trim() || typeof map.order_number !== 'string' || !map.order_number.trim() || !isRecord(saved.program) || (result.template !== null && !isRecord(result.template))) throw new ApiError(502, 'invalid_response', 'Buyurtmani ochish natijasi to‘liq kelmadi. Ro‘yxatni yangilang.')
  rows(map, 'nodes')
  rows(map, 'edges')
  return result
}

export interface ApiClientConfig {
  endpoint: string
  token?: string
  onUnauthorized?: () => void
  onConnectionChange?: (online: boolean) => void
}

export interface RequestOptions {
  query?: Query
  body?: unknown
  rawBody?: Blob
  headers?: HeadersInit
  signal?: AbortSignal
  authorized?: boolean
  timeoutMs?: number
}

/** Each instance is bound to one server and token; callers key caches by that session. */
export class ApiClient {
  readonly endpoint: string
  private readonly token?: string
  private readonly onUnauthorized?: () => void
  private readonly onConnectionChange?: (online: boolean) => void

  constructor(config: ApiClientConfig) {
    this.endpoint = normalizeEndpoint(config.endpoint)
    this.token = config.token
    this.onUnauthorized = config.onUnauthorized
    this.onConnectionChange = config.onConnectionChange
  }

  async request<T = unknown>(path: string, method = 'GET', options: RequestOptions = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API yo‘li noto‘g‘ri.')
    const url = new URL(`${this.endpoint}${path}`)
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (options.authorized !== false) {
      if (!this.token) throw new ApiError(401, 'unauthorized')
      headers.set('Authorization', `Bearer ${this.token}`)
    }
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const timeout = setTimeout(abort, options.timeoutMs ?? 20_000)
    try {
      const response = await fetch(url, { method, headers, body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
      if (options.signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
      this.onConnectionChange?.(true)
      if (response.status === 401 && options.authorized !== false) this.onUnauthorized?.()
      const content = await response.text()
      let payload: unknown
      try { payload = content ? JSON.parse(content) : undefined }
      catch { throw new ApiError(response.status || 502, 'invalid_response', 'Serverdan kutilgan JSON javobi kelmadi.') }
      if (!response.ok) {
        const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `http_${response.status}`
        const detail = isRecord(payload) && typeof payload.detail === 'string' && payload.detail.trim() ? payload.detail : undefined
        throw new ApiError(response.status, error, detail)
      }
      // A cancelled identity must not publish an old server's response.
      if (options.signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
      return payload as T
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
      if (error instanceof ApiError) throw error
      this.onConnectionChange?.(false)
      if (controller.signal.aborted) throw new ApiError(0, 'timeout', 'Server javobi kechikdi. Qayta urinib ko‘ring.')
      throw new ApiError(0, 'network', 'Serverga ulanib bo‘lmadi. Manzil va internetni tekshiring.')
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> { return this.request<T>(path, 'GET', { query, signal }) }
  post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> { return this.request<T>(path, 'POST', { body, signal }) }
  put<T = unknown>(path: string, body?: unknown, query?: Query, signal?: AbortSignal): Promise<T> { return this.request<T>(path, 'PUT', { body, query, signal }) }
  delete<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> { return this.request<T>(path, 'DELETE', { query, signal }) }

  async login(phone: string, code: string, signal?: AbortSignal): Promise<Session> {
    const payload = record(await this.request('/v1/mobile/auth/login', 'POST', { authorized: false, body: { phone: phone.trim(), code: code.trim() }, signal }))
    if (typeof payload.token !== 'string' || !payload.token.trim() || !Array.isArray(payload.capabilities)) throw new ApiError(502, 'invalid_response', 'Kirish ma’lumotlari to‘liq kelmadi.')
    return { token: payload.token, profile: parseProfile(payload.profile), capabilities: stringList(payload.capabilities), assigned_apparatus: stringList(payload.assigned_apparatus), assigned_apparatus_labels: stringList(payload.assigned_apparatus_labels), assigned_item_groups: stringList(payload.assigned_item_groups), assigned_warehouses: stringList(payload.assigned_warehouses) }
  }

  async me(signal?: AbortSignal): Promise<Profile> { return parseProfile(await this.get('/v1/mobile/me', undefined, signal)) }
  async logout(signal?: AbortSignal): Promise<void> { await this.post('/v1/mobile/auth/logout', undefined, signal) }

  async productionSnapshot(signal?: AbortSignal): Promise<ProductionSnapshot> {
    const payload = record(await this.get(`${base}/production-maps/sequence`, undefined, signal))
    if (payload.ok !== true || !Number.isSafeInteger(payload.rev) || Number(payload.rev) < 0 || typeof payload.epoch !== 'string' || typeof payload.scope !== 'string') throw new ApiError(502, 'invalid_response', 'Ishlab chiqarish holati to‘liq kelmadi.')
    for (const saved of rows(payload, 'maps')) {
      const map = record(saved.map)
      if (typeof map.id !== 'string' || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) throw new ApiError(502, 'invalid_response', 'Buyurtma xaritasi to‘liq kelmadi.')
      record(saved.program)
    }
    for (const key of ['order_statuses', 'order_customers', 'sequences', 'queue_states', 'stage_states', 'queue_action_controls', 'order_controls']) record(payload[key])
    return payload as unknown as ProductionSnapshot
  }

  async list(kind: ResourceKind, query: Query = {}, signal?: AbortSignal): Promise<Page> {
    return this.readResourceList(kind, query, signal, true)
  }

  /** Retain the complete response for endpoints without server-side paging. */
  async listSnapshot(kind: ResourceKind, query: Query = {}, signal?: AbortSignal): Promise<Page> {
    if (['offset', 'envelope'].includes(resourceDefinitions[kind].pagination)) throw new Error('Bu ro‘yxat server orqali qismlarga bo‘lib yuklanadi.')
    return this.readResourceList(kind, query, signal, false)
  }

  private async readResourceList(kind: ResourceKind, query: Query, signal: AbortSignal | undefined, paginate: boolean): Promise<Page> {
    const definition = resourceDefinitions[kind]
    for (const required of definition.required || []) if (!text(query[required], '').trim()) throw new Error('Omborni tanlang.')
    const serverQuery: Query = {}
    for (const param of definition.params || []) if (query[param] !== undefined) serverQuery[param] = query[param]
    if (kind === 'assets' && query.q !== undefined) serverQuery.query = query.q
    const offset = Math.max(0, Number(query.offset) || 0)
    const max = definition.maxLimit ?? 500
    const limit = Math.max(1, Math.min(Number(query.limit) || 25, max))
    if (definition.pagination === 'offset') Object.assign(serverQuery, { offset, limit: Math.min(limit + 1, max) })
    if (definition.pagination === 'envelope') Object.assign(serverQuery, { offset, limit })
    if (definition.pagination === 'limit' && definition.params?.includes('limit')) serverQuery.limit = max
    let payload: unknown
    let items: Row[]
    if (kind === 'orders') {
      const snapshot = await this.productionSnapshot(signal)
      items = snapshot.maps.map(saved => {
        const map = saved.map
        const id = text(map.id, '')
        const status = snapshot.order_statuses[id] || {}
        return { ...map, map, program: saved.program, customer_name: snapshot.order_customers[id] || map.customer_name || '', status: status.order_status || status.lifecycle_status || '', server_status: status, order_control: snapshot.order_controls[id] }
      })
    } else {
      payload = await this.get(definition.path, Object.keys(serverQuery).length ? serverQuery : undefined, signal)
      items = rows(payload, definition.listKey)
      if (kind === 'maps') items = items.map(saved => ({ ...record(saved.map), map: record(saved.map), program: record(saved.program) }))
      if (kind === 'pending') items = items.map(row => ({ ...record(row.template), ...row }))
    }
    items = items.map(row => stripCredentials(kind, row))
    if (definition.pagination === 'envelope') {
      if (typeof record(payload).has_more !== 'boolean') throw new ApiError(502, 'invalid_response')
      return { items, hasMore: record(payload).has_more as boolean }
    }
    if (definition.pagination === 'offset') {
      let hasMore = items.length > limit
      if (items.length === limit && limit === max) {
        // At the server cap, keep the complete page and look ahead separately.
        const next = await this.get(definition.path, { ...serverQuery, offset: offset + limit, limit: 1 }, signal)
        hasMore = rows(next, definition.listKey).length > 0
      }
      return { items: items.slice(0, limit), hasMore }
    }
    const bounded = definition.pagination === 'limit' && items.length >= max
    if (kind === 'opening-wip') items = items.flatMap(row => rows(row, 'batches').map(batch => ({ ...record(row.intake), ...batch, intake: row.intake, batch })))
    const q = text(query.q, '').trim().toLocaleLowerCase('uz')
    if (q && definition.search === 'local') items = items.filter(row => matchesSearch(row, q))
    return paginate
      ? { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit, bounded }
      : { items, hasMore: false, bounded }
  }

  async detail(kind: ResourceKind, row: Row, signal?: AbortSignal): Promise<Row> {
    const identity = text(row[resourceDefinitions[kind].identity], '')
    if (!identity) return row
    if (kind === 'orders' || kind === 'maps') {
      const saved = record(await this.get(`${base}/production-maps`, { id: identity }, signal))
      const map = record(saved.map)
      return { ...row, ...map, map, program: record(saved.program) }
    }
    if (kind === 'pending') return record(await this.get(`${base}/pending-orders`, { id: identity }, signal))
    if (kind === 'apparatus') return record(await this.get(`${base}/apparatus/${encodeURIComponent(identity)}`, undefined, signal))
    if (kind === 'warehouses') {
      const summary = await this.warehouseSummary(identity, signal)
      return { ...row, ...(summary || {}) }
    }
    if (['items', 'workers', 'suppliers', 'customers'].includes(kind)) {
      const param = kind === 'items' ? 'code' : kind === 'workers' ? 'id' : 'ref'
      return stripCredentials(kind, record(await this.get(`${base}/${kind}/detail`, { [param]: identity }, signal)))
    }
    if (kind === 'users') {
      const role = text(row.principal_role, '')
      const ref = text(row.entity_ref, '')
      if (!['supplier', 'customer', 'aparatchi', 'material_taminotchi', 'qolipchi', 'boyoqchi', 'tayyorlov_masteri', 'homashyo_rezkachi'].includes(role) || !ref) return row
      const path = role === 'supplier' ? 'suppliers/detail' : role === 'customer' ? 'customers/detail' : role === 'aparatchi' ? 'workers/detail' : role === 'material_taminotchi' ? 'material-taminotchilar/detail' : 'system-users/detail'
      return stripCredentials('users', record(await this.get(`${base}/${path}`, { [role === 'supplier' || role === 'customer' || role === 'material_taminotchi' ? 'ref' : 'id']: ref }, signal)))
    }
    return row
  }

  async create(kind: CreateResourceKind, body: Row, signal?: AbortSignal): Promise<Row> {
    const path = resourceDefinitions[kind].createPath
    if (!path) throw new Error('Bu bo‘limda yaratish amali mavjud emas.')
    return stripCredentials(kind, record(await this.post(path, body, signal)))
  }

  async createSystemUser(body: { role: string; name: string; phone: string }, signal?: AbortSignal): Promise<Row> {
    if (!['qolipchi', 'boyoqchi', 'tayyorlov_masteri', 'homashyo_rezkachi'].includes(body.role)) throw new Error('Foydalanuvchi vazifasini tanlang.')
    return stripCredentials('users', record(await this.post(`${base}/system-users`, body, signal)))
  }

  async calculate(input: CalculatorInput, signal?: AbortSignal): Promise<Row> {
    const result = record(await this.post('/v1/mobile/calculate', input, signal))
    const numeric = ['kg', 'frame_product_size_mm', 'frame_count', 'edge_allowance_mm', 'width_mm', 'min_mold_size_mm', 'rubber_size_mm', 'waste_percent']
    if (result.ok !== true || numeric.some(key => typeof result[key] !== 'number' || !Number.isFinite(result[key])) || rows(result, 'results').length === 0 || rows(result, 'results').some(row => ['film_gsm', 'adhesive_gsm', 'total_gsm', 'base_length', 'waste_length', 'rounded_length'].some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key])))) throw new ApiError(502, 'invalid_response', 'Hisoblash natijasi to‘liq kelmadi.')
    rows(result, 'layers')
    return result
  }

  async calculateMaterials(query: Query = {}, signal?: AbortSignal): Promise<Page> {
    const materials = rows(await this.get(resourceDefinitions.materials.path, undefined, signal), 'materials')
    const needle = text(query.q, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    return pageRows(materials.filter(material => material.active === true && (!needle || text(material.name, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle))), query)
  }

  async calculateProducts(query: CalculateProductQuery = {}, signal?: AbortSignal): Promise<Page> {
    const customerRef = query.customerRef?.trim()
    if (!customerRef) {
      const page = await this.list('items', { q: query.q, offset: query.offset, limit: query.limit, group: 'Tayyor mahsulot' }, signal)
      return { ...page, items: page.items.filter(item => text(item.item_group, '').trim().toLowerCase() === 'tayyor mahsulot') }
    }
    const detail = record(await this.get(`${base}/customers/detail`, { ref: customerRef }, signal))
    const items = rows(detail, 'assigned_items').filter(item => text(item.item_group, '').trim().toLowerCase() === 'tayyor mahsulot' && productMatches(item, query.q || ''))
    return pageRows(items, { offset: query.offset, limit: query.limit })
  }

  async productCustomer(itemCode: string, signal?: AbortSignal): Promise<Row | null> {
    const code = itemCode.trim()
    if (!code) return null
    const detail = record(await this.get(`${base}/items/detail`, { code }, signal))
    const customers = rows(detail, 'customers').filter(customer => text(customer.ref, '').trim())
    const selected = customers.find(customer => text(customer.name, '').trim().toLowerCase() !== 'saidamin') ?? customers[0]
    return selected ? stripCredentials('customers', selected) : null
  }

  async uploadOrderImage(file: Blob, fileName: string, signal?: AbortSignal): Promise<Row> {
    const mime = file.type.split(';')[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime)) throw new Error('JPEG, PNG yoki WebP rasmni tanlang.')
    if (!file.size || file.size > 6 * 1024 * 1024) throw new Error('Rasm hajmi 6 MB dan oshmasligi kerak.')
    // Fetch headers are Latin-1; keep non-ASCII filenames from rejecting the upload.
    const name = fileName.replace(/[\/\\\0\r\n]/g, '').replace(/[^\x20-\x7e]/gu, '_').trim() || 'rang'
    const result = record(await this.request('/v1/mobile/calculate/orders/image', 'POST', { rawBody: file, headers: { 'Content-Type': mime, 'X-File-Name': name }, signal }))
    const image = record(result.image)
    if (result.ok !== true || ['image_id', 'image_name', 'image_mime', 'image_url'].some(key => typeof image[key] !== 'string' || !text(image[key], '').trim()) || !Number.isSafeInteger(image.image_size_bytes) || Number(image.image_size_bytes) <= 0) throw new ApiError(502, 'invalid_response', 'Rasm yuklash natijasi to‘liq kelmadi.')
    return image
  }

  async autoOpenOrder(template: Row, signal?: AbortSignal): Promise<Row> {
    return orderSaveResult(await this.post(`${base}/production-maps/auto-open`, { template }, signal))
  }

  async saveProductionMapWithOrder(map: Row, template: CalculateOrderTemplate, signal?: AbortSignal): Promise<Row> {
    const result = orderSaveResult(await this.put(`${base}/production-maps/with-order`, { map, template }, undefined, signal))
    const savedMap = record(record(result.saved).map)
    // Only the backend can replace a new editor draft with its order identity.
    if (text(map.id, '').trim().toLowerCase().startsWith('zakaz-draft-') && (savedMap.id !== `zakaz-${savedMap.order_number}` || savedMap.code !== savedMap.order_number)) throw new ApiError(502, 'invalid_response', 'Buyurtma raqami tasdiqlanmadi. Ro‘yxatni yangilang.')
    return result
  }

  async decideCompletion(eventId: string, decision: 'approve' | 'reject', signal?: AbortSignal): Promise<Row> {
    const result = record(await this.post(`${base}/production-maps/completion-requests/decision`, { event_id: eventId, decision }, signal))
    const returned = record(result.decision)
    if (result.ok !== true || returned.request_event_id !== eventId || returned.decision !== (decision === 'approve' ? 'approved' : 'rejected')) throw new ApiError(502, 'invalid_response', 'Qaror natijasi tasdiqlanmadi. Ro‘yxatni yangilang.')
    return result
  }

  async settings(signal?: AbortSignal): Promise<Row> {
    const settings = { ...record(await this.get(`${base}/settings`, undefined, signal)) }
    delete settings.werka_code
    return settings
  }
  async saveSettings(input: SettingsInput, signal?: AbortSignal): Promise<Row> {
    // PUT expects the full AdminSettings contract, including lock metadata.
    const current = await this.settings(signal)
    const body: Row = { ...current, werka_code: '' }
    for (const key of ['default_target_warehouse', 'default_uom', 'werka_name', 'werka_phone'] as const) body[key] = input[key]
    const saved = { ...record(await this.put(`${base}/settings`, body, undefined, signal)) }
    delete saved.werka_code
    return saved
  }
  async monitor(signal?: AbortSignal): Promise<Row> { return record(await this.get(`${base}/system/monitor`, undefined, signal)) }
  async serverStatus(signal?: AbortSignal): Promise<Row> { return this.monitor(signal) }

  async warehouseSummary(warehouse: string, signal?: AbortSignal): Promise<Row | null> {
    const summaries = rows(await this.get(`${base}/warehouses/summary`, { q: warehouse, limit: 500 }, signal))
    return summaries.find(summary => summary.warehouse === warehouse) || null
  }

  async stockRolls(query: Query, signal?: AbortSignal): Promise<Page> {
    if (!text(query.warehouse, '').trim() || !text(query.item_code, '').trim()) throw new Error('Ombor va mahsulotni tanlang.')
    const limit = Math.max(1, Math.min(Number(query.limit) || 25, 499))
    const items = rows(await this.get(`${base}/warehouses/items/rolls`, { warehouse: query.warehouse, item_code: query.item_code, order_id: query.order_id, offset: query.offset ?? 0, limit: limit + 1 }, signal))
    return { items: items.slice(0, limit), hasMore: items.length > limit }
  }
}

export const workerLevels = ['Brigader', 'Master', '1 - darajali', '2 - darajali', '3 - darajali'] as const
