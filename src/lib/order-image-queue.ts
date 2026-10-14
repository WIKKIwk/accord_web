import type { ApiClient } from './api'

const aborted = () => new DOMException('Rasm so‘rovi bekor qilindi.', 'AbortError')
type Task = { start: () => void; cancel: () => void; signal: AbortSignal }

/** Bounds near-visible thumbnail reads; explicit full viewing never joins this queue. */
export class OrderImageReadQueue {
  private active = 0
  private waiting: Task[] = []
  private readonly limit: number
  constructor(limit = 3) { if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid image concurrency'); this.limit = limit }
  run<T>(job: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted())
    return new Promise<T>((resolve, reject) => {
      const task: Task = { signal, cancel: () => { this.waiting = this.waiting.filter(item => item !== task); signal.removeEventListener('abort', task.cancel); reject(aborted()) }, start: () => {
        signal.removeEventListener('abort', task.cancel)
        this.active++
        Promise.resolve().then(() => { if (signal.aborted) throw aborted(); return job() }).then(resolve, reject).finally(() => { this.active--; this.drain() })
      } }
      signal.addEventListener('abort', task.cancel, { once: true }); this.waiting.push(task); this.drain()
    })
  }
  private drain() { while (this.active < this.limit && this.waiting.length) { const task = this.waiting.shift()!; if (task.signal.aborted) task.cancel(); else task.start() } }
}
const queues = new WeakMap<ApiClient, OrderImageReadQueue>()
export function orderImageReadQueue(client: ApiClient): OrderImageReadQueue { let queue = queues.get(client); if (!queue) { queue = new OrderImageReadQueue(); queues.set(client, queue) }; return queue }
