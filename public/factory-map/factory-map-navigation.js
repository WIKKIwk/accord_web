// Accord web adaptation (2026-10-13): fit the entire factory in the available
// web viewport, including narrow layouts and resized/fullscreen overviews.
import { Box3, Matrix4, MathUtils, Spherical, Vector3 } from './three.module.js';

// Keep perspective and the original models; only constrain the visitor's camera.
export const CAMERA_LIMITS = Object.freeze({
  minPolar: Math.PI / 9,
  maxPolar: Math.PI / 3,
  clearance: 1.4,
  // This is a factory overview, not a first-person walkthrough. Keep enough
  // context around even a manually zoomed target on a narrow phone screen.
  minDistance: 24,
  maxExtentMultiplier: 3.2,
  entryDistanceScale: 1,
  duration: 620,
});

export function smoothStep(t) {
  t = MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function constrainCamera(position, target, bounds, obstacles, maxDistance) {
  const previousTarget = target.clone();
  target.x = MathUtils.clamp(target.x, bounds.min.x, bounds.max.x);
  target.z = MathUtils.clamp(target.z, bounds.min.z, bounds.max.z);
  target.y = MathUtils.clamp(target.y, 0, Math.max(0, bounds.max.y));
  position.add(target.clone().sub(previousTarget));
  const spherical = new Spherical().setFromVector3(position.clone().sub(target));
  spherical.phi = MathUtils.clamp(spherical.phi, CAMERA_LIMITS.minPolar, CAMERA_LIMITS.maxPolar);
  spherical.radius = MathUtils.clamp(spherical.radius, CAMERA_LIMITS.minDistance, maxDistance || bounds.getSize(new Vector3()).length() * CAMERA_LIMITS.maxExtentMultiplier);
  position.copy(target).add(new Vector3().setFromSpherical(spherical));

  // Every rendered pose, including pan/tween poses, keeps the eye above any
  // inflated solid beneath it. A conservative roof is preferable to entering
  // a hollow cabinet. No triangle raycasts are needed in the animation loop.
  // Only increase the orbit radius: no oscillation against OrbitControls'
  // polar clamp on the following frame. Each pass can encounter a higher roof.
  for (let pass = 0; pass <= obstacles.length; pass++) {
    let floor = 2.5;
    for (const box of obstacles) {
      const pad = CAMERA_LIMITS.clearance;
      if (position.x >= box.min.x - pad && position.x <= box.max.x + pad &&
          position.z >= box.min.z - pad && position.z <= box.max.z + pad) {
        floor = Math.max(floor, box.max.y + pad);
      }
    }
    if (position.y >= floor - 1e-8) break;
    spherical.radius = Math.max(spherical.radius, (floor - target.y) / Math.cos(spherical.phi));
    position.copy(target).add(new Vector3().setFromSpherical(spherical));
  }
  return { position, target };
}

export function focusCamera(box, camera, target, bounds, obstacles) {
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const azimuth = new Spherical().setFromVector3(camera.position.clone().sub(target)).theta;
  const direction = new Vector3().setFromSpherical(new Spherical(1, Math.PI / 4, azimuth));
  const verticalFov = MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const radius = size.length() / 2;
  // Portrait width is usually the limiting dimension. Reserve the bottom
  // portion for the compact Flutter sheet and a little room around the machine.
  const distance = Math.max(9, radius / Math.sin(Math.min(verticalFov * .64, horizontalFov) / 2) * 1.12);
  const position = center.clone().addScaledVector(direction, distance);
  constrainCamera(position, center, bounds, obstacles);
  return { position, target: center, offset: .18 };
}

export function overviewCamera(bounds, camera, obstacles) {
  const target = bounds.getCenter(new Vector3());
  target.y = 0;
  // Frame every real factory corner with breathing room. Mobile's 0.62 entry
  // crop is unsuitable for a web card narrowed by its apparatus sidebar.
  const azimuth = camera.aspect < 1 ? .12 : Math.PI / 4;
  const direction = new Vector3().setFromSpherical(new Spherical(1, Math.PI / 4, azimuth));
  const right = new Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  const up = direction.clone().cross(right);
  const tangentY = Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const tangentX = tangentY * camera.aspect;
  let distance = CAMERA_LIMITS.minDistance;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const relative = new Vector3(x, y, z).sub(target);
    const depth = relative.dot(direction);
    const vertical = relative.dot(up);
    distance = Math.max(distance, depth + Math.abs(relative.dot(right)) / (tangentX * .91),
      depth + Math.abs(vertical) / (tangentY * (vertical > 0 ? .76 : .84)));
  }
  const position = target.clone().addScaledVector(direction, distance * CAMERA_LIMITS.entryDistanceScale);
  const maxDistance = Math.max(bounds.getSize(new Vector3()).length() * CAMERA_LIMITS.maxExtentMultiplier, distance * 1.05);
  constrainCamera(position, target, bounds, obstacles, maxDistance);
  return { position, target, offset: 0, maxDistance };
}

export function visibleWorldBoxes(root) {
  const boxes = [];
  root.updateMatrixWorld(true);
  root.traverseVisible(object => {
    if (!object.isMesh || object.userData.factoryMapRenderProxy) return;
    if (object.isInstancedMesh) {
      object.geometry.computeBoundingBox();
      const matrix = new Matrix4();
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        if (Math.abs(matrix.determinant()) < 1e-12) continue;
        const box = object.geometry.boundingBox.clone().applyMatrix4(matrix).applyMatrix4(object.matrixWorld);
        if (box.max.y > .5) boxes.push(box);
      }
      return;
    }
    const box = new Box3().setFromObject(object);
    if (!box.isEmpty() && box.max.y > .5) boxes.push(box);
  });
  return boxes;
}
