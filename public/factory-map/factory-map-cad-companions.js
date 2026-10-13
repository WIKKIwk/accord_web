import { Box3, BufferGeometry, LineSegments, Matrix4, Sphere, Vector3 } from './three.module.js';

const point = new Vector3();
const instanceMatrix = new Matrix4();
const pairKey = (a, b, count) => Math.min(a, b) * count + Math.max(a, b);

// The CAD export has one factory-wide indexed line primitive. Apparatus IDs
// belong to surface groups, so visibility alone cannot extract their contours.
// Match existing segment endpoints to ORIGINAL triangle edges in world space.
// No contour positions, material, normals or outlines are generated here.
function lineIndex(source) {
  const position = source.geometry.attributes.position;
  const world = new Float64Array(position.count * 3);
  const bounds = new Box3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(source.matrixWorld);
    point.toArray(world, i * 3); bounds.expandByPoint(point);
  }
  // GLB positions are Float32 while node/world transforms are evaluated in
  // double precision. Two Float32 rounding units at this source's coordinate
  // scale cover that serialization error (about 0.014 mm in the shipped map).
  const magnitude = Math.max(1, ...bounds.min.toArray().map(Math.abs), ...bounds.max.toArray().map(Math.abs));
  const tolerance = magnitude * 2 ** -22;
  const buckets = new Map();
  const cell = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < position.count; i++) {
    const key = cell(Math.floor(world[i * 3] / tolerance), Math.floor(world[i * 3 + 1] / tolerance), Math.floor(world[i * 3 + 2] / tolerance));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  const toleranceSquared = tolerance * tolerance;
  function matches(value) {
    const x = Math.floor(value.x / tolerance), y = Math.floor(value.y / tolerance), z = Math.floor(value.z / tolerance);
    const result = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const index of buckets.get(cell(x + dx, y + dy, z + dz)) ?? []) {
        const at = index * 3;
        const distance = (world[at] - value.x) ** 2 + (world[at + 1] - value.y) ** 2 + (world[at + 2] - value.z) ** 2;
        if (distance <= toleranceSquared) result.push(index);
      }
    }
    return result;
  }
  return { matches, count: position.count, tolerance };
}

function originalEdges(target, vertices) {
  const edges = new Set();
  target.traverse(object => {
    if (!object.isMesh || object.userData.factoryMapRenderOnly) return;
    const geometry = object.geometry, position = geometry.attributes.position, index = geometry.index;
    if (!position) return;
    const append = matrix => {
      const candidates = Array.from({ length: position.count }, (_, i) => vertices.matches(point.fromBufferAttribute(position, i).applyMatrix4(matrix)));
      const start = Math.max(0, geometry.drawRange.start);
      const end = Math.min(index?.count ?? position.count, start + geometry.drawRange.count);
      for (let i = start; i + 2 < end; i += 3) {
        const triangle = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset);
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) for (const left of candidates[triangle[a]]) for (const right of candidates[triangle[b]]) {
          if (left !== right) edges.add(pairKey(left, right, vertices.count));
        }
      }
    };
    if (object.isInstancedMesh) {
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, instanceMatrix);
        if (Math.abs(instanceMatrix.determinant()) < 1e-12) continue;
        append(new Matrix4().multiplyMatrices(object.matrixWorld, instanceMatrix));
      }
    } else append(object.matrixWorld);
  });
  return edges;
}

function companion(source, target, vertices, objectId) {
  const edges = originalEdges(target, vertices), original = source.geometry, position = original.attributes.position, index = original.index;
  const selected = [], bounds = new Box3();
  const start = Math.max(0, original.drawRange.start), end = Math.min(index?.count ?? position.count, start + original.drawRange.count);
  for (let i = start; i + 1 < end; i += 2) {
    const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1;
    if (!edges.has(pairKey(a, b, vertices.count))) continue;
    selected.push(a, b);
    bounds.expandByPoint(point.fromBufferAttribute(position, a));
    bounds.expandByPoint(point.fromBufferAttribute(position, b));
  }
  if (!selected.length) return null;
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(original.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(selected);
  // computeBoundingBox() scans the SHARED full-factory position attribute.
  // Explicit subset bounds prevent it from shrinking the selected apparatus.
  geometry.boundingBox = bounds;
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere());
  const lines = new LineSegments(geometry, source.material);
  lines.name = `${source.name} · ${objectId}`;
  lines.matrix.copy(source.matrix); lines.matrixWorld.copy(source.matrixWorld);
  lines.matrixAutoUpdate = false; lines.matrixWorldAutoUpdate = false;
  lines.layers.mask = source.layers.mask; lines.renderOrder = source.renderOrder;
  lines.castShadow = source.castShadow; lines.receiveShadow = source.receiveShadow;
  lines.frustumCulled = source.frustumCulled; lines.visible = false;
  lines.userData.factoryMapRenderOnly = true;
  lines.userData.factoryMapCadCompanionFor = objectId;
  lines.userData.factoryMapCadSource = source;
  lines.userData.factoryMapCadTolerance = vertices.tolerance;
  source.parent.add(lines);
  return lines;
}

export function createFactoryCadCompanions(root, onCreate = () => {}) {
  root.updateMatrixWorld(true);
  const sources = [];
  root.traverse(object => {
    if (!object.isLineSegments || object.userData.factoryMapRenderOnly) return;
    for (let parent = object; parent; parent = parent.parent) if (parent.userData.factory_map_object_id) return;
    sources.push(object);
  });
  const indices = new Map(), cache = new Map();
  return {
    get(objectId, target) {
      if (!target || !objectId) return [];
      if (cache.has(target)) return cache.get(target);
      const companions = sources.flatMap(source => {
        if (!indices.has(source)) indices.set(source, lineIndex(source));
        const lines = companion(source, target, indices.get(source), objectId);
        if (lines) onCreate(lines, source);
        return lines ? [lines] : [];
      });
      cache.set(target, companions);
      return companions;
    },
  };
}
