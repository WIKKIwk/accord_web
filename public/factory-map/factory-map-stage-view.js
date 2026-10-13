// Stage browsing reuses the loaded scene. No model clone, asset fetch or second
// canvas is needed; optimized original meshes remain available for exact views.
export function createFactoryStageView(root, getTarget) {
  const visibility = new Map();
  root.traverse(object => visibility.set(object, object.visible));
  let current = '';
  function restore() {
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
    current = id;
    return { changed: true, isolated: current };
  }
  return { setObject, restore, get isolatedObjectId() { return current; } };
}
