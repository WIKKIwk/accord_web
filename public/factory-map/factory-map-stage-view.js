// Stage browsing reuses the loaded scene. No model clone, asset fetch or second
// canvas is needed; optimized original meshes remain available for exact views.
export function createFactoryStageView(root, getTarget, { cadContrast = false } = {}) {
  const visibility = new Map();
  const materialColors = new Map();
  root.traverse(object => visibility.set(object, object.visible));
  let current = '';
  function restore() {
    for (const [material, color] of materialColors) material.color.copy(color);
    materialColors.clear();
    for (const [object, visible] of visibility) object.visible = visible;
    current = '';
  }
  function setObject(id) {
    if (id === current) return { changed: false, isolated: current };
    restore();
    if (!id) return { changed: true, isolated: '' };
    const target = getTarget(id);
    if (!target?.object || !visibility.has(target.object)) return { changed: true, isolated: '' };
    const original = target.object;
    const proxy = original.userData.factoryMapRenderProxy;
    // A deduplicated instanced apparatus proxy contains that apparatus only.
    // A merged static batch can include other apparatuses, so expose the exact
    // original subtree instead of making the whole batch visible.
    const rendered = original.isInstancedMesh && !Number.isInteger(target.instanceId) && proxy?.isInstancedMesh ? proxy : original;
    if (Number.isInteger(target.instanceId) && original.isInstancedMesh && original.count > 1) return { changed: true, isolated: '' };
    for (const object of visibility.keys()) object.visible = false;
    for (let parent = rendered; parent; parent = parent.parent) parent.visible = true;
    rendered.traverse(object => { object.visible = visibility.get(object) === true || Boolean(object.userData.factoryMapRenderProxy); });
    rendered.visible = true;
    if (cadContrast) rendered.traverse(object => {
      for (const material of [].concat(object.material || [])) {
        if (!material?.isMeshBasicMaterial || !material.color || materialColors.has(material)) continue;
        const originalColor = material.color.clone();
        // The export's unlit grey surfaces are close to the light canvas.
        // Adjust their brightness only while isolated, retaining hue, alpha,
        // textures, vertex shading and black contours. Overview restores exact
        // original values even when materials are shared with hidden objects.
        if (Math.max(originalColor.r, originalColor.g, originalColor.b) < 0.05) continue;
        materialColors.set(material, originalColor);
        material.color.multiplyScalar(0.6);
      }
    });
    current = id;
    return { changed: true, isolated: current };
  }
  return { setObject, restore, get isolatedObjectId() { return current; } };
}
