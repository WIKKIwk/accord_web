// Accord web adaptation (2026-10-13): explicit React mount/disposal, loading
// events, selectable-object inventory, and preservation of the supplied CAD art.
import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
import { OrbitControls } from './OrbitControls.js';
import { CAMERA_LIMITS, constrainCamera, constrainIsolatedCamera, focusCamera, overviewCamera, smoothStep, visibleWorldBoxes } from './factory-map-navigation.js?v=20261013cadIsolation1';
import { buildPickBounds, closestMapHits, loadMapBytes, optimizeStaticMap } from './factory-map-performance.js?v=20260926perf2';
import { apparatusHit, apparatusObjectId, cleanFactoryMapGeometry, FACTORY_MAP_CLUTTER_BASE_IDS, isFactoryMapApparatus } from './factory-map-scene-policy.js?v=20260907live2';
import { createFactoryLive, FrameBudget } from './factory-map-live.js?v=20261013stages1';
import { createFactoryStock } from './factory-map-stock.js?v=20261013stages1';
import { createFactoryStageView } from './factory-map-stage-view.js?v=20261013cadIsolation1';
import { createFactoryCadCompanions } from './factory-map-cad-companions.js?v=20261013cadTheme1';
import { createFactoryCadTheme, FACTORY_CAD_THEME } from './factory-map-cad-theme.js?v=20261013cadTheme1';
import { lockFactoryMapGestures } from './factory-map-gestures.js?v=20260907touch1';

// The module is cached by the browser; mounting is explicit so route re-entry
// creates a fresh view without re-downloading the Three.js modules.
export function mountFactoryMap(targetCanvas) {
const canvas = targetCanvas || Array.from(
  document.querySelectorAll('[data-factory-map-canvas]'),
).find((candidate) => candidate.dataset.rendererInitialized !== 'true');
if (!canvas) {
  throw new Error('Factory map canvas not found');
}
canvas.dataset.rendererInitialized = 'true';
canvas.dataset.rendererDisposed = 'false';
const factoryMapHost = canvas.parentElement;
const unlockGestures = lockFactoryMapGestures(factoryMapHost);
const status = factoryMapHost.querySelector('[data-factory-map-status]');
const modelSource = canvas.dataset.modelSrc || '/model';
const initialSelectedObjectId = canvas.dataset.selectedObjectId || '';
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const selectableMeshes = [];
const selectableObjectsById = new Map();
const selectableInstancedMeshesById = new Map();
let selectionHelper = null;
let pointerStart = null;
const activePointers = new Set();
let pickBounds = [];
let mapBounds = null;
let obstacles = [];
let disposed = false;
let frameId = 0;
let tween = null;
let overview = null;
let overviewActive = true;
let beforeFocusOverview = true;
let beforeFocus = null;
let focusId = '';
let viewOffset = 0;
let interacting = false;
let settleFrames = 0;
let fullQualityTimer = 0;
let lastState = {};
let liveView = null;
let stockView = null;
let stageView = null;
let cadCompanions = null;
let cadTheme = null;
let beforeStageView = null;
let isolatedBounds = null;
let viewportVisible = true;
let diagnosticsAt = 0;
let renderCount = 0;
let previousDrawAt = 0;
let animationOnly = false;
const requestController = new AbortController();
const fullPixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
const frameBudget = new FrameBudget(fullPixelRatio);
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const stateHost = canvas.closest('[data-model-viewer-state]') || factoryMapHost;

const FACTORY_PALETTE = Object.freeze({
  background: 0xdaddd7,
  ground: 0xdde1d9,
  slab: 0xc8cec7,
  apparatus: 0xb6beb7,
  apparatusAccent: 0xc9cbbf,
  apparatusMarker: 0xe4dfd2,
  selected: 0x4f6fb5,
  healthy: 0x5faf7a,
  warning: 0xd6a34a,
  fault: 0xc85a5a,
});

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.setPixelRatio(fullPixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(FACTORY_PALETTE.background);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = .14;
controls.rotateSpeed = .55;
controls.panSpeed = .65;
controls.zoomSpeed = .6;
controls.autoRotate = false;
controls.enableZoom = true;
controls.enablePan = true;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
// Keep panning on the factory's horizontal plane so it cannot move the
// camera target below the map floor.
controls.screenSpacePanning = false;
controls.minPolarAngle = CAMERA_LIMITS.minPolar;
controls.maxPolarAngle = CAMERA_LIMITS.maxPolar;
controls.minDistance = CAMERA_LIMITS.minDistance;
controls.maxDistance = 160;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xf7fafc, 0x7d8790, 1.7));
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.1);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.bias = -0.0003;
keyLight.shadow.normalBias = 0.04;
keyLight.shadow.radius = 3;
scene.add(keyLight);
scene.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(0xd7e5f2, 0.8);
fillLight.position.set(40, 45, -35);
scene.add(fillLight);

function postFactoryMapMessage(payload) {
  const message = JSON.stringify(payload);
  const nativeChannel = window.FactoryMapChannel;
  if (nativeChannel && typeof nativeChannel.postMessage === 'function') {
    nativeChannel.postMessage(message);
  }
  const bridge = factoryMapHost.querySelector('[data-factory-map-bridge]');
  if (!bridge) {
    return;
  }
  bridge.setAttribute('data-model-viewer-channel', 'FactoryMapChannel');
  bridge.setAttribute('data-model-viewer-message', message);
  bridge.dispatchEvent(new Event('model-viewer-plus-message', { bubbles: true }));
}

function selectableObjectFor(mesh, parser, fallbackIndex) {
  let current = mesh;
  while (current && current.parent) {
    const association = parser.associations.get(current);
    if (Number.isInteger(association?.nodes)) {
      return {
        id: `node:${association.nodes}`,
        target: current,
      };
    }
    current = current.parent;
  }
  return {
    id: `mesh:${fallbackIndex}`,
    target: mesh,
  };
}

const APPARATUS_ATTACHMENT_MAP = Object.freeze({
  'node:33': 'node:39',
});

const APPARATUS_ATTACHED_BASES_MAP = Object.freeze({
  'node:39': ['node:33'],
});

// Flat rooftop arrows inlaid into many different apparatus roofs across the
// whole map (verified node:5: arrow silhouette, ~8 distinct roof positions on
// bodies node:1/3/6/7/18). One arrow mesh cannot map to one body, so taps
// fall through to the first non-arrow object behind them (the roof below).
// Unlike APPARATUS_ATTACHMENT_MAP above (one billboard bound to one body),
// pass-through needs no per-instance table and stays correct for every roof.
const ARROW_PASS_THROUGH_BASE_IDS = Object.freeze(['node:5']);

function isPassThroughArrowBaseId(baseId) {
  return ARROW_PASS_THROUGH_BASE_IDS.indexOf(baseId) !== -1;
}

// Hidden covers: verified covers whose removal reveals the apparatus
// beneath (node:32 canopy hides exactly one body, the node:39 room;
// node:40 7m compound walls + node:44/45 6m enclosure walls hide the whole
// SE cell interior; node:9/17 central canopies hide machines 19/21 and wall
// segments beneath them; floating billboard node:33 and text labels
// node:90/91 hover over the room hiding it from low angles; floating image
// boards node:60/61 hover side by side over the central machines).
// Hidden objects are never raycast targets and never highlight: taps land
// on the revealed bodies below.
// The GLB asset on disk is untouched; this is runtime-only and reversible.
const HIDDEN_ROOF_BASE_IDS = Object.freeze([
  'node:9',
  'node:17',
  'node:32',
  'node:33',
  'node:40',
  'node:44',
  'node:45',
  'node:60',
  'node:61',
  'node:90',
  'node:91',
]);

// Instance-level hidden cover (DB-verified 2026-09-04): the thick black
// second-floor cube tapped as node:30:instance:9 (5.5x2x5.5m, y 3.02-5.02,
// x 30.95-36.45, z 35.62-41.12, material None so sides render black).
// It sits directly on node:18/20/21 bodies below. Eight duplicated
// instances share the same transform (9/23/37/51/65/79/93/107) — all eight
// are collapsed, the other 104 node:30 instances across the map stay.
// Whole-node hiding is NOT used here: object.visible=false on an
// InstancedMesh would remove all 112 instances.
const HIDDEN_ROOF_INSTANCE_IDS = Object.freeze([
  'node:30:instance:9',
  'node:30:instance:23',
  'node:30:instance:37',
  'node:30:instance:51',
  'node:30:instance:65',
  'node:30:instance:79',
  'node:30:instance:93',
  'node:30:instance:107',
]);

function isHiddenRoofBaseId(baseId) {
  return HIDDEN_ROOF_BASE_IDS.indexOf(baseId) !== -1;
}

function isHiddenRoofInstanceId(objectId) {
  return HIDDEN_ROOF_INSTANCE_IDS.indexOf(objectId) !== -1;
}

function collapseHiddenRoofInstances(object, baseId) {
  if (!object.isInstancedMesh) {
    return;
  }
  // Bounds-safe: zero-scale IN PLACE, keeping the original translation.
  // Moving instances to (0,-1000,0) would pollute Box3.setFromObject
  // (InstancedMesh.computeBoundingBox unions every instance matrix),
  // dragging bounds.min.y to -1000 — the floor slab and the initial camera
  // are both derived from those bounds, so the floor color and the framing
  // would break. A zero-scaled instance contributes only its center point,
  // already inside the scene bounds.
  const originalMatrix = new THREE.Matrix4();
  const zeroScale = new THREE.Vector3(0, 0, 0);
  let collapsed = false;
  for (const hiddenId of HIDDEN_ROOF_INSTANCE_IDS) {
    const match = /^(.*):instance:(\d+)$/.exec(hiddenId);
    if (!match || match[1] !== baseId) {
      continue;
    }
    const instanceId = Number(match[2]);
    if (
      Number.isInteger(instanceId) &&
      instanceId >= 0 &&
      instanceId < object.count
    ) {
      object.getMatrixAt(instanceId, originalMatrix);
      originalMatrix.scale(zeroScale);
      object.setMatrixAt(instanceId, originalMatrix);
      collapsed = true;
    }
  }
  if (collapsed) {
    object.instanceMatrix.needsUpdate = true;
  }
}

function canonicalApparatusBaseId(baseId) {
  return APPARATUS_ATTACHMENT_MAP[baseId] || baseId;
}

function canonicalApparatusObjectId(objectId) {
  if (!objectId) {
    return objectId;
  }
  const match = /^(.*):instance:(\d+)$/.exec(objectId);
  if (match) {
    const canonicalBase = canonicalApparatusBaseId(match[1]);
    return selectionIdFor(canonicalBase, Number(match[2]));
  }
  return canonicalApparatusBaseId(objectId);
}

function selectionIdFor(baseId, instanceId) {
  return Number.isInteger(instanceId)
    ? `${baseId}:instance:${instanceId}`
    : baseId;
}

function selectionBaseIdFor(object, selectable, parser) {
  const association = parser.associations.get(object);
  const primitiveIndex = association?.primitives;
  if (
    selectable.target !== object &&
    Number.isInteger(primitiveIndex)
  ) {
    return `${selectable.id}:primitive:${primitiveIndex}`;
  }
  return selectable.id;
}

function registerSelectableTarget(objectId, object, instanceId = null) {
  if (!selectableObjectsById.has(objectId)) {
    selectableObjectsById.set(objectId, {
      object,
      instanceId,
    });
  }
}

function factoryMapReplacementOwner(object) {
  for (let current = object; current; current = current.parent) {
    if (current.userData?.factory_map_object_id) {
      return current;
    }
  }
  return null;
}

function registerSelectableObjects(root, parser) {
  let fallbackIndex = 0;
  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) {
      return;
    }
    const replacement = factoryMapReplacementOwner(object);
    if (replacement) {
      const objectId = replacement.userData.factory_map_object_id;
      object.userData.factoryMapObjectId = objectId;
      // Every cabinet/roller must select the same persisted apparatus ID,
      // and the highlight must cover the complete machine, not one small part.
      selectableMeshes.push(object);
      const target = { object: replacement, instanceId: null };
      selectableObjectsById.set(objectId, target);
      for (const alias of replacement.userData.factory_map_aliases ?? []) {
        selectableObjectsById.set(alias, target);
      }
      return;
    }
    const selectable = selectableObjectFor(object, parser, fallbackIndex++);
    const rawBaseId = selectionBaseIdFor(object, selectable, parser);
    const selectionBaseId = canonicalApparatusBaseId(rawBaseId);
    cleanFactoryMapGeometry(object, rawBaseId);
    // Pass-through arrows are never raycast targets: the tap lands on the
    // roof/body below them, so an arrow can never be picked or highlighted
    // as a separate object. They stay registered for id lookup, only the
    // raycast list skips them.
    // Hidden roofs are removed from view AND touch: taps land on the
    // revealed body below.
    const isHiddenRoof =
      isHiddenRoofBaseId(selectionBaseId) ||
      isHiddenRoofBaseId(rawBaseId) ||
      FACTORY_MAP_CLUTTER_BASE_IDS.includes(rawBaseId) ||
      object.userData?.factory_map_hidden === true;
    if (isHiddenRoof) {
      object.visible = false;
    }
    if (!isPassThroughArrowBaseId(selectionBaseId) &&
        !isPassThroughArrowBaseId(rawBaseId) &&
        !isHiddenRoof) {
      selectableMeshes.push(object);
    }
    if (object.isInstancedMesh) {
      object.userData.factoryMapObjectSelectionBaseId = selectionBaseId;
      object.userData.factoryMapRawBaseId = rawBaseId;
      // Instance-level covers: collapse only the black-cube instances,
      // keep the remaining instances of the same node visible + tappable.
      collapseHiddenRoofInstances(object, rawBaseId);
      if (rawBaseId !== selectionBaseId) {
        collapseHiddenRoofInstances(object, selectionBaseId);
      }
      selectableInstancedMeshesById.set(rawBaseId, object);
      if (rawBaseId === selectionBaseId) {
        selectableInstancedMeshesById.set(selectionBaseId, object);
        registerSelectableTarget(selectionBaseId, object);
      }
      // Keep old node-level IDs resolvable for existing placements. New taps
      // use the instance-specific ID below.
      registerSelectableTarget(rawBaseId, object);
      return;
    }
    object.userData.factoryMapObjectId = selectionBaseId;
    object.userData.factoryMapRawBaseId = rawBaseId;
    if (rawBaseId === selectionBaseId) {
      registerSelectableTarget(selectionBaseId, object);
    }
    registerSelectableTarget(rawBaseId, object);
  });
}

function selectableTargetForId(objectId) {
  const canonicalId = canonicalApparatusObjectId(objectId);
  const directTarget = selectableObjectsById.get(canonicalId);
  if (directTarget) {
    return directTarget;
  }

  const match = /^(.*):instance:(\d+)$/.exec(canonicalId);
  if (!match) {
    return null;
  }
  const instanceId = Number(match[2]);
  const object = selectableInstancedMeshesById.get(match[1]);
  if (
    !object ||
    !Number.isInteger(instanceId) ||
    instanceId < 0 ||
    instanceId >= object.count
  ) {
    return null;
  }
  const target = {
    object,
    instanceId: Number.isInteger(instanceId) ? instanceId : null,
  };
  selectableObjectsById.set(canonicalId, target);
  if (objectId !== canonicalId) {
    selectableObjectsById.set(objectId, target);
  }
  return target;
}

function selectionHelperFor(target) {
  if (!Number.isInteger(target.instanceId) || !target.object.isInstancedMesh) {
    return new THREE.BoxHelper(target.object, FACTORY_PALETTE.selected);
  }

  target.object.geometry.computeBoundingBox();
  const instanceBox = target.object.geometry.boundingBox.clone();
  const instanceMatrix = new THREE.Matrix4();
  target.object.getMatrixAt(target.instanceId, instanceMatrix);
  instanceBox.applyMatrix4(instanceMatrix);
  target.object.updateWorldMatrix(true, false);
  instanceBox.applyMatrix4(target.object.matrixWorld);

  const baseId =
    target.object.userData?.factoryMapRawBaseId ||
    target.object.userData?.factoryMapObjectSelectionBaseId;
  const canonicalBaseId = canonicalApparatusBaseId(baseId);
  const attachedBaseIds = APPARATUS_ATTACHED_BASES_MAP[canonicalBaseId];
  if (attachedBaseIds) {
    for (const attachedBaseId of attachedBaseIds) {
      const attachedMesh = selectableInstancedMeshesById.get(attachedBaseId);
      if (attachedMesh && attachedMesh.isInstancedMesh) {
        // Attached nodes like node:34 / node:38 alternate two physical
        // positions across even/odd instances, but both positions sit on the
        // same apparatus body. Union every instance so the highlight always
        // covers the full apparatus + all of its overhead arrows.
        attachedMesh.geometry.computeBoundingBox();
        attachedMesh.updateWorldMatrix(true, false);
        const attachedCount = attachedMesh.count || 0;
        for (let i = 0; i < attachedCount; i++) {
          const attachedBox = attachedMesh.geometry.boundingBox.clone();
          const attachedMatrix = new THREE.Matrix4();
          attachedMesh.getMatrixAt(i, attachedMatrix);
          attachedBox.applyMatrix4(attachedMatrix);
          attachedBox.applyMatrix4(attachedMesh.matrixWorld);
          instanceBox.union(attachedBox);
        }
      }
    }
  }

  return new THREE.Box3Helper(instanceBox, FACTORY_PALETTE.selected);
}

function selectObject(objectId, emitMessage = true) {
  const canonicalId = canonicalApparatusObjectId(objectId);
  // Pass-through arrows are never objects: no highlight, no message, from
  // any path (tap, initial selection, legacy saves). There is only the body.
  // Hidden roofs share the same rule (whole-node + collapsed instances).
  if (isHiddenRoofInstanceId(canonicalId) ||
      isHiddenRoofInstanceId(objectId)) {
    return;
  }
  const canonicalBase = (() => {
    const m = /^(.*):instance:\d+$/.exec(canonicalId);
    return m ? m[1] : canonicalId;
  })();
  if (isPassThroughArrowBaseId(canonicalBase) ||
      isHiddenRoofBaseId(canonicalBase)) {
    return;
  }
  const target = selectableTargetForId(canonicalId);
  if (!target || !isFactoryMapApparatus(target.object)) {
    return;
  }
  if (selectionHelper) {
    scene.remove(selectionHelper);
    selectionHelper.geometry.dispose();
    selectionHelper.material.dispose();
  }
  selectionHelper = selectionHelperFor(target);
  selectionHelper.material.depthTest = false;
  selectionHelper.renderOrder = 1000;
  scene.add(selectionHelper);
  requestRender();
  if (emitMessage) {
    postFactoryMapMessage({
      type: 'object_tap',
      objectId: apparatusObjectId(target.object),
      label: target.object.userData.factory_map_label || `3D obyekt · ${canonicalId}`,
    });
  }
}

function selectObjectAt(clientX, clientY) {
  if (lastState.enabled === false) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Collapsed instances are zero-scaled so they normally miss, but filter
  // explicitly: take the first hit that is not a hidden roof instance, so
  // taps land on the revealed body below the black cube.
  const hits = closestMapHits(raycaster, pickBounds);
  for (const hit of hits) {
    const hitSelectionBaseId = hit?.object?.userData?.factoryMapObjectSelectionBaseId;
    const hitObjectId = hitSelectionBaseId
      ? selectionIdFor(hitSelectionBaseId, hit?.instanceId)
      : hit?.object?.userData?.factoryMapObjectId;
    if (!hitObjectId) {
      continue;
    }
    if (stageView?.isolatedObjectId && apparatusObjectId(hit.object) !== stageView.isolatedObjectId) continue;
    if (isHiddenRoofInstanceId(canonicalApparatusObjectId(hitObjectId)) ||
        isHiddenRoofInstanceId(hitObjectId)) {
      continue;
    }
    if (!apparatusHit([hit])) return;
    selectObject(hitObjectId);
    return;
  }
}

canvas.addEventListener('pointerdown', (event) => {
  activePointers.add(event.pointerId);
  if (activePointers.size > 1) {
    pointerStart = null;
    return;
  }
  pointerStart = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
  };
}, { signal: requestController.signal });

canvas.addEventListener('pointerup', (event) => {
  activePointers.delete(event.pointerId);
  const start = pointerStart;
  pointerStart = null;
  if (!start || start.id !== event.pointerId) {
    return;
  }
  const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  if (distance <= 8 && performance.now() - start.at <= 700) {
    selectObjectAt(event.clientX, event.clientY);
  }
}, { signal: requestController.signal });

canvas.addEventListener('pointercancel', () => {
  activePointers.clear();
  pointerStart = null;
}, { signal: requestController.signal });

function replaceUnlitMaterial(material) {
  if (!material?.isMeshBasicMaterial) {
    return material;
  }
  const litMaterial = new THREE.MeshStandardMaterial({
    color: material.color?.clone() ?? new THREE.Color(0xffffff),
    map: material.map ?? null,
    transparent: material.transparent,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
    side: material.side,
    vertexColors: material.vertexColors,
    roughness: 0.92,
    metalness: 0,
  });
  litMaterial.name = material.name;
  material.dispose();
  return litMaterial;
}

function applyFactoryPalette(material) {
  if (!material) {
    return material;
  }
  const color = material.name === 'PaletteMaterial001'
    ? FACTORY_PALETTE.apparatus
    : material.name === 'PaletteMaterial002'
      ? FACTORY_PALETTE.apparatusAccent
      : null;
  if (color === null) {
    return material;
  }
  // The GLB palette texture is the source of the saturated red. Remove only
  // that base-color texture at runtime and retain the original asset on disk.
  material.map = null;
  material.color.setHex(color);
  material.roughness = Math.max(material.roughness ?? 0.82, 0.82);
  material.metalness = Math.min(material.metalness ?? 0, 0.08);
  return material;
}

const styledMaterials = new WeakMap();
function styleFactoryMaterial(material) {
  if (!styledMaterials.has(material)) {
    styledMaterials.set(material, applyFactoryPalette(replaceUnlitMaterial(material)));
  }
  return styledMaterials.get(material);
}

// Arrow-bearing spots are apparatuses: the verified arrow meshes (node:5 flat
// rooftop arrows, node:33 billboard) AND the bodies beneath them (node:1, 3,
// 6, 7, 18, 19 walls/blocks, node:39 room) share one marker color, so each pair
// reads as a single apparatus object. Materials are shared across the map, so
// each marked object gets its own clone; the shared originals are untouched.
// Runs after enableRealShadows (which needs userData set by registration).
const APPARATUS_MARKER_BASE_IDS = Object.freeze([
  'node:1',
  'node:3',
  'node:5',
  'node:6',
  'node:7',
  'node:18',
  'node:19',
  'node:33',
  'node:39',
]);

function markerBaseIdOf(objectId) {
  if (!objectId) {
    return '';
  }
  return objectId.replace(/:primitive:\d+$/, '');
}

function applyApparatusMarkerTint(root) {
  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) {
      return;
    }
    const rawBaseId = markerBaseIdOf(object.userData?.factoryMapRawBaseId);
    const selectionBaseId = markerBaseIdOf(
      object.userData?.factoryMapObjectSelectionBaseId,
    );
    const isMarked =
      APPARATUS_MARKER_BASE_IDS.indexOf(rawBaseId) !== -1 ||
      APPARATUS_MARKER_BASE_IDS.indexOf(selectionBaseId) !== -1;
    if (!isMarked) {
      return;
    }
    const tint = (material) => {
      const clone = material.clone();
      if ('color' in clone && clone.color) {
        clone.color.setHex(FACTORY_PALETTE.apparatusMarker);
      }
      if ('emissive' in clone && clone.emissive) {
        clone.emissive.setHex(FACTORY_PALETTE.apparatusMarker);
        clone.emissiveIntensity = 0.2;
      }
      clone.needsUpdate = true;
      return clone;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(tint)
      : tint(object.material);
  });
}

function enableRealShadows(root, bounds) {
  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) {
      return;
    }
    object.castShadow = true;
    object.receiveShadow = true;
    if (Array.isArray(object.material)) {
      object.material = object.material.map(styleFactoryMaterial);
    } else {
      object.material = styleFactoryMaterial(object.material);
    }
  });

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const floorY = Math.min(bounds.min.y - 0.06, -0.06);
  const floorSize = Math.max(size.x, size.z) * 1.35;
  const slabThickness = Math.max(size.y * 0.003, 0.18);
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(floorSize, slabThickness, floorSize),
    new THREE.MeshStandardMaterial({
      color: FACTORY_PALETTE.ground,
      roughness: 0.96,
      metalness: 0,
    }),
  );
  slab.position.set(center.x, floorY - slabThickness / 2, center.z);
  slab.receiveShadow = true;
  scene.add(slab);

  const slabEdgeThickness = Math.max(slabThickness * 0.4, 0.08);
  const slabEdge = new THREE.Mesh(
    new THREE.BoxGeometry(
      floorSize * 1.025,
      slabEdgeThickness,
      floorSize * 1.025,
    ),
    new THREE.MeshStandardMaterial({
      color: FACTORY_PALETTE.slab,
      roughness: 0.9,
      metalness: 0,
    }),
  );
  slabEdge.position.set(
    center.x,
    floorY - slabThickness - slabEdgeThickness / 2,
    center.z,
  );
  slabEdge.receiveShadow = true;
  scene.add(slabEdge);

  const extent = Math.max(size.x, size.z, 30);
  scene.fog = new THREE.Fog(
    FACTORY_PALETTE.background,
    extent * 2.4,
    extent * 7,
  );
  keyLight.position.set(center.x - extent, center.y + extent * 1.8, center.z + extent * 0.45);
  keyLight.target.position.set(center.x, 0, center.z);
  keyLight.shadow.camera.left = -extent * 1.25;
  keyLight.shadow.camera.right = extent * 1.25;
  keyLight.shadow.camera.top = extent * 1.35;
  keyLight.shadow.camera.bottom = -extent * 1.35;
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = extent * 5;
  keyLight.shadow.camera.updateProjectionMatrix();

  const distance = Math.max(size.x, size.z) * 1.15;
  camera.position.set(
    center.x + distance * 0.82,
    center.y + distance * 0.78,
    center.z + distance * 0.82,
  );
  controls.target.set(center.x, 0, center.z);
  controls.update();
}

function updateProjection() {
  if (viewOffset) {
    camera.setViewOffset(canvas.clientWidth, canvas.clientHeight, 0,
      canvas.clientHeight * viewOffset, canvas.clientWidth, canvas.clientHeight);
  } else {
    camera.clearViewOffset();
  }
}

function snapshotCamera() {
  return { position: camera.position.clone(), target: controls.target.clone(), offset: viewOffset,
    near: camera.near, far: camera.far, minDistance: controls.minDistance, maxDistance: controls.maxDistance };
}

function resetDamping() {
  // Use the public API to consume any residual drag before a scripted flight.
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
}

function animateCamera(destination, complete) {
  const from = snapshotCamera();
  // Flights use the union of the old/new orbit ranges. Applying a tiny
  // apparatus range before the tween would snap the factory camera abruptly.
  controls.minDistance = Math.min(from.minDistance, destination.minDistance ?? from.minDistance);
  controls.maxDistance = Math.max(from.maxDistance, destination.maxDistance ?? from.maxDistance);
  resetDamping();
  tween = { from, to: destination, at: performance.now(), complete,
    duration: (lastState.reducedMotion || reducedMotionQuery.matches) ? 0 : CAMERA_LIMITS.duration };
  requestRender();
}

function handleRendererState() {
  let state;
  try { state = JSON.parse(stateHost.getAttribute('data-model-viewer-state') || '{}'); }
  catch { return; }
  const previous = lastState;
  lastState = state;
  // Material/background swaps are independent of camera, isolation and live
  // motion state. No renderer remount, model parse or focus flight is needed.
  const theme = state.theme === 'dark' ? 'dark' : 'light';
  if (cadTheme) {
    cadTheme.setTheme(theme);
    scene.background.setHex(FACTORY_CAD_THEME[theme].background);
  }
  canvas.dataset.cadTheme = theme;
  canvas.dataset.renderSuspended = String(state.renderSuspended === true);
  // A sheet pauses GPU work, not the ERP labels visible behind it.
  // Both projections retain their expiry timers and update their DOM here.
  if (mapBounds) {
    const requested = state.isolatedObjectId || '';
    if (requested && !stageView?.isolatedObjectId && !beforeStageView) beforeStageView = {
      ...(beforeFocus || snapshotCamera()), aspect: camera.aspect,
      maxDistance: controls.maxDistance, minDistance: controls.minDistance,
    };
    const isolation = stageView?.setObject(requested);
    if (isolation?.changed) renderer.shadowMap.needsUpdate = true;
    isolatedBounds = stageView?.isolatedObjectId ? (() => {
      const target = selectableTargetForId(stageView.isolatedObjectId);
      const helper = selectionHelperFor(target);
      const box = new THREE.Box3().setFromObject(helper);
      helper.geometry.dispose(); helper.material.dispose();
      return box;
    })() : null;
    canvas.dataset.stageView = stageView?.isolatedObjectId ? 'isolated' : 'overview';
    canvas.dataset.isolatedObjectId = stageView?.isolatedObjectId || '';
    canvas.dataset.visibleApparatusIds = JSON.stringify(stageView?.isolatedObjectId ? [stageView.isolatedObjectId] : []);
    canvas.dataset.cadStageContrast = 'false';
    canvas.dataset.isolatedCadSegments = String(stageView?.isolatedObjectId ? cadCompanions?.get(stageView.isolatedObjectId, selectableTargetForId(stageView.isolatedObjectId)?.object)
      .reduce((count, object) => count + object.geometry.index.count / 2, 0) || 0 : 0);
    liveView?.setState(state);
    stockView?.setState(state);
  }
  if (state.renderSuspended === true) {
    cancelAnimationFrame(frameId);
    frameId = 0;
    frameBudget.resetTiming();
    // Lay out HTML badges only. No reel animation or WebGL draw behind a sheet.
    liveView?.frame(performance.now(), true, true);
    stockView?.frame(true);
    return;
  }
  if (!mapBounds) return;
  controls.enabled = state.enabled !== false;
  if (state.selectedObjectId && state.selectedObjectId !== previous.selectedObjectId) {
    selectObject(state.selectedObjectId, false);
  }
  const resetting = state.resetRevision !== previous.resetRevision && state.resetRevision > 0;
  if (resetting) {
    beforeFocus = null;
    focusId = '';
    overviewActive = true;
    overview = overviewCamera(mapBounds, camera, obstacles);
    const restored = beforeStageView && beforeStageView.aspect === camera.aspect ? beforeStageView : overview;
    if (!state.isolatedObjectId) beforeStageView = null;
    if (selectionHelper) {
      scene.remove(selectionHelper); selectionHelper.geometry.dispose(); selectionHelper.material.dispose(); selectionHelper = null;
    }
    animateCamera(restored);
  }
  if (((state.focusedObjectId || '') !== focusId || state.isolatedObjectId !== previous.isolatedObjectId) && (!resetting || state.focusedObjectId)) {
    focusId = state.focusedObjectId || '';
    if (!focusId) {
      if (beforeStageView && !state.isolatedObjectId) {
        animateCamera(beforeStageView.aspect === camera.aspect ? beforeStageView : overviewCamera(mapBounds, camera, obstacles));
        beforeStageView = null;
      } else if (beforeFocus) animateCamera(beforeFocus);
      overviewActive = beforeFocusOverview;
      beforeFocus = null;
      if (selectionHelper) {
        scene.remove(selectionHelper);
        selectionHelper.geometry.dispose();
        selectionHelper.material.dispose();
        selectionHelper = null;
      }
    } else {
      const target = selectableTargetForId(focusId);
      if (target) {
        if (!beforeFocus) beforeFocusOverview = overviewActive;
        overviewActive = false;
        beforeFocus ??= snapshotCamera();
        selectObject(focusId, false);
        // BoxHelper also handles old instance IDs; its geometry is already
        // in world space, so framing and the visible highlight always agree.
        selectionHelper.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(selectionHelper);
        const selectedId = focusId;
        const destination = focusCamera(box, camera, controls.target, mapBounds, isolatedBounds ? [isolatedBounds] : obstacles, Boolean(isolatedBounds));
        animateCamera(destination, () => {
          if (focusId === selectedId) postFactoryMapMessage({ type: 'focus_complete', objectId: selectedId });
        });
      } else {
        postFactoryMapMessage({ type: 'focus_complete', objectId: focusId });
      }
    }
  }
  requestRender();
}

function requestRender() {
  if (!disposed && !frameId && !document.hidden && viewportVisible && !lastState.renderSuspended) frameId = requestAnimationFrame(renderFrame);
}

function renderFrame(now) {
  frameId = 0;
  if (disposed || document.hidden || !viewportVisible || lastState.renderSuspended) return;
  // Stationary reels need 30 updates/second. Gestures and camera flights remain
  // responsive to every RAF; elapsed time still drives the reel rotation.
  if (animationOnly && !interacting && !tween && settleFrames <= 0 &&
      now - previousDrawAt < 1000 / 30 - 1) {
    requestRender();
    return;
  }
  previousDrawAt = now;
  const started = performance.now();
  const flying = Boolean(tween);
  let finished = null;
  if (tween) {
    const t = tween.duration ? Math.min(1, (now - tween.at) / tween.duration) : 1;
    const progress = smoothStep(t);
    camera.position.lerpVectors(tween.from.position, tween.to.position, progress);
    controls.target.lerpVectors(tween.from.target, tween.to.target, progress);
    viewOffset = THREE.MathUtils.lerp(tween.from.offset, tween.to.offset, progress);
    camera.near = THREE.MathUtils.lerp(tween.from.near, tween.to.near ?? tween.from.near, progress);
    camera.far = THREE.MathUtils.lerp(tween.from.far, tween.to.far ?? tween.from.far, progress);
    if (t === 1) {
      controls.minDistance = tween.to.minDistance ?? tween.from.minDistance;
      controls.maxDistance = tween.to.maxDistance ?? tween.from.maxDistance;
      finished = tween.complete; tween = null;
    }
  }
  const changed = controls.update();
  if (changed || flying || !renderCount) {
    if (isolatedBounds) constrainIsolatedCamera(camera.position, controls.target, isolatedBounds, controls.maxDistance, controls.minDistance);
    else if (mapBounds) constrainCamera(camera.position, controls.target, mapBounds, obstacles, controls.maxDistance, controls.minDistance);
    camera.lookAt(controls.target);
    updateProjection();
  }
  camera.updateMatrixWorld();
  const animated = liveView?.frame(now, changed || flying,
    lastState.reducedMotion || reducedMotionQuery.matches) || false;
  stockView?.frame(changed || flying);
  const continuing = tween || interacting || changed || animated || settleFrames > 0;
  // Final stills and the focus handshake are drawn sharply before Flutter
  // freezes the view behind the details sheet.
  if ((!continuing || finished) && renderer.getPixelRatio() !== fullPixelRatio) {
    renderer.setPixelRatio(fullPixelRatio);
  }
  renderer.render(scene, camera);
  renderCount++;
  if (continuing && !finished && frameBudget.sample(now)) renderer.setPixelRatio(interacting
    ? Math.min(frameBudget.ratio, 1) : frameBudget.ratio);
  // Frame intervals (not CPU submission time) expose actual browser pacing.
  // Throttle diagnostics/labels; only reels update during stationary animation.
  animationOnly = animated && !tween && !interacting && !changed && settleFrames <= 0;
  if (now - diagnosticsAt > 250 || !continuing) {
  diagnosticsAt = now;
  canvas.dataset.renderCount = String(renderCount);
  canvas.dataset.drawCalls = String(renderer.info.render.calls);
  canvas.dataset.triangles = String(renderer.info.render.triangles);
  canvas.dataset.renderMs = (performance.now() - started).toFixed(2);
  canvas.dataset.cameraPosition = camera.position.toArray().map(v => v.toFixed(3)).join(',');
  canvas.dataset.cameraTarget = controls.target.toArray().map(v => v.toFixed(3)).join(',');
  canvas.dataset.cameraMotion = tween ? 'animating' : interacting ? 'gesture' : 'idle';
  canvas.dataset.cameraDamping = String(changed);
  canvas.dataset.cameraAutoRotate = String(controls.autoRotate);
  canvas.dataset.cameraClip = `${camera.near.toFixed(5)},${camera.far.toFixed(3)}`;
  canvas.dataset.cameraOrbit = `${controls.minDistance.toFixed(3)},${controls.maxDistance.toFixed(3)}`;
  canvas.dataset.fps = frameBudget.metrics.fps.toFixed(1);
  canvas.dataset.frameP95 = frameBudget.metrics.p95.toFixed(1);
  canvas.dataset.slowFrames = String(frameBudget.metrics.slowFrames);
  canvas.dataset.pixelRatio = renderer.getPixelRatio().toFixed(2);
  }
  finished?.();
  if (tween || interacting || changed || animated || settleFrames-- > 0) requestRender();
  else frameBudget.resetTiming();
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) {
    return;
  }
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (mapBounds && overviewActive) {
    overview = overviewCamera(mapBounds, camera, obstacles);
    controls.maxDistance = overview.maxDistance;
    camera.position.copy(overview.position);
    controls.target.copy(overview.target);
    controls.minDistance = overview.minDistance; camera.near = overview.near; camera.far = overview.far;
    viewOffset = 0;
    tween = null;
    resetDamping();
  } else if (isolatedBounds) {
    const fitted = focusCamera(isolatedBounds, camera, controls.target, mapBounds, [], true);
    camera.position.copy(fitted.position); controls.target.copy(fitted.target);
    controls.minDistance = fitted.minDistance; controls.maxDistance = fitted.maxDistance;
    camera.near = fitted.near; camera.far = fitted.far; viewOffset = 0; tween = null;
    resetDamping();
  }
  updateProjection();
  liveView?.invalidate();
  stockView?.invalidate();
  requestRender();
}

controls.addEventListener('change', requestRender);
controls.addEventListener('start', () => {
  overviewActive = false;
  interacting = true;
  tween = null;
  // Slightly lower raster resolution only while moving; exact original
  // material/geometry and full resting quality are restored after settling.
  window.clearTimeout(fullQualityTimer);
  renderer.setPixelRatio(Math.min(frameBudget.ratio, 1));
  requestRender();
});
controls.addEventListener('end', () => {
  interacting = false;
  // OrbitControls keeps requesting frames while damping actually changes.
  // Thirty unconditional frames can waste 10–15 seconds on an overloaded GPU.
  settleFrames = 2;
  fullQualityTimer = window.setTimeout(() => {
    // A completed gesture must not leave a still map at the overload ratio.
    renderer.setPixelRatio(fullPixelRatio);
    requestRender();
  }, 250);
  requestRender();
});
window.addEventListener('resize', resize);
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(canvas);
const visibilityObserver = new IntersectionObserver(entries => {
  const visible = entries[0]?.isIntersecting !== false;
  if (visible !== viewportVisible) frameBudget.resetTiming();
  viewportVisible = visible;
  requestRender();
});
visibilityObserver.observe(canvas);
stateHost.addEventListener('model-viewer-state', handleRendererState);
function handleVisibilityChange() {
  frameBudget.resetTiming();
  if (document.hidden) {
    cancelAnimationFrame(frameId);
    frameId = 0;
  } else requestRender();
}
document.addEventListener('visibilitychange', handleVisibilityChange);

function disposeScene(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach(value => value.dispose());
  materials.forEach(value => value.dispose());
  textures.forEach(value => value.dispose());
}

function dispose() {
  if (disposed) return;
  disposed = true;
  unlockGestures();
  requestController.abort();
  cancelAnimationFrame(frameId);
  window.clearTimeout(fullQualityTimer);
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  stateHost.removeEventListener('model-viewer-state', handleRendererState);
  stateHost.removeEventListener('model-viewer-dispose', dispose);
  resizeObserver.disconnect();
  visibilityObserver.disconnect();
  liveView?.dispose();
  stockView?.dispose();
  stageView?.restore();
  cadTheme?.dispose();
  controls.dispose();
  disposeScene(scene);
  renderer.dispose();
  renderer.forceContextLoss();
  canvas.dataset.rendererDisposed = 'true';
}
stateHost.addEventListener('model-viewer-dispose', dispose);

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = 'Zavod modeli yuklanmadi';
  status.title = message;
  status.hidden = false;
  status.style.display = 'grid';
  postFactoryMapMessage({ type: 'load_error', message });
  console.error('Factory map load failed', error);
}

async function loadModel() {
  const timeout = window.setTimeout(() => requestController.abort(), 60000);

  try {
    const compressedSource = canvas.dataset.modelGzipSrc;
    const data = await loadMapBytes(new URL(modelSource, document.baseURI).href,
      requestController.signal, fetch,
      compressedSource ? new URL(compressedSource, document.baseURI).href : '',
      (loaded, total) => postFactoryMapMessage({ type: 'load_progress', loaded, total }));
    if (disposed) return;
    postFactoryMapMessage({ type: 'load_prepare' });
    await new Promise((resolve, reject) => {
      new GLTFLoader().parse(
        data,
        '',
        (gltf) => {
          const root = gltf.scene;
          if (disposed) { disposeScene(root); resolve(); return; }
          scene.add(root);
          registerSelectableObjects(root, gltf.parser);
          canvas.dataset.factoryMapStyle = root.userData.factory_map_style || 'original';
          canvas.dataset.replacementCount = String(root.children.filter(
            (object) => object.userData.factory_map_object_id,
          ).length);
          const bounds = new THREE.Box3().setFromObject(root);
          // Light mode retains this export's exact unlit greys and black
          // contours. Dark variants affect only this renderer's cloned materials.
          if (root.userData.factory_map_style === 'cad-line-art') {
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.shadowMap.enabled = false;
            scene.background.setHex(FACTORY_CAD_THEME.light.background);
          } else {
            enableRealShadows(root, bounds);
            applyApparatusMarkerTint(root);
          }
          pickBounds = buildPickBounds(selectableMeshes);
          // Before static proxies hide original meshes: retain all floor-level
          // solids for stock placement, including the complete apparatus body.
          const stockObstacles = visibleWorldBoxes(root);
          const optimized = optimizeStaticMap(root);
          if (root.userData.factory_map_style === 'cad-line-art') {
            cadTheme = createFactoryCadTheme(root);
            cadTheme.setTheme(lastState.theme);
            scene.background.setHex(FACTORY_CAD_THEME[cadTheme.theme].background);
            cadCompanions = createFactoryCadCompanions(root, (lines, source) => cadTheme.register(lines, source));
          }
          stageView = createFactoryStageView(root, id => {
            const target = selectableTargetForId(id);
            return target && isFactoryMapApparatus(target.object) ? { ...target, companions: cadCompanions?.get(id, target.object) || [] } : null;
          });
          canvas.dataset.instancesBefore = String(optimized.instancesBefore);
          canvas.dataset.instancesAfter = String(optimized.instancesAfter);
          canvas.dataset.batchedMeshes = String(optimized.meshesBefore);
          canvas.dataset.staticBatches = String(optimized.meshesAfter);
          mapBounds = bounds;
          // A batch's broad box may span an aisle. Camera collision must use
          // each original solid, just like stock placement and picking.
          obstacles = stockObstacles;
          if (canvas.dataset.selectionMode !== 'true') {
            const getMachineBox = id => {
              const target = selectableTargetForId(id);
              if (!target || !isFactoryMapApparatus(target.object)) return null;
              const helper = selectionHelperFor(target);
              const box = new THREE.Box3().setFromObject(helper);
              helper.geometry.dispose(); helper.material.dispose();
              return box;
            };
            liveView = createFactoryLive({ host: factoryMapHost, root, camera, canvas,
              requestRender, onSelect: id => selectObject(id),
              getBox: getMachineBox });
            stockView = createFactoryStock({ host: factoryMapHost, scene, camera, canvas,
              bounds, obstacles: stockObstacles, getBox: getMachineBox,
              getLabelRects: liveView.getLabelRects, requestRender });
          }
          controls.maxDistance = bounds.getSize(new THREE.Vector3()).length() * CAMERA_LIMITS.maxExtentMultiplier;
          constrainCamera(camera.position, controls.target, mapBounds, obstacles);
          renderer.shadowMap.needsUpdate = true;
          status.hidden = true;
          status.style.display = 'none';
          resize();
          overview = overviewCamera(mapBounds, camera, obstacles);
          controls.maxDistance = overview.maxDistance;
          camera.position.copy(overview.position);
          controls.target.copy(overview.target);
          controls.minDistance = overview.minDistance; camera.near = overview.near; camera.far = overview.far; updateProjection();
          controls.update();
          if (initialSelectedObjectId) {
            selectObject(initialSelectedObjectId, canvas.dataset.selectionMode === 'true');
          }
          handleRendererState();
          const objects = [];
          root.traverse(object => {
            if (object.userData.factory_map_object_id) objects.push({
              objectId: object.userData.factory_map_object_id,
              label: object.userData.factory_map_label || object.name,
              aliases: object.userData.factory_map_aliases || [],
            });
          });
          postFactoryMapMessage({ type: 'load_complete', objects });
          resolve();
        },
        reject,
      );
    });
  } catch (error) {
    if (disposed) return;
    showError(error?.name === 'AbortError'
      ? new Error('Model yuklanishi 60 soniyada tugamadi')
      : error);
  } finally {
    window.clearTimeout(timeout);
  }
}

loadModel().catch(showError);
return dispose;
}
