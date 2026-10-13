/** Optional task-preview restriction; regular production builds leave it unset. */
export function qaMutationAllowed(endpoint: string, method: string, path: string, fixtureEndpoint = ''): boolean {
  if (!fixtureEndpoint) return true
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true
  if (path === '/v1/mobile/auth/login' || path === '/v1/mobile/auth/logout') return true
  try {
    const target = new URL(endpoint)
    const fixture = new URL(fixtureEndpoint)
    return target.href.replace(/\/+$/, '') === fixture.href.replace(/\/+$/, '')
  } catch { return false }
}
