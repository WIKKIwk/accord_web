/** Optional task-preview restriction; regular production builds leave it unset. */
export function qaMutationAllowed(endpoint: string, method: string, path: string, fixtureEndpoint = ''): boolean {
  if (!fixtureEndpoint) return true
  // This native GET reconciles and persists stale/expired business requests.
  // Only the fixture may run it in a guarded task preview.
  const reconcilesRequests = ['GET', 'HEAD'].includes(method.toUpperCase()) && path.split('?')[0].replace(/\/+$/, '') === '/v1/mobile/material-link-requests'
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !reconcilesRequests) return true
  if (path === '/v1/mobile/auth/login' || path === '/v1/mobile/auth/logout') return true
  // The native QR report uses POST for a read-only batch-lineage lookup.
  if (method.toUpperCase() === 'POST' && path === '/v1/mobile/admin/production-maps/progress-qr/report') return true
  try {
    const target = new URL(endpoint)
    const fixture = new URL(fixtureEndpoint)
    return target.href.replace(/\/+$/, '') === fixture.href.replace(/\/+$/, '')
  } catch { return false }
}
