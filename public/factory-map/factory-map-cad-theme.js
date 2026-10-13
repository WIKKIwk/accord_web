// Each mounted renderer owns these material variants. Original CAD materials,
// textures, geometry and contour indices are never changed by a theme switch.
export const FACTORY_CAD_THEME = Object.freeze({
  light: Object.freeze({ background: 0xf4f4f5 }),
  dark: Object.freeze({ background: 0x181818, contour: 0xd4d4d8, surfaceMin: 0x24, surfaceMax: 0x4c }),
});

export function createFactoryCadTheme(root) {
  const originals = new Map();
  const variants = { surface: new Map(), contour: new Map() };
  let theme = 'light';
  let disposed = false;
  const luminance = material => material.color
    ? material.color.r * 0.2126 + material.color.g * 0.7152 + material.color.b * 0.0722
    : 0;
  // Spread the existing source face tones through the dark range instead of
  // compressing its near-white greys into one indistinguishable dark shade.
  let surfaceMin = Infinity, surfaceMax = -Infinity;
  root.traverse(object => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material || [])) {
      if (!material.color) continue;
      const value = luminance(material);
      surfaceMin = Math.min(surfaceMin, value);
      surfaceMax = Math.max(surfaceMax, value);
    }
  });
  if (!Number.isFinite(surfaceMin)) { surfaceMin = 0; surfaceMax = 1; }

  function darkMaterial(original, role) {
    if (!original) return original;
    const cache = variants[role];
    if (cache.has(original)) return cache.get(original);
    const material = original.clone();
    if (material.color) {
      if (role === 'contour') material.color.setHex(FACTORY_CAD_THEME.dark.contour);
      else {
        // Map the source's existing greys into a narrower neutral dark range.
        // Separate original face tones remain distinct, including black faces.
        const tone = surfaceMax > surfaceMin ? (luminance(original) - surfaceMin) / (surfaceMax - surfaceMin) : luminance(original);
        const value = Math.round(FACTORY_CAD_THEME.dark.surfaceMin + Math.max(0, Math.min(1, tone)) * (FACTORY_CAD_THEME.dark.surfaceMax - FACTORY_CAD_THEME.dark.surfaceMin));
        material.color.setHex(value * 0x010101);
      }
    }
    // A source color texture/vertex tint could otherwise multiply the neutral
    // variant back to black or introduce accent colors. Keep shared data intact.
    if ('map' in material) material.map = null;
    if ('emissiveMap' in material) material.emissiveMap = null;
    if (material.emissive) material.emissive.setHex(0);
    material.vertexColors = false;
    material.needsUpdate = true;
    cache.set(original, material);
    return material;
  }

  function apply(object) {
    const original = originals.get(object);
    const role = object.isLine || object.isLineSegments ? 'contour' : 'surface';
    object.material = theme === 'dark'
      ? Array.isArray(original) ? original.map(material => darkMaterial(material, role)) : darkMaterial(original, role)
      : original;
  }

  function register(object, source = object) {
    if (disposed || !object.material || originals.has(object)) return;
    // Lazy apparatus contours can be created while their source is dark. Read
    // the source's saved LIGHT reference instead of capturing its dark clone.
    originals.set(object, originals.get(source) ?? source.material);
    apply(object);
  }

  root.traverse(object => register(object));
  return {
    register,
    setTheme(value) {
      if (disposed) return false;
      const next = value === 'dark' ? 'dark' : 'light';
      if (next === theme) return false;
      theme = next;
      for (const object of originals.keys()) apply(object);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [object, material] of originals) object.material = material;
      for (const cache of Object.values(variants)) {
        for (const material of cache.values()) material.dispose();
        cache.clear();
      }
      originals.clear();
    },
    get theme() { return theme; },
  };
}
