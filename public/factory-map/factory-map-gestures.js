// WebKit can handle a two-finger gesture as page zoom/scroll even though the
// canvas uses PointerEvents. Cancel only native defaults inside this map;
// never stop propagation or synthesize pointers (OrbitControls needs them).
export function lockFactoryMapGestures(host) {
  const properties = { position: 'relative', overflow: 'hidden',
    'touch-action': 'none', 'overscroll-behavior': 'none', 'user-select': 'none',
    '-webkit-user-select': 'none' };
  const previous = Object.keys(properties).map(name => [name,
    host.style.getPropertyValue(name), host.style.getPropertyPriority(name)]);
  for (const [name, value] of Object.entries(properties)) host.style.setProperty(name, value);
  const cancel = event => { if (event.cancelable) event.preventDefault(); };
  const multiTouchStart = event => { if (event.touches?.length > 1) cancel(event); };
  const pageZoomWheel = event => { if (event.ctrlKey) cancel(event); };
  const handlers = [
    ['gesturestart', cancel], ['gesturechange', cancel], ['gestureend', cancel],
    ['touchstart', multiTouchStart], ['touchmove', cancel], ['wheel', pageZoomWheel],
  ];
  const options = { passive: false, capture: true };
  handlers.forEach(([type, handler]) => host.addEventListener(type, handler, options));
  return () => {
    handlers.forEach(([type, handler]) => host.removeEventListener(type, handler, options));
    for (const [name, value, priority] of previous) {
      if (value) host.style.setProperty(name, value, priority);
      else host.style.removeProperty(name);
    }
  };
}
