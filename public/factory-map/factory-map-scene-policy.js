import { BufferAttribute, BufferGeometry } from './three.module.js';

// Verified against the original 109-node map and isolated geometry renders.
// These are old scenery/props, never parts of the eight approved replacements.
export const FACTORY_MAP_CLUTTER_BASE_IDS = Object.freeze([
  'node:8', // beam left over from a hidden central canopy
  ...[10, 11, 12, 13, 14, 15, 16, 68, 69, 87].map(id => `node:${id}`), // open rack by Flexo
  'node:21', // detached vertical indicator beside Rezka
  ...[22, 23, 24, 25, 26, 27, 54, 55, 56, 57, 58, 59,
    78, 79, 80, 81, 82, 83, 84, 85, 86, 99, 100, 101, 102, 103, 104, 105, 106, 107]
    .map(id => `node:${id}`), // racks/loose rails at the 7- and 9-color press heads
  ...[46, 66, 67, 70].map(id => `node:${id}`), // roof ribs and gable trims
  ...[28, 29, 88, 89].map(id => `node:${id}`), // broken forklift body fragments
  'node:108:primitive:0', // transverse roof ribs + two small pallet lifters
  'node:108:primitive:4', // broken forklift glass
  'node:108:primitive:5', // broken forklift forks and wheels
  'node:108:primitive:6', // disconnected rails/handles by the removed racks
]);

// Canonical apparatus mapping checked read-only: Rezka is node:20. All other
// current apparatus have a tagged, complete replacement root. Never infer an
// apparatus from a box shape or from an arbitrary user-selected scene object.
export function apparatusObjectId(object) {
  for (let current = object; current; current = current.parent) {
    if (current.userData?.factory_map_object_id) return current.userData.factory_map_object_id;
  }
  // Rezka's eight copies have identical transforms. Its canonical saved
  // placement is the node-level ID, not an arbitrary duplicate instance.
  return object?.userData?.factoryMapRawBaseId === 'node:20' ? 'node:20' : '';
}

export function isFactoryMapApparatus(object) {
  return apparatusObjectId(object) !== '';
}

export function apparatusHit(hits) {
  // Visible architecture still occludes: tapping a wall must NOT select a
  // machine behind it. Hidden clutter is excluded before raycasting.
  return hits[0] && isFactoryMapApparatus(hits[0].object) ? hits[0] : null;
}

export function cleanFactoryMapGeometry(object, rawBaseId) {
  if (rawBaseId !== 'node:19' && rawBaseId !== 'node:20') return false;
  if (object.userData.factoryMapDetachedRodRemoved) return false;
  const original = object.geometry;
  const position = original.attributes.position;
  const index = original.index;
  const count = index?.count ?? position.count;
  const kept = [];
  // These two legacy meshes contain a cuboid (12 triangles, local z <= 1)
  // plus an unrelated thin rod (124 triangles, local z >= 1.9199). Strip only
  // the rod; preserve both cuboids, every instance transform and the Rezka ID.
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j);
    if (triangle.every(v => position.getZ(v) <= 1.00001)) kept.push(...triangle);
  }
  // Fail closed if a future model no longer matches this verified geometry.
  if (count !== 408 || kept.length !== 36) return false;
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(original.attributes)) {
    const array = new attribute.array.constructor(kept.length * attribute.itemSize);
    const copy = new BufferAttribute(array, attribute.itemSize, attribute.normalized);
    kept.forEach((vertex, output) => {
      for (let c = 0; c < attribute.itemSize; c++) {
        copy.setComponent(output, c, attribute.getComponent(vertex, c));
      }
    });
    geometry.setAttribute(name, copy);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  object.geometry = geometry;
  if (object.isInstancedMesh) {
    object.boundingBox = null;
    object.boundingSphere = null;
  }
  original.dispose(); // runs before any GPU upload
  object.userData.factoryMapDetachedRodRemoved = true;
  return true;
}
