import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './api'
import type { Profile, Session } from './api-types'
import { ENDPOINT_KEY, SESSION_KEY, SessionManager, readStoredSession, serializeSession } from './session'

const endpoint = 'https://erp.example.com'

function session(token = 'saved-token', ref = 'admin-1'): Session {
  return {
    token,
    profile: { role: 'admin', display_name: 'Administrator', ref },
    capabilities: ['admin.access'],
    assigned_apparatus: [], assigned_apparatus_labels: [],
    assigned_item_groups: [], assigned_warehouses: [],
  }
}

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function savedStorage(saved = session()) {
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  localStorage.setItem(ENDPOINT_KEY, endpoint)
  sessionStorage.setItem(SESSION_KEY, serializeSession(endpoint, saved))
  return { localStorage, sessionStorage }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

type ClientOptions = ConstructorParameters<typeof ApiClient>[0]

function fakeClient(options: Partial<Pick<ApiClient, 'me' | 'login' | 'logout'>> = {}): ApiClient {
  return {
    me: vi.fn().mockResolvedValue(session().profile),
    login: vi.fn().mockResolvedValue(session()),
    logout: vi.fn().mockResolvedValue(undefined),
    ...options,
  } as unknown as ApiClient
}

describe('browser session storage', () => {
  it('keeps this tab bound to its saved ERP when another tab changes the last-used endpoint', () => {
    const storage = savedStorage()
    storage.localStorage.setItem(ENDPOINT_KEY, 'https://another.example.com')
    const manager = new SessionManager({ ...storage, createClient: () => fakeClient() })
    expect(manager.getSnapshot()).toMatchObject({ endpoint, session: { token: 'saved-token' } })
    expect(storage.localStorage.getItem(ENDPOINT_KEY)).toBe('https://another.example.com')
  })

  it('restores only an exact ERP endpoint and requires administrator capability', () => {
    const raw = serializeSession(endpoint, session())
    expect(readStoredSession(raw, endpoint)?.token).toBe('saved-token')
    expect(readStoredSession(raw, 'https://another.example.com')).toBeNull()
    expect(readStoredSession(raw, `${endpoint}/`)).toBeNull()
    const saved = JSON.parse(raw)
    saved.session.capabilities = ['warehouse.read']
    expect(readStoredSession(JSON.stringify(saved), endpoint)).toBeNull()
  })

  it('keeps token, profile and resource scopes while omitting phone, login code and unknown fields', () => {
    const contaminated = {
      ...session(), code: 'secret-code', phone: '+998901234567',
      profile: { ...session().profile, phone: '+998901234567', code: 'secret-code' },
      assigned_warehouses: ['Warehouse A'], business_data: { orders: [1, 2] },
    }
    const raw = serializeSession(endpoint, contaminated)
    expect(raw).not.toContain('secret-code')
    expect(raw).not.toContain('+998901234567')
    expect(raw).not.toContain('business_data')
    expect(readStoredSession(raw, endpoint)?.assigned_warehouses).toEqual(['Warehouse A'])
  })

  it('rejects corrupted or incomplete storage rather than trusting a cast', () => {
    expect(readStoredSession('{', endpoint)).toBeNull()
    expect(readStoredSession('null', endpoint)).toBeNull()
    const saved = JSON.parse(serializeSession(endpoint, session()))
    saved.session.assigned_warehouses = [42]
    expect(readStoredSession(JSON.stringify(saved), endpoint)).toBeNull()
    saved.session.assigned_warehouses = []
    saved.session.profile.ref = {}
    expect(readStoredSession(JSON.stringify(saved), endpoint)).toBeNull()
  })
})

describe('session restoration', () => {
  it('updates connectivity from current API traffic while retaining the draft session and cache', async () => {
    const storage = savedStorage()
    const clients: ClientOptions[] = []
    const clear = vi.fn()
    const manager = new SessionManager({ ...storage, onIdentityChange: clear, createClient: (options) => {
      clients.push(options)
      return fakeClient({ me: vi.fn().mockRejectedValue(new ApiError(0, 'network')) })
    } })
    const sessionClient = clients[0]
    await manager.restore()
    const original = manager.getSnapshot()
    expect(original.connection).toBe('offline')
    sessionClient.onConnectionChange?.(true)
    expect(manager.getSnapshot()).toMatchObject({ connection: 'online', scope: original.scope, session: { token: 'saved-token' } })
    sessionClient.onConnectionChange?.(false)
    expect(manager.getSnapshot().connection).toBe('offline')
    expect(clear).not.toHaveBeenCalled()
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toContain('saved-token')
    manager.enterDemo()
    sessionClient.onConnectionChange?.(false)
    expect(manager.getSnapshot()).toMatchObject({ demo: true, connection: 'online' })
  })

  it('does not let an earlier failed connection check replace a later successful API response', async () => {
    const pending = deferred<Profile>()
    const clients: ClientOptions[] = []
    const manager = new SessionManager({ ...savedStorage(), createClient: (options) => {
      clients.push(options)
      return fakeClient({ me: vi.fn(() => pending.promise) })
    } })
    const reconnecting = manager.reconnect()
    clients[0].onConnectionChange?.(true)
    pending.reject(new ApiError(0, 'network'))
    await reconnecting
    expect(manager.getSnapshot()).toMatchObject({ connection: 'online', restoring: false, session: { token: 'saved-token' } })
  })

  it('checks a manual reconnection without hiding the active page or clearing its cache', async () => {
    const storage = savedStorage()
    const pending = deferred<Profile>()
    const clear = vi.fn()
    const manager = new SessionManager({
      ...storage, onIdentityChange: clear,
      createClient: () => fakeClient({ me: vi.fn(() => pending.promise) }),
    })
    const checking = manager.reconnect()
    expect(manager.getSnapshot()).toMatchObject({ restoring: false, connection: 'checking', session: { token: 'saved-token' } })
    pending.resolve(session().profile)
    await checking
    expect(manager.getSnapshot()).toMatchObject({ restoring: false, connection: 'online' })
    expect(clear).not.toHaveBeenCalled()
  })

  it.each([
    new TypeError('Network unavailable'),
    new ApiError(0, 'network_error'),
    new ApiError(503, 'server_unavailable'),
  ])('preserves a saved session when the server cannot be reached: %s', async (error) => {
    const storage = savedStorage()
    const cached = storage.sessionStorage.getItem(SESSION_KEY)
    const clear = vi.fn()
    const manager = new SessionManager({
      ...storage, onIdentityChange: clear,
      createClient: () => fakeClient({ me: vi.fn().mockRejectedValue(error) }),
    })
    await manager.restore()
    expect(manager.getSnapshot()).toMatchObject({
      session: { token: 'saved-token' }, restoring: false, connection: 'offline', demo: false,
    })
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toBe(cached)
    expect(clear).not.toHaveBeenCalled()
  })

  it('clears the session and current query cache for a confirmed HTTP 401', async () => {
    const storage = savedStorage()
    const clear = vi.fn()
    const manager = new SessionManager({
      ...storage, onIdentityChange: clear,
      createClient: () => fakeClient({ me: vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized')) }),
    })
    await manager.restore()
    expect(manager.getSnapshot()).toMatchObject({ session: null, client: null, restoring: false })
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toBeNull()
    expect(clear).toHaveBeenCalledOnce()
  })

  it.each([
    { ...session().profile, ref: 'different-admin' },
    { ...session().profile, role: 'werka' },
  ])('rejects a /me response for a changed identity: %j', async (profile) => {
    const storage = savedStorage()
    const manager = new SessionManager({
      ...storage, createClient: () => fakeClient({ me: vi.fn().mockResolvedValue(profile) }),
    })
    await manager.restore()
    expect(manager.getSnapshot().session).toBeNull()
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('refreshes the profile when the identity still matches', async () => {
    const storage = savedStorage()
    const manager = new SessionManager({
      ...storage, createClient: () => fakeClient({
        me: vi.fn().mockResolvedValue({ ...session().profile, display_name: 'Updated admin', phone: 'private-phone' }),
      }),
    })
    await manager.restore()
    expect(manager.getSnapshot()).toMatchObject({ session: { profile: { display_name: 'Updated admin' } }, connection: 'online' })
    expect(storage.sessionStorage.getItem(SESSION_KEY)).not.toContain('private-phone')
  })
})

describe('identity isolation', () => {
  it.each([['   ', '1234'], ['+998901234567', '   ']])('rejects blank login credentials before changing a valid session', async (phone, code) => {
    const storage = savedStorage()
    const login = vi.fn().mockResolvedValue(session('new-token'))
    const manager = new SessionManager({ ...storage, createClient: () => fakeClient({ login }) })
    await expect(manager.login(endpoint, phone, code)).rejects.toThrow('kirish kodini')
    expect(manager.getSnapshot().session?.token).toBe('saved-token')
    expect(login).not.toHaveBeenCalled()
  })

  it('aborts a previous restore and ignores its late response after another ERP login', async () => {
    const storage = savedStorage()
    const old = deferred<Profile>()
    let oldSignal: AbortSignal | undefined
    const manager = new SessionManager({
      ...storage,
      createClient: () => fakeClient({
        me: vi.fn((signal?: AbortSignal) => { oldSignal = signal; return old.promise }),
        login: vi.fn().mockResolvedValue(session('new-token', 'admin-2')),
      }),
    })
    const restoring = manager.restore()
    await manager.login('another.example.com', '+998901234567', '1234')
    expect(oldSignal?.aborted).toBe(true)
    old.resolve({ ...session().profile, display_name: 'Stale profile' })
    await restoring
    expect(manager.getSnapshot()).toMatchObject({
      endpoint: 'https://another.example.com', session: { token: 'new-token', profile: { ref: 'admin-2' } },
    })
    expect(readStoredSession(storage.sessionStorage.getItem(SESSION_KEY), 'https://another.example.com')?.token).toBe('new-token')
  })

  it('keeps demo local and ignores a late 401 from the former real session', async () => {
    const storage = savedStorage()
    const old = deferred<Profile>()
    const createClient = vi.fn(() => fakeClient({ me: vi.fn(() => old.promise) }))
    const clear = vi.fn()
    const manager = new SessionManager({ ...storage, createClient, onIdentityChange: clear })
    const restoring = manager.restore()
    const callsBeforeDemo = createClient.mock.calls.length
    manager.enterDemo()
    old.reject(new ApiError(401, 'unauthorized'))
    await restoring
    expect(manager.getSnapshot()).toMatchObject({ demo: true, client: null, connection: 'online', restoring: false })
    expect(manager.getSnapshot().session).not.toBeNull()
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toBeNull()
    expect(createClient).toHaveBeenCalledTimes(callsBeforeDemo)
    expect(clear).toHaveBeenCalledOnce()
  })

  it('does not restore a late login result after entering demo', async () => {
    const localStorage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    const pending = deferred<Session>()
    let signal: AbortSignal | undefined
    const manager = new SessionManager({
      localStorage, sessionStorage,
      createClient: () => fakeClient({ login: vi.fn((_phone: string, _code: string, input?: AbortSignal) => {
        signal = input
        return pending.promise
      }) }),
    })
    const loggingIn = manager.login(endpoint, '+998901234567', 'private-code')
    manager.enterDemo()
    expect(signal?.aborted).toBe(true)
    pending.resolve(session())
    await loggingIn
    expect(manager.getSnapshot().demo).toBe(true)
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull()
    expect([...localStorage.values.values()].join()).not.toContain('private-code')
  })

  it('ignores an old client 401 callback but expires the current client session', async () => {
    const storage = savedStorage()
    const clients: ClientOptions[] = []
    const manager = new SessionManager({
      ...storage, createClient: (options) => {
        clients.push(options)
        return fakeClient({ login: vi.fn().mockResolvedValue(session('new-token', 'admin-2')) })
      },
    })
    const oldCallback = clients[0].onUnauthorized
    await manager.login(endpoint, '+998901234567', '1234')
    oldCallback?.()
    expect(manager.getSnapshot().session?.token).toBe('new-token')
    clients.at(-1)?.onUnauthorized?.()
    expect(manager.getSnapshot().session).toBeNull()
  })

  it('clears locally before logout completes and never clears a later login', async () => {
    const storage = savedStorage()
    const loggingOut = deferred<void>()
    const manager = new SessionManager({
      ...storage, createClient: () => fakeClient({
        logout: vi.fn(() => loggingOut.promise), login: vi.fn().mockResolvedValue(session('new-token')),
      }),
    })
    const logout = manager.logout()
    expect(manager.getSnapshot().session).toBeNull()
    await manager.login(endpoint, '+998901234567', '1234')
    loggingOut.reject(new TypeError('Offline'))
    await logout
    expect(manager.getSnapshot().session?.token).toBe('new-token')
  })

  it('rejects non-admin login without persisting authentication', async () => {
    const storage = { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() }
    const manager = new SessionManager({
      ...storage, createClient: () => fakeClient({ login: vi.fn().mockResolvedValue({ ...session(), capabilities: ['warehouse.read'] }) }),
    })
    await expect(manager.login(endpoint, '+998901234567', '1234')).rejects.toThrow('administrator')
    expect(manager.getSnapshot().session).toBeNull()
    expect(storage.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })
})
