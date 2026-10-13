// Accord web adaptation (2026-10-13): streamed download progress for the
// unchanged CAD source. One decoded buffer remains cached only in browser RAM.
import { Box3, InstancedMesh, Material, Matrix4, Mesh, Vector3 } from './three.module.js';
import { mergeGeometries } from './utils/BufferGeometryUtils.js';

// Render copies only: original meshes, hierarchy and raycast IDs stay intact.
// Spatial buckets retain useful frustum culling instead of one factory-wide mesh.
export function batchStaticMap(root) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const buckets = new Map(), materialKeys = new WeakMap();
  const center = new Vector3();
  root.traverseVisible(object => {
    const { geometry, material } = object;
    for (let parent = object; parent && parent !== root; parent = parent.parent) {
      if (parent.userData.animation_role) return;
    }
    if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh ||
        object.userData.factoryMapRenderOnly ||
        !material?.isMeshStandardMaterial || material.transparent ||
        material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
        geometry.morphAttributes.position ||
        geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity ||
        geometry.attributes.position.array.constructor !== Float32Array ||
        object.matrixWorld.determinant() <= 0) return;
    if (!materialKeys.has(material)) {
      const json = material.toJSON();
      for (const name of ['uuid', 'name', 'metadata', 'userData']) delete json[name];
      materialKeys.set(material, JSON.stringify(json));
    }
    geometry.computeBoundingBox();
    geometry.boundingBox.getCenter(center).applyMatrix4(object.matrixWorld);
    const attributes = Object.entries(geometry.attributes).sort().map(([name, a]) =>
      [name, a.itemSize, a.normalized, a.array.constructor.name]);
    const key = JSON.stringify([materialKeys.get(material),
      Math.floor(center.x / 16), Math.floor(center.z / 16),
      object.castShadow, object.receiveShadow, object.renderOrder,
      object.layers.mask, Boolean(geometry.index), attributes]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(object);
  });
  let meshesBefore = 0, meshesAfter = 0;
  for (const objects of buckets.values()) {
    if (objects.length < 2) continue;
    const geometries = objects.map(object => object.geometry.clone().applyMatrix4(
      new Matrix4().multiplyMatrices(inverse, object.matrixWorld)));
    const merged = mergeGeometries(geometries);
    geometries.forEach(geometry => geometry.dispose());
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const first = objects[0];
    const proxy = new Mesh(merged, first.material);
    proxy.name = 'factory-static-batch';
    proxy.castShadow = first.castShadow;
    proxy.receiveShadow = first.receiveShadow;
    proxy.renderOrder = first.renderOrder;
    proxy.layers.mask = first.layers.mask;
    proxy.userData.factoryMapRenderOnly = true;
    root.add(proxy);
    for (const object of objects) {
      object.visible = false;
      object.userData.factoryMapRenderProxy = proxy;
    }
    meshesBefore += objects.length;
    meshesAfter++;
  }
  return { meshesBefore, meshesAfter };
}

// Rendering may deduplicate exact coincident instances, but picking and saved
// IDs continue to use the untouched original instance table.
export function optimizeStaticMap(root) {
  const originals = [];
  root.traverseVisible(object => { if (object.isInstancedMesh) originals.push(object); });
  let instancesBefore = 0;
  let instancesAfter = 0;
  for (const object of originals) {
    if (object.instanceColor || object.morphTexture) continue;
    const unique = new Map();
    const matrix = new Matrix4();
    instancesBefore += object.count;
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      if (Math.abs(matrix.determinant()) < 1e-12) continue;
      const key = matrix.elements.join(',');
      if (!unique.has(key)) unique.set(key, matrix.clone());
    }
    instancesAfter += unique.size;
    if (unique.size === object.count) continue;
    const proxy = new InstancedMesh(object.geometry, object.material, unique.size);
    proxy.name = `${object.name}-render-only`;
    proxy.position.copy(object.position);
    proxy.quaternion.copy(object.quaternion);
    proxy.scale.copy(object.scale);
    proxy.castShadow = object.castShadow;
    proxy.receiveShadow = object.receiveShadow;
    proxy.userData.factoryMapRenderOnly = true;
    let i = 0;
    for (const value of unique.values()) proxy.setMatrixAt(i++, value);
    proxy.instanceMatrix.needsUpdate = true;
    object.parent.add(proxy);
    object.visible = false;
    object.userData.factoryMapRenderProxy = proxy;
  }
  const batches = batchStaticMap(root);
  root.updateMatrixWorld(true);
  // Freeze static geometry. The live layer explicitly updates only tagged
  // reel matrices, never hundreds of unchanged bodies/walls every frame.
  root.traverse(object => {
    object.matrixAutoUpdate = false;
    object.matrixWorldAutoUpdate = false;
  });
  return { instancesBefore, instancesAfter, ...batches };
}

export function buildPickBounds(meshes) {
  return meshes.map(object => ({ object, box: new Box3().setFromObject(object) }));
}

export function closestMapHits(raycaster, pickBounds) {
  const point = new Vector3();
  const candidates = [];
  for (const candidate of pickBounds) {
    if (raycaster.ray.intersectBox(candidate.box, point)) {
      candidates.push({ ...candidate, distance: candidate.box.containsPoint(raycaster.ray.origin)
        ? 0 : point.distanceTo(raycaster.ray.origin) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  let closest = Infinity;
  const hits = [];
  for (const candidate of candidates) {
    if (candidate.distance > closest) break;
    const next = raycaster.intersectObject(candidate.object, false);
    if (next.length) {
      closest = Math.min(closest, next[0].distance);
      hits.push(...next);
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

// Only one decoded source buffer is retained across web route visits. GPU
// objects are always disposed with their view, never cached across WebGL contexts.
let cachedSource = null;
async function readModelResponse(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader || !onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  onProgress(loaded, total || loaded);
  return bytes.buffer;
}

export async function loadMapBytes(url, signal, fetcher = fetch, compressedUrl = '', onProgress) {
  if (cachedSource?.url === url) {
    onProgress?.(cachedSource.bytes.byteLength, cachedSource.bytes.byteLength);
    return cachedSource.bytes;
  }
  if (compressedUrl && typeof DecompressionStream !== 'undefined') {
    try {
      const response = await fetcher(compressedUrl, { cache: 'default', signal });
      if (!response.ok) throw new Error('Compressed model unavailable');
      const packed = await readModelResponse(response, onProgress);
      const header = new Uint8Array(packed, 0, Math.min(packed.byteLength, 4));
      // Some hosts set Content-Encoding and the browser already decompresses.
      const bytes = header[0] === 0x1f && header[1] === 0x8b
        ? await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : packed;
      if (new DataView(bytes).getUint32(0, true) !== 0x46546c67) throw new Error('Invalid compressed GLB');
      cachedSource = { url, bytes };
      return bytes;
    } catch (error) {
      if (signal.aborted) throw error;
      // Old WebViews or deployments without the compressed file still work.
    }
  }
  const response = await fetcher(url, { cache: 'default', signal });
  if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}`);
  const bytes = await readModelResponse(response, onProgress);
  cachedSource = { url, bytes };
  return bytes;
}
