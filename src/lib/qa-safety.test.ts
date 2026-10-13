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
  it('allows only the audited read-only QR report, with an exact method and path', () => {
    const path = '/v1/mobile/admin/production-maps/progress-qr/report'
    expect(qaMutationAllowed('https://erp.example.com', 'POST', path, fixture)).toBe(true)
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect(qaMutationAllowed('https://erp.example.com', method, path, fixture)).toBe(false)
    for (const suffix of ['/reprint', '/correct', '/report/other', '/report?print=true']) expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/admin/production-maps/progress-qr' + suffix, fixture)).toBe(false)
  })
  it('does not restrict the independently usable regular build', () => {
    expect(qaMutationAllowed('https://erp.example.com', 'POST', '/v1/mobile/admin/items')).toBe(true)
  })
  it('keeps the native request-reconciliation GET in the fixture while leaving regular builds unrestricted', async () => {
    const path = '/v1/mobile/material-link-requests'
    for (const method of ['GET', 'HEAD']) {
      expect(qaMutationAllowed(fixture, method, path, fixture)).toBe(true)
      expect(qaMutationAllowed('https://erp.example.com', method, path, fixture)).toBe(false)
      expect(qaMutationAllowed('https://erp.example.com', method, path + '?request_id=native-id', fixture)).toBe(false)
      expect(qaMutationAllowed('https://erp.example.com', method, path)).toBe(true)
    }
    vi.stubEnv('VITE_QA_API_ORIGIN', fixture)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const api = new ApiClient({ endpoint: 'https://erp.example.com', token: 'qa-session' })
    await expect(api.request(path, 'GET', { query: { request_id: 'native-id' } })).rejects.toMatchObject({ code: 'qa_remote_read_only', status: 403 })
    expect(fetch).not.toHaveBeenCalled()
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
