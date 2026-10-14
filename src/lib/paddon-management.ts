import { ApiClient, ApiError, isRecord } from './api'
import type { Session } from './api-types'
import { hasCapability } from './permissions'

export const paddonManagementPath = '/v1/mobile/admin/production-maps/paddons/management-settings'
export interface PaddonManagementSettings {
  readonly free_movement_enabled: boolean
  readonly worker_visibility_enabled: boolean
}
export interface PaddonManagementOperation {
  readonly kind: 'free-movement'
  readonly input: Readonly<{ free_movement_enabled: boolean }>
  readonly baseline: PaddonManagementSettings
}
export interface PaddonManagementObservation {
  readonly settings: PaddonManagementSettings
  /** A matching read describes current state; it never proves who performed the PUT. */
  readonly state: 'matches' | 'different'
}
export type PaddonManagementDispatchGate = () => boolean | void

const readCapabilities = ['admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage']
const sentOperations = new WeakSet<PaddonManagementOperation>()
const nativeTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
function invalid(): never { throw new ApiError(502, 'invalid_response', 'Paddon sozlamalari to‘liq tasdiqlanmadi. Serverdagi joriy holatni tekshiring.') }
function aborted(): never { throw new DOMException('So‘rov bekor qilindi.', 'AbortError') }
function settingsProjection(value: unknown): PaddonManagementSettings {
  if (!isRecord(value) || typeof value.free_movement_enabled !== 'boolean' || typeof value.worker_visibility_enabled !== 'boolean') return invalid()
  return Object.freeze({ free_movement_enabled: value.free_movement_enabled, worker_visibility_enabled: value.worker_visibility_enabled })
}
export function canReadPaddonManagement(session: Session | null | undefined): boolean { return readCapabilities.some(code => hasCapability(session, code)) }
/** Capability assignment does not change the principal's actual role. */
export function canManagePaddonManagement(session: Session | null | undefined): boolean { return hasCapability(session, 'admin.access') && session?.profile.role === 'admin' }
export function parsePaddonManagementSettings(value: unknown): PaddonManagementSettings {
  if (!isRecord(value) || value.ok !== true) return invalid()
  return settingsProjection(value.settings)
}
export function samePaddonManagementSettings(left: PaddonManagementSettings, right: PaddonManagementSettings): boolean {
  return left.free_movement_enabled === right.free_movement_enabled && left.worker_visibility_enabled === right.worker_visibility_enabled
}
export function freeMovementOperation(value: PaddonManagementSettings, enabled: boolean): PaddonManagementOperation {
  if (typeof enabled !== 'boolean') throw new ApiError(400, 'paddon_invalid_input')
  const baseline = settingsProjection(value), input = Object.freeze({ free_movement_enabled: enabled })
  return Object.freeze({ kind: 'free-movement', input, baseline })
}
function validateOperation(operation: PaddonManagementOperation): void {
  if (!isRecord(operation) || operation.kind !== 'free-movement' || Object.keys(operation).some(key => !['kind', 'input', 'baseline'].includes(key))
    || !isRecord(operation.input) || Object.keys(operation.input).length !== 1 || typeof operation.input.free_movement_enabled !== 'boolean'
    || !isRecord(operation.baseline) || Object.keys(operation.baseline).some(key => !['free_movement_enabled', 'worker_visibility_enabled'].includes(key))
    || !Object.isFrozen(operation) || !Object.isFrozen(operation.input) || !Object.isFrozen(operation.baseline)) throw new ApiError(400, 'paddon_invalid_input', 'Paddon sozlamasi uchun yangi, tasdiqlangan amal yarating.')
  settingsProjection(operation.baseline)
}
export class PaddonManagementConflict extends Error {
  readonly current: PaddonManagementSettings
  constructor(current: PaddonManagementSettings) {
    super('Paddon sozlamalari boshqa joyda o‘zgargan. Joriy holatni ko‘rib, amalni qayta boshlang.')
    this.name = 'PaddonManagementConflict'; this.current = current
  }
}
export class PaddonManagementUnknown extends Error {
  readonly operation: PaddonManagementOperation
  constructor(operation: PaddonManagementOperation) {
    super('Paddon sozlamasini saqlash natijasi noma’lum. Amal shu sessiya xotirasida saqlandi; so‘rov qayta yuborilmaydi. Serverdagi joriy holatni tekshiring.')
    this.name = 'PaddonManagementUnknown'; this.operation = operation
  }
}

/** Native partial PUT only. The GET preflight is not server-side CAS or a write receipt. */
export class PaddonManagementApi {
  private readonly client: ApiClient
  private readonly session: Session
  private readonly actor: Readonly<{ role: string; ref: string }>
  private readonly isCurrentScope: () => boolean
  constructor(client: ApiClient, session: Session, isCurrentScope: () => boolean = () => true) {
    this.client = client; this.session = session
    this.actor = Object.freeze({ role: session.profile.role, ref: nativeTrim(session.profile.ref ?? '') })
    this.isCurrentScope = isCurrentScope
  }
  private gate(signal?: AbortSignal): void {
    if (signal?.aborted || !this.isCurrentScope() || this.session.profile.role !== this.actor.role || nativeTrim(this.session.profile.ref ?? '') !== this.actor.ref) aborted()
  }
  private requireRead(): void { if (!canReadPaddonManagement(this.session)) throw new ApiError(403, 'forbidden') }
  private requireWrite(): void {
    if (!canManagePaddonManagement(this.session)) throw new ApiError(403, 'forbidden')
    if (!nativeTrim(this.session.profile.ref ?? '')) throw new ApiError(400, 'paddon_invalid_input')
  }
  async settings(signal?: AbortSignal): Promise<PaddonManagementSettings> {
    this.gate(signal); this.requireRead()
    const saved = parsePaddonManagementSettings(await this.client.request(paddonManagementPath, 'GET', { signal, expectedStatus: 200 }))
    this.gate(signal); return saved
  }
  async execute(operation: PaddonManagementOperation, signal?: AbortSignal, beforeDispatch?: PaddonManagementDispatchGate): Promise<PaddonManagementSettings> {
    this.gate(signal); this.requireWrite(); validateOperation(operation)
    if (sentOperations.has(operation)) throw new Error('Bu paddon sozlamasi amali allaqachon yuborilgan. So‘rov takrorlanmaydi.')
    const current = await this.settings(signal); this.gate(signal)
    if (!samePaddonManagementSettings(current, operation.baseline)) throw new PaddonManagementConflict(current)
    this.requireWrite(); this.gate(signal)
    if (beforeDispatch?.() === false) aborted()
    this.gate(signal); this.requireWrite()
    // This plan is single-use at the application dispatch boundary, including lost replies.
    if (sentOperations.has(operation)) throw new Error('Bu paddon sozlamasi amali allaqachon yuborilgan. So‘rov takrorlanmaydi.')
    sentOperations.add(operation)
    try {
      const saved = parsePaddonManagementSettings(await this.client.request(paddonManagementPath, 'PUT', { body: { free_movement_enabled: operation.input.free_movement_enabled }, signal, expectedStatus: 200 }))
      this.gate(signal)
      if (saved.free_movement_enabled !== operation.input.free_movement_enabled) return invalid()
      // Visibility is returned for display only; the body never sends it or a baseline/version.
      return saved
    } catch (error) {
      if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500 || [408, 429].includes(error.status) || error.code === 'invalid_response') throw new PaddonManagementUnknown(operation)
      throw error
    }
  }
  async observe(operation: PaddonManagementOperation, signal?: AbortSignal): Promise<PaddonManagementObservation> {
    validateOperation(operation)
    const settings = await this.settings(signal); this.gate(signal)
    return Object.freeze({ settings, state: settings.free_movement_enabled === operation.input.free_movement_enabled ? 'matches' : 'different' })
  }
}

export interface PaddonManagementIntent {
  readonly operation: PaddonManagementOperation
  readonly status: 'pending' | 'unknown'
  readonly dispatched: boolean
  readonly observation?: PaddonManagementObservation
}
/** RAM only, keyed by the caller's actor/session scope. No storage or automatic replay. */
export class PaddonManagementIntentLedger {
  private intent: PaddonManagementIntent | null = null
  private readonly listeners = new Set<() => void>()
  snapshot = (): PaddonManagementIntent | null => this.intent
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(intent: PaddonManagementIntent | null): void { this.intent = intent && Object.freeze(intent); this.listeners.forEach(listener => listener()) }
  begin(operation: PaddonManagementOperation): void {
    validateOperation(operation)
    if (this.intent || sentOperations.has(operation)) throw new Error('Avvalgi paddon sozlamasi amali natijasini tekshiring. So‘rov takrorlanmaydi.')
    this.publish({ operation, status: 'pending', dispatched: false })
  }
  /** False is an expired reservation; pass it back to execute's dispatch gate. */
  dispatched(operation: PaddonManagementOperation): boolean {
    if (this.intent?.operation !== operation || this.intent.status !== 'pending' || this.intent.dispatched) return false
    this.publish({ operation, status: 'pending', dispatched: true }); return true
  }
  unknown(operation: PaddonManagementOperation): void {
    if (this.intent?.operation === operation && this.intent.status === 'pending' && this.intent.dispatched) this.publish({ operation, status: 'unknown', dispatched: true })
  }
  finish(operation: PaddonManagementOperation): void { if (this.intent?.operation === operation && this.intent.status === 'pending') this.publish(null) }
  interrupt(operation: PaddonManagementOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'pending') return
    if (this.intent.dispatched) this.unknown(operation)
    else this.publish(null)
  }
  observe(operation: PaddonManagementOperation, observation: PaddonManagementObservation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown') return
    const settings = settingsProjection(observation.settings)
    // Derive the comparison from the frozen intent, rather than trust a caller's label.
    const state = settings.free_movement_enabled === operation.input.free_movement_enabled ? 'matches' : 'different'
    this.publish({ operation, status: 'unknown', dispatched: true, observation: Object.freeze({ settings, state }) })
  }
  resolveReviewed(operation: PaddonManagementOperation): void {
    if (this.intent?.operation !== operation || this.intent.status !== 'unknown' || !this.intent.observation) throw new Error('Avval serverdagi joriy paddon sozlamalarini tekshiring.')
    this.publish(null)
  }
}
const ledgers = new Map<string, PaddonManagementIntentLedger>()
export function paddonManagementIntentLedger(scope: string): PaddonManagementIntentLedger {
  if (!scope.trim()) throw new Error('Paddon sozlamasi amali uchun sessiya doirasi kerak.')
  let ledger = ledgers.get(scope); if (!ledger) { ledger = new PaddonManagementIntentLedger(); ledgers.set(scope, ledger) }; return ledger
}
export function paddonManagementError(error: unknown): string { return error instanceof Error ? error.message : 'Paddon sozlamasi tasdiqlanmadi.' }
