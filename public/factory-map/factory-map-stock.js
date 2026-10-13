import * as THREE from './three.module.js';

// Diagrammatic roll sizes, not measured stock dimensions. Every instance is
// one ERP stock row. Dense states shrink uniformly rather than drop rolls.
export function packStateRolls(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid roll count');
  if (!count) return [];
  const factor = Math.max(1, Math.cbrt(count / 18));
  const columns = Math.ceil(3 * factor), rows = Math.ceil(2 * factor);
  const layers = Math.ceil(count / (columns * rows));
  const scale = Math.min(1, 2.4 / (columns * .8), 1.6 / (rows * .8), 2.4 / (layers * .78));
  return Array.from({ length: count }, (_, i) => ({
    x: ((i % columns) - (columns - 1) / 2) * .8 * scale,
    z: ((Math.floor(i / columns) % rows) - (rows - 1) / 2) * .8 * scale,
    y: .16 + (Math.floor(i / (columns * rows)) * .78 + .34) * scale,
    scale, radius: .36 * scale, height: .68 * scale,
  }));
}

export function overlapsFootprint(a, b, gap = .12) {
  return a.min.x < b.max.x + gap && a.max.x > b.min.x - gap &&
    a.min.z < b.max.z + gap && a.max.z > b.min.z - gap;
}

/** Search one corner/side of the apparatus, never its body or a neighbour.
 * Fixed footprint keeps a pile in place as its count changes. */
export function placeStatePile(machine, bounds, obstacles, occupied = []) {
  const center = machine.getCenter(new THREE.Vector3());
  for (const scale of [1, .8, .6]) {
    const halfX = 1.32 * scale, halfZ = .92 * scale;
    const candidates = [];
    for (const gap of [.32, .8, 1.4]) {
      for (const x of [machine.min.x + halfX, machine.max.x - halfX, center.x]) {
        for (const z of [machine.min.z - gap - halfZ, machine.max.z + gap + halfZ]) candidates.push([x, z]);
      }
      for (const z of [machine.min.z + halfZ, machine.max.z - halfZ, center.z]) {
        for (const x of [machine.min.x - gap - halfX, machine.max.x + gap + halfX]) candidates.push([x, z]);
      }
    }
    for (const [x, z] of candidates) {
      const box = new THREE.Box3(new THREE.Vector3(x - halfX, .02, z - halfZ),
        new THREE.Vector3(x + halfX, 2.7 * scale, z + halfZ));
      if (box.min.x < bounds.min.x + .65 || box.max.x > bounds.max.x - .65 ||
          box.min.z < bounds.min.z + .65 || box.max.z > bounds.max.z - .65) continue;
      if ([machine, ...occupied].some(other => overlapsFootprint(box, other))) continue;
      if (obstacles.some(other => other.max.y > .22 && other.min.y < box.max.y &&
          overlapsFootprint(box, other))) continue;
      return { x, z, scale, box };
    }
  }
  return null;
}

export function stockIsFresh(stock, now = Date.now()) {
  return stock?.fresh === true && Number.isFinite(stock.validUntil) && stock.validUntil > now;
}

const EMPTY_RECTS = Object.freeze([]);

export function placeStockBadge(x, y, width, height, w, occupied) {
  for (const shift of [0, -26, 26, -52, 52]) {
    const rect = { x: x - w / 2, y: y - 22 + shift, w, h: 22 };
    if (rect.x < 6 || rect.x + w > width - 6 || rect.y < 54 || rect.y + 22 > height - 82) continue;
    if (occupied.some(p => rect.x < p.x + p.w + 4 && rect.x + w + 4 > p.x &&
        rect.y < p.y + p.h + 4 && rect.y + 26 > p.y)) continue;
    return rect;
  }
  return null;
}

export function createFactoryStock({ host, scene, camera, canvas, bounds, obstacles, getBox,
    getLabelRects = () => EMPTY_RECTS, requestRender }) {
  const group = new THREE.Group();
  group.name = 'FactoryStateRolls';
  // Not part of model/selectableMeshes. Inventory is read-only, not a machine.
  scene.add(group);
  const ownerDocument = host.ownerDocument;
  const overlay = ownerDocument.createElement('div');
  overlay.dataset.factoryStockOverlay = '';
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  host.append(overlay);
  const notice = ownerDocument.createElement('div');
  notice.dataset.factoryStockNotice = '';
  notice.style.cssText = 'position:absolute;bottom:44px;left:12px;max-width:80%;padding:5px 9px;border-radius:9px;background:#3e4b42dd;color:#fff;font:10px system-ui;';
  overlay.append(notice);
  // Hollow foil body with a cardboard inner tube and visible concentric ends.
  const bodyGeometry = new THREE.LatheGeometry([
    new THREE.Vector2(.105, -.34), new THREE.Vector2(.35, -.34),
    new THREE.Vector2(.36, -.32), new THREE.Vector2(.36, .32),
    new THREE.Vector2(.35, .34), new THREE.Vector2(.105, .34),
  ], 24);
  const coreGeometry = new THREE.LatheGeometry([
    new THREE.Vector2(.085, -.35), new THREE.Vector2(.105, -.35),
    new THREE.Vector2(.105, .35), new THREE.Vector2(.085, .35),
    new THREE.Vector2(.085, -.35),
  ], 20);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xd4dcd8, roughness: .47, metalness: .26 });
  bodyMaterial.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 rollPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nrollPosition = position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 rollPosition;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float endFace = smoothstep(.31, .335, abs(rollPosition.y));
        float wound = .5 + .5 * sin(length(rollPosition.xz) * 220.0);
        diffuseColor.rgb *= 1.0 - endFace * wound * .12;
      `);
  };
  const coreMaterial = new THREE.MeshStandardMaterial({ color: 0xb5a084, roughness: .94, side: THREE.DoubleSide });
  const palletGeometry = new THREE.BoxGeometry(2.58, .12, 1.76);
  const palletMaterial = new THREE.MeshStandardMaterial({ color: 0x8e998d, roughness: .95 });
  let state = {}, signature = '', expiry, dirty = true, disposed = false;
  let labels = [], previousLabelRects;
  const projected = new THREE.Vector3();

  function clear() {
    for (const child of [...group.children]) { group.remove(child); child.dispose?.(); }
    for (const item of labels) item.element.remove();
    labels = [];
  }

  function rebuild() {
    const stock = state.stock || {};
    const fresh = stockIsFresh(stock);
    const piles = fresh ? stock.piles || [] : [];
    const nextSignature = JSON.stringify([fresh, piles, stock.rollLabel, stock.noSpaceLabel, stock.unknownLabel]);
    if (nextSignature === signature) { dirty = true; requestRender(); return; }
    notice.hidden = fresh;
    notice.textContent = stock.unknownLabel || 'State qoldig‘i tasdiqlanmagan';
    signature = nextSignature;
    clear();
    const occupied = [], placed = [], unplaced = [];
    const stateIds = new Set();
    for (const pile of [...piles].sort((a, b) => a.stateId.localeCompare(b.stateId))) {
      if (stateIds.has(pile.stateId)) continue;
      stateIds.add(pile.stateId);
      const ids = [...new Set(pile.rollIds || [])];
      if (!Number.isSafeInteger(pile.count) || pile.count !== ids.length) continue;
      // Reserve even empty state corners to keep neighbouring piles stable.
      let placement;
      for (const id of pile.objectIds || []) {
        const machine = getBox(id);
        if (machine) placement = placeStatePile(machine, bounds, obstacles, occupied);
        if (placement) break;
      }
      if (placement) occupied.push(placement.box);
      if (!ids.length) continue;
      if (!placement) { unplaced.push(pile); continue; }
      placed.push({ pile, ...placement, rolls: packStateRolls(ids.length) });
    }
    if (unplaced.length) {
      notice.hidden = false;
      notice.textContent = `${stock.noSpaceLabel || 'State yonida joy yetmadi'}: ${unplaced.map(p => `${p.name} · ${p.count}`).join(', ')}`;
    }
    const count = placed.reduce((n, p) => n + p.rolls.length, 0);
    canvas.dataset.stockRollCount = String(count);
    canvas.dataset.stockUnplacedCount = String(unplaced.reduce((n, p) => n + p.count, 0));
    canvas.dataset.stockPileCount = String(placed.length);
    canvas.dataset.stockFresh = String(fresh);
    if (count) {
      const body = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, count);
      const core = new THREE.InstancedMesh(coreGeometry, coreMaterial, count);
      const pallets = new THREE.InstancedMesh(palletGeometry, palletMaterial, placed.length);
      const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3(), scale = new THREE.Vector3();
      let index = 0;
      placed.forEach((p, palletIndex) => {
        position.set(p.x, .08 * p.scale, p.z); scale.setScalar(p.scale);
        pallets.setMatrixAt(palletIndex, matrix.compose(position, quaternion, scale));
        for (const roll of p.rolls) {
          position.set(p.x + roll.x * p.scale, roll.y * p.scale, p.z + roll.z * p.scale);
          scale.setScalar(roll.scale * p.scale);
          matrix.compose(position, quaternion, scale);
          body.setMatrixAt(index, matrix); core.setMatrixAt(index++, matrix);
        }
        const element = ownerDocument.createElement('div');
        element.dataset.factoryStockLabel = p.pile.stateId;
        element.textContent = `${p.pile.count} ${stock.rollLabel || 'rulon'}`;
        element.title = `${p.pile.name} · ${element.textContent}`;
        element.style.cssText = 'position:absolute;left:0;top:0;height:22px;box-sizing:border-box;text-align:center;padding:3px 6px;border:1px solid #e5eadd;border-radius:7px;background:#455e52eb;color:#fff;font:600 10px system-ui;white-space:nowrap;box-shadow:0 2px 5px #0002;';
        const badgeWidth = Math.max(56, element.textContent.length * 6 + 14);
        element.style.width = `${badgeWidth}px`;
        overlay.append(element);
        const top = p.rolls.reduce((top, r) => Math.max(top, r.y + r.height / 2), 0) * p.scale;
        labels.push({ element, badgeWidth, position: new THREE.Vector3(p.x, top + .3, p.z) });
      });
      for (const mesh of [body, core, pallets]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
      }
    }
    dirty = true;
    requestRender();
  }

  return {
    setState(next) {
      state = next;
      clearTimeout(expiry);
      if (stockIsFresh(state.stock)) expiry = setTimeout(() => {
        if (!disposed) rebuild();
      }, Math.max(1, state.stock.validUntil - Date.now() + 1));
      rebuild();
    },
    frame(cameraChanged) {
      const liveRects = getLabelRects();
      if (!dirty && !cameraChanged && previousLabelRects === liveRects) return;
      previousLabelRects = liveRects;
      dirty = false;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      // Reuse the live label layout; no forced DOM measurements in the RAF loop.
      const occupied = [...liveRects];
      for (const { element, position, badgeWidth } of labels) {
        projected.copy(position).project(camera);
        const x = (projected.x * .5 + .5) * width, y = (-projected.y * .5 + .5) * height;
        const rect = placeStockBadge(x, y, width, height, badgeWidth, occupied);
        element.hidden = state.showLabels === false || projected.z < -1 || projected.z > 1 ||
          x < 25 || x > width - 25 || y < 30 || y > height - 40 || !rect;
        if (!element.hidden) {
          occupied.push(rect);
          element.style.transform = `translate(${rect.x}px,${rect.y}px)`;
        }
      }
    },
    invalidate() { dirty = true; },
    dispose() {
      disposed = true;
      clearTimeout(expiry); clear(); scene.remove(group); overlay.remove();
      for (const resource of [bodyGeometry, coreGeometry, bodyMaterial, coreMaterial, palletGeometry, palletMaterial]) resource.dispose();
    },
  };
}
