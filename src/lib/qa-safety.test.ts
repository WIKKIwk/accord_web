import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'
import { qaMutationAllowed } from './qa-safety'
const fixture = 'http://127.0.0.1:5199'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
describe('local preview write isolation', () => {
  it('permits fixture writes and blocks every business mutation to a different server', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(qaMutationAllowed(fixture, method, '/v1/mobile/admin/items', fixture)).toBe(true)
      expect(qaMutationAllowed('https://erp.example.com', method, '/v1/mobile/admin/items', fixture)).toBe(false)
      expect(qaMutationAllowed('http://127.0.0.1:8000', method, '/v1/mobile/admin/items', fixture)).toBe(false)
      expect(qaMutationAllowed(fixture + '.evil.test', method, '/v1/mobile/admin/items', fixture)).toBe(false)
    }
  })
  it('allows read-only viewing and explicitly requested session actions', () => {
    expect(qaMutationAllowed('https://erp.example.com', 'GET', '/v1/mobile/admin/items', fixture)).toBe(true)
    expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/auth/login', fixture)).toBe(true)
    expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/auth/logout', fixture)).toBe(true)
    expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/admin/code/regenerate', fixture)).toBe(false)
  })
  it('does not restrict the independently usable regular build', () => {
    expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/admin/items')).toBe(true)
  })
  it('blocks a remote business write before fetch is called', async () => {
    vi.stubEnv('VITE_QA_API_ORIGIN', fixture)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const api = new ApiClient({ endpoint: 'https://erp.example.com', token: 'qa-session' })
    await expect(api.post('/v1/mobile/admin/items', { name: 'Example' })).rejects.toMatchObject({ code: 'qa_remote_read_only', status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
