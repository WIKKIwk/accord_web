// Public browser entry: keeps the native renderer outside Vite's source import
// pipeline while each route visit still owns and disposes its WebGL view.
const parameters = new URL(import.meta.url).searchParams;
const attempt = parameters.get('attempt') || '0';
const version = parameters.get('v') || 'baseline';
try {
  const { mountFactoryMap } = await import(`./factory-map-renderer.js?v=${encodeURIComponent(version)}&webAttempt=${encodeURIComponent(attempt)}`);
  const module = { mountFactoryMap };
  window.__accordFactoryMapRenderer = module;
  window.dispatchEvent(new CustomEvent('accord-factory-map-ready', { detail: { attempt, module } }));
} catch (error) {
  window.dispatchEvent(new CustomEvent('accord-factory-map-error', {
    detail: { attempt, message: error instanceof Error ? error.message : '3D xarita moduli yuklanmadi.' },
  }));
}
