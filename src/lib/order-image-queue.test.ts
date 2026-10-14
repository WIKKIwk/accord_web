import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import { OrderImageReadQueue, orderImageReadQueue } from './order-image-queue'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
describe('near-visible thumbnail concurrency', () => {
  it('keeps at most three active reads and drains queued work', async () => {
    const queue = new OrderImageReadQueue(), gate = deferred(); let active = 0, peak = 0
    const work = Array.from({ length: 10 }, () => queue.run(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; return true }, new AbortController().signal))
    await vi.waitFor(() => expect(active).toBe(3)); gate.resolve(); expect(await Promise.all(work)).toEqual(Array(10).fill(true)); expect(peak).toBe(3)
  })
  it('removes interrupted waiting work without consuming a request slot', async () => {
    const queue = new OrderImageReadQueue(1), gate = deferred(), cancelled = new AbortController(), job = vi.fn(async () => true)
    const first = queue.run(() => gate.promise, new AbortController().signal), waiting = queue.run(job, cancelled.signal)
    cancelled.abort(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' }); gate.resolve(); await first; await queue.run(job, new AbortController().signal); expect(job).toHaveBeenCalledTimes(1)
  })
  it('releases a failed slot and never starts already cancelled work', async () => {
    const queue = new OrderImageReadQueue(1), cancelled = new AbortController(), job = vi.fn(async () => true); cancelled.abort()
    await expect(queue.run(job, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(job).not.toHaveBeenCalled()
    await expect(queue.run(async () => { throw new Error('decode failure') }, new AbortController().signal)).rejects.toThrow('decode failure')
    expect(await queue.run(job, new AbortController().signal)).toBe(true)
  })
  it('isolates the limiter by authenticated ApiClient instance', () => {
    const one = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'SYNTHETIC-1' }), two = new ApiClient({ endpoint: 'http://127.0.0.1:5199', token: 'SYNTHETIC-2' })
    expect(orderImageReadQueue(one)).toBe(orderImageReadQueue(one)); expect(orderImageReadQueue(one)).not.toBe(orderImageReadQueue(two))
  })
})
