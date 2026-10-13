// Public browser entry: keeps the native renderer outside Vite's source import
// pipeline while each route visit still owns and disposes its WebGL view.
const attempt = new URL(import.meta.url).searchParams.get('attempt') || '0';
try {
  const { mountFactoryMap } = await import(`./factory-map-renderer.js?webAttempt=${encodeURIComponent(attempt)}`);
  const module = { mountFactoryMap };
  window.__accordFactoryMapRenderer = module;
  window.dispatchEvent(new CustomEvent('accord-factory-map-ready', { detail: { attempt, module } }));
} catch (error) {
  window.dispatchEvent(new CustomEvent('accord-factory-map-error', {
    detail: { attempt, message: error instanceof Error ? error.message : '3D xarita moduli yuklanmadi.' },
  }));
}
