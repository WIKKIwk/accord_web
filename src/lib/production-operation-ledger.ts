export type ProductionOperationChannel = 'assignment' | 'legacy-control' | 'completion' | 'material-intake' | 'material-link'

export interface ProductionOperation<Plan = unknown, Proof = unknown> {
  channel: ProductionOperationChannel
  orderId: string
  plan: Plan
  proof: Proof
  phase: 'pending' | 'uncertain'
  dispatched: boolean
  serial: number
  error?: string
}
export interface ProductionOperationLease {
  scope: string
  generation: number
  channel: ProductionOperationChannel
  orderId: string
  serial: number
  wasUncertain: boolean
}
export class ProductionOperationLedgerError extends Error {
  readonly kind = 'blocked'
  constructor(message: string) { super(message); this.name = 'ProductionOperationLedgerError' }
}
const blocked = (message: string): never => { throw new ProductionOperationLedgerError(message) }
function stable(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize) : entry !== null && typeof entry === 'object' ?
    Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)])) : entry
  return JSON.stringify(normalize(value))
}
const credentialFields = new Set(['token', 'authorization', 'password', 'accesstoken', 'refreshtoken', 'accesscode', 'logincode', 'avatarurl'])
function credentialFree(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (credentialFields.has(key.replace(/[_-]/g, '').toLowerCase())) blocked('Ishlab chiqarish amali xotirasida kirish ma’lumotlari saqlanmaydi.')
    credentialFree(child)
  }
}

/** RAM only. Each order has one owner across all production write panels. */
export class ProductionOperationLedger {
  private scope = ''
  private generation = 0
  private revision = 0
  private serial = 0
  private entries = new Map<string, ProductionOperation>()
  private listeners = new Set<() => void>()

  activate(scope: string): void {
    if (this.scope === scope) return
    this.scope = scope; this.generation++; this.revision++; this.entries.clear()
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getRevision = (): number => this.revision
  private publish(): void { this.revision++; for (const listener of this.listeners) listener() }
  get<Plan = unknown, Proof = unknown>(scope: string, orderId: string, channel?: ProductionOperationChannel): ProductionOperation<Plan, Proof> | null {
    const entry = scope === this.scope ? this.entries.get(orderId) : undefined
    return entry && (!channel || entry.channel === channel) ? structuredClone(entry) as ProductionOperation<Plan, Proof> : null
  }
  begin<Plan, Proof>(scope: string, operation: Pick<ProductionOperation<Plan, Proof>, 'channel' | 'orderId' | 'plan' | 'proof'>, recovery = false): ProductionOperationLease {
    if (scope !== this.scope) return blocked('Sessiya o‘zgargan. Amal oynasini qayta oching.')
    if (!operation.orderId.trim()) return blocked('Amalning haqiqiy buyurtma identifikatori kerak.')
    credentialFree(operation.plan); credentialFree(operation.proof)
    const prior = this.entries.get(operation.orderId)
    if (prior && (!recovery || prior.phase === 'pending' || prior.channel !== operation.channel || stable([prior.plan, prior.proof]) !== stable([operation.plan, operation.proof]))) {
      return blocked('Avvalgi amal natijasi aniqlanmagan. Shu buyurtma uchun yangi buyruq yuborilmaydi.')
    }
    if (recovery && !prior) return blocked('Tiklanadigan avvalgi buyruq saqlanmagan.')
    const serial = ++this.serial
    this.entries.set(operation.orderId, { ...structuredClone(operation), phase: 'pending', dispatched: prior?.dispatched ?? false, serial })
    this.publish()
    return { scope, generation: this.generation, channel: operation.channel, orderId: operation.orderId, serial, wasUncertain: Boolean(prior) }
  }
  private current(lease: ProductionOperationLease): ProductionOperation | undefined {
    const entry = this.entries.get(lease.orderId)
    return lease.scope === this.scope && lease.generation === this.generation && entry?.serial === lease.serial && entry.channel === lease.channel ? entry : undefined
  }
  /** False means the reservation expired: the caller must not send the write. */
  dispatched(lease: ProductionOperationLease): boolean {
    const entry = this.current(lease)
    if (!entry || entry.phase !== 'pending') return false
    entry.dispatched = true; this.publish(); return true
  }
  finish(lease: ProductionOperationLease, outcome: { confirmed: true } | { error: string; uncertain: boolean }): void {
    const entry = this.current(lease)
    if (!entry) return
    // A rejected recovery read/write cannot erase an earlier unknown mutation.
    if ('confirmed' in outcome || !lease.wasUncertain && !entry.dispatched) this.entries.delete(lease.orderId)
    else { entry.phase = 'uncertain'; entry.error = outcome.error }
    this.publish()
  }
  interrupt(lease: ProductionOperationLease): void {
    const entry = this.current(lease)
    if (!entry || entry.phase !== 'pending') return
    if (!entry.dispatched && !lease.wasUncertain) this.entries.delete(lease.orderId)
    else {
      entry.phase = 'uncertain'; entry.error = 'So‘rov yuborilgach oyna yopilgan yoki sessiya uzilgan. Avvalgi buyruq natijasi tekshirilmaguncha yangi amal yopiq.'
      // Late receipts from the interrupted owner cannot clear a retained intent.
      entry.serial = ++this.serial
    }
    this.publish()
  }
}
export const productionOperationLedger = new ProductionOperationLedger()
