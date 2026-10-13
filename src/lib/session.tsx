import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsWithChildren } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiClient, ApiError, isAdminSession, normalizeEndpoint } from './api'
import type { Profile, Session } from './api-types'
import { demoSession } from './demo'

export const SESSION_KEY = 'accord.web.v2.session'
export const ENDPOINT_KEY = 'accord.web.v2.endpoint'

type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type Connection = 'online' | 'offline' | 'checking'
type ClientOptions = ConstructorParameters<typeof ApiClient>[0]

interface Snapshot {
  session: Session | null
  client: ApiClient | null
  endpoint: string
  demo: boolean
  restoring: boolean
  connection: Connection
  scope: string
}

interface ManagerOptions {
  localStorage?: StorageAccess | null
  sessionStorage?: StorageAccess | null
  createClient?: (options: ClientOptions) => ApiClient
  onIdentityChange?: () => void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): StorageAccess | null {
  try { return typeof window === 'undefined' ? null : window[kind] }
  catch { return null }
}

function read(storage: StorageAccess | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null }
  catch { return null }
}

function write(storage: StorageAccess | null, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch { /* Browsers can disable storage; the active in-memory session still works. */ }
}

function cleanProfile(value: unknown): Profile | null {
  if (!record(value) || typeof value.role !== 'string' || !value.role.trim()
    || typeof value.display_name !== 'string') return null
  const result: Profile = { role: value.role, display_name: value.display_name }
  for (const key of ['ref', 'legal_name', 'avatar_url'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null
    if (typeof value[key] === 'string') result[key] = value[key]
  }
  return result
}

function cleanSession(value: unknown): Session | null {
  if (!record(value) || typeof value.token !== 'string' || !value.token.trim()) return null
  const profile = cleanProfile(value.profile)
  if (!profile) return null
  const arrays: Record<string, string[]> = {}
  for (const key of ['capabilities', 'assigned_apparatus', 'assigned_apparatus_labels', 'assigned_item_groups', 'assigned_warehouses']) {
    const array = value[key]
    if (!Array.isArray(array) || !array.every((item: unknown) => typeof item === 'string')) return null
    arrays[key] = [...array] as string[]
  }
  return {
    token: value.token,
    profile,
    capabilities: arrays.capabilities,
    assigned_apparatus: arrays.assigned_apparatus,
    assigned_apparatus_labels: arrays.assigned_apparatus_labels,
    assigned_item_groups: arrays.assigned_item_groups,
    assigned_warehouses: arrays.assigned_warehouses,
  }
}

/** Persist only the session contract; phone numbers and login codes are omitted. */
export function serializeSession(endpoint: string, session: Session): string {
  const cleaned = cleanSession(session)
  if (!cleaned || !isAdminSession(cleaned)) throw new Error('Administrator sessiyasi talab qilinadi.')
  return JSON.stringify({ version: 1, endpoint, session: cleaned })
}

export function readStoredSession(raw: string | null, endpoint: string): Session | null {
  if (!raw || !endpoint) return null
  try {
    const saved: unknown = JSON.parse(raw)
    if (!record(saved) || saved.version !== 1 || saved.endpoint !== endpoint) return null
    const session = cleanSession(saved.session)
    return session && isAdminSession(session) ? session : null
  } catch { return null }
}

export class SessionManager {
  private state: Snapshot
  private listeners = new Set<() => void>()
  private epoch = 0
  private connectionRevision = 0
  private pending: AbortController | null = null
  private sessionStorage: StorageAccess | null
  private localStorage: StorageAccess | null
  private createClient: (options: ClientOptions) => ApiClient
  private onIdentityChange: () => void

  constructor(options: ManagerOptions = {}) {
    this.sessionStorage = 'sessionStorage' in options ? options.sessionStorage ?? null : safeStorage('sessionStorage')
    this.localStorage = 'localStorage' in options ? options.localStorage ?? null : safeStorage('localStorage')
    this.createClient = options.createClient ?? ((clientOptions) => new ApiClient(clientOptions))
    this.onIdentityChange = options.onIdentityChange ?? (() => {})
    let endpoint = ''
    const savedEndpoint = read(this.localStorage, ENDPOINT_KEY)
    if (savedEndpoint) {
      try { endpoint = normalizeEndpoint(savedEndpoint) }
      catch { write(this.localStorage, ENDPOINT_KEY, null) }
    }
    const rawSession = read(this.sessionStorage, SESSION_KEY)
    // A different tab's last-used server must not replace this tab's active ERP.
    try {
      const saved: unknown = JSON.parse(rawSession ?? 'null')
      if (record(saved) && typeof saved.endpoint === 'string') {
        const scopedEndpoint = normalizeEndpoint(saved.endpoint)
        if (readStoredSession(rawSession, scopedEndpoint)) endpoint = scopedEndpoint
      }
    } catch { /* Malformed storage falls back to the remembered server. */ }
    const session = readStoredSession(rawSession, endpoint)
    if (!session) write(this.sessionStorage, SESSION_KEY, null)
    this.state = {
      endpoint, session, client: null, demo: false, restoring: Boolean(session),
      connection: session ? 'checking' : 'offline', scope: this.scope(endpoint, session, false),
    }
    if (session) this.state.client = this.sessionClient(endpoint, session)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): Snapshot => this.state

  private update(patch: Partial<Snapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private scope(endpoint: string, session: Session | null, demo: boolean): string {
    return demo ? `demo:${this.epoch}` : session ? `${this.epoch}:${endpoint}:${session.profile.role}:${session.profile.ref ?? ''}` : ''
  }

  private sessionClient(endpoint: string, session: Session): ApiClient {
    const epoch = this.epoch
    return this.createClient({
      endpoint, token: session.token,
      onUnauthorized: () => {
        if (epoch === this.epoch && !this.state.demo && this.state.endpoint === endpoint
          && this.state.session?.token === session.token) this.switchIdentity(endpoint, null, false, 'offline')
      },
      onConnectionChange: (online) => {
        if (epoch !== this.epoch || this.state.demo || this.state.endpoint !== endpoint
          || this.state.session?.token !== session.token) return
        this.connectionRevision += 1
        const connection = online ? 'online' : 'offline'
        if (this.state.connection !== connection) this.update({ connection })
      },
    })
  }

  cancelPending = (): void => {
    this.pending?.abort()
    this.pending = null
  }

  private switchIdentity(endpoint: string, session: Session | null, demo: boolean, connection: Connection): void {
    this.epoch += 1
    this.cancelPending()
    this.onIdentityChange()
    write(this.sessionStorage, SESSION_KEY, session && !demo ? serializeSession(endpoint, session) : null)
    this.update({
      endpoint, session, demo, connection, restoring: false,
      client: session && !demo ? this.sessionClient(endpoint, session) : null,
      scope: this.scope(endpoint, session, demo),
    })
  }

  private isCurrent(epoch: number, controller: AbortController): boolean {
    return epoch === this.epoch && this.pending === controller && !controller.signal.aborted
  }

  login = async (rawEndpoint: string, phone: string, code: string): Promise<void> => {
    const endpoint = normalizeEndpoint(rawEndpoint)
    if (!phone.trim() || !code.trim()) throw new Error('Telefon raqami va kirish kodini kiriting.')
    this.switchIdentity(endpoint, null, false, 'checking')
    write(this.localStorage, ENDPOINT_KEY, endpoint)
    this.update({ restoring: true })
    const epoch = this.epoch
    const controller = new AbortController()
    this.pending = controller
    try {
      const returned = await this.createClient({ endpoint }).login(phone.trim(), code.trim(), controller.signal)
      if (!this.isCurrent(epoch, controller)) return
      const session = cleanSession(returned)
      if (!session) throw new Error('Serverdan sessiya ma’lumotlari to‘liq kelmadi.')
      if (!isAdminSession(session)) throw new Error('Bu web qismiga kirish uchun administrator huquqi talab qilinadi.')
      this.switchIdentity(endpoint, session, false, 'online')
    } catch (error) {
      if (!this.isCurrent(epoch, controller)) return
      this.pending = null
      this.update({ restoring: false, connection: error instanceof ApiError && error.status > 0 ? 'online' : 'offline' })
      throw error
    }
  }

  restore = async (blocking = true): Promise<void> => {
    const { endpoint, session, demo } = this.state
    if (!session || demo) return
    this.cancelPending()
    const epoch = this.epoch
    const controller = new AbortController()
    this.pending = controller
    this.update({ restoring: blocking, connection: 'checking' })
    const connectionRevision = this.connectionRevision
    try {
      // Validation uses a separate client: its late 401 must not invalidate a newer session.
      const returned = await this.createClient({ endpoint, token: session.token }).me(controller.signal)
      if (!this.isCurrent(epoch, controller)) return
      const profile = cleanProfile(returned)
      if (!profile || profile.role !== session.profile.role || profile.ref !== session.profile.ref) {
        this.switchIdentity(endpoint, null, false, 'offline')
        return
      }
      const refreshed = { ...session, profile }
      write(this.sessionStorage, SESSION_KEY, serializeSession(endpoint, refreshed))
      this.pending = null
      this.update({ session: refreshed, restoring: false, connection: 'online' })
    } catch (error) {
      if (!this.isCurrent(epoch, controller)) return
      if (error instanceof ApiError && error.status === 401) {
        this.switchIdentity(endpoint, null, false, 'offline')
      } else {
        this.pending = null
        this.update({ restoring: false, ...(this.connectionRevision === connectionRevision ? { connection: 'offline' as const } : {}) })
      }
    }
  }

  reconnect = (): Promise<void> => this.restore(false)

  logout = async (): Promise<void> => {
    const { client, endpoint, connection } = this.state
    this.switchIdentity(endpoint, null, false, connection === 'checking' ? 'offline' : connection)
    try { await client?.logout() }
    catch { /* Local sign-out also succeeds while the ERP server is unavailable. */ }
  }

  enterDemo = (): void => {
    this.switchIdentity(this.state.endpoint, demoSession, true, 'online')
  }
}

interface SessionContextValue extends Snapshot {
  login: (endpoint: string, phone: string, code: string) => Promise<void>
  logout: () => Promise<void>
  enterDemo: () => void
  reconnect: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const [manager] = useState(() => new SessionManager({
    onIdentityChange: () => {
      void queryClient.cancelQueries()
      queryClient.clear()
    },
  }))
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  useEffect(() => {
    void manager.restore()
    const reconnectIfOffline = () => {
      if (manager.getSnapshot().connection === 'offline') void manager.reconnect()
    }
    window.addEventListener('online', reconnectIfOffline)
    window.addEventListener('focus', reconnectIfOffline)
    return () => {
      manager.cancelPending()
      window.removeEventListener('online', reconnectIfOffline)
      window.removeEventListener('focus', reconnectIfOffline)
    }
  }, [manager])
  const value = useMemo(() => ({
    ...snapshot, login: manager.login, logout: manager.logout,
    enterDemo: manager.enterDemo, reconnect: manager.reconnect,
  }), [manager, snapshot])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession SessionProvider ichida ishlatilishi kerak.')
  return context
}
