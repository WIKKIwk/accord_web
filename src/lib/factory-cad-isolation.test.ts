/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Vendored browser loader, paired with the supplied CAD source.
import { GLTFLoader } from '../../public/factory-map/GLTFLoader.js'
// @ts-expect-error Use the same geometry and projection implementation as the browser.
import { Box3, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from '../../public/factory-map/three.module.js'
// @ts-expect-error Browser companion module preserves native CAD segment buffers.
import { createFactoryCadCompanions } from '../../public/factory-map/factory-map-cad-companions.js'
// @ts-expect-error Browser visibility module shares the loaded scene.
import { createFactoryStageView } from '../../public/factory-map/factory-map-stage-view.js'
// @ts-expect-error Same browser camera functions; no replacement model or lighting.
import { constrainIsolatedCamera, isolatedCamera } from '../../public/factory-map/factory-map-navigation.js'

interface RenderObject {
  name: string; visible: boolean; parent: RenderObject | null
  isMesh?: boolean; isLineSegments?: boolean
  userData: Record<string, unknown>
  geometry: { attributes: Record<string, unknown>; index: { count: number; getX: (index: number) => number }; boundingBox: { min: { toArray: () => number[] }; max: { toArray: () => number[] } }; dispose: () => void }
  material: { color: { toArray: () => number[] }; opacity: number; dispose: () => void }
  traverse: (visit: (object: RenderObject) => void) => void
  traverseVisible: (visit: (object: RenderObject) => void) => void
  updateMatrixWorld: (force: boolean) => void
}
async function actualModel(): Promise<RenderObject> {
  const model = readFileSync(new URL('../../public/factory-map/zavod6-cad-line-art.glb', import.meta.url))
  return new Promise((resolve, reject) => new GLTFLoader().parse(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '', (gltf: { scene: RenderObject }) => resolve(gltf.scene), reject))
}

describe('exact native CAD companion partition', () => {
  it('matches only existing selected triangle-edge segments, including transformed parents', () => {
    const root = new Group(), target = new Group(), parent = new Group()
    root.add(target, parent); target.position.set(7, 0, -2); target.rotation.y = .4; target.scale.setScalar(2); parent.position.set(3, 2, 1)
    const surface = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)), new MeshBasicMaterial({ color: 0xeeeeee, opacity: .26, transparent: true }))
    target.add(surface); root.updateMatrixWorld(true)
    const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [.2, .2, 0], [.4, .4, 0]].flatMap(point => new Vector3(...point).applyMatrix4(surface.matrixWorld).sub(parent.position).toArray())
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points, 3)); geometry.setIndex([0, 1, 1, 2, 2, 0, 3, 4, 0, 3])
    const source = new LineSegments(geometry, new LineBasicMaterial({ color: 0x020202, linewidth: 2 })); source.renderOrder = 7; source.layers.set(3); parent.add(source); root.updateMatrixWorld(true)
    const factory = createFactoryCadCompanions(root), [companion] = factory.get('selected', target)
    expect(Array.from(companion.geometry.index.array)).toEqual([0, 1, 1, 2, 2, 0])
    expect(companion.geometry.attributes.position).toBe(geometry.attributes.position)
    expect(companion.material).toBe(source.material); expect(companion.matrix.elements).toEqual(source.matrix.elements); expect(companion.matrixWorld.elements).toEqual(source.matrixWorld.elements)
    expect(companion.layers.mask).toBe(source.layers.mask); expect(companion.renderOrder).toBe(7); expect(companion.material.linewidth).toBe(2)
    expect(factory.get('selected', target)[0]).toBe(companion)
  })

  it('retains original contours for all thirteen real shapes, restores visibility, and never disposes shared resources on stage switches', async () => {
    const root = await actualModel(), targets = new Map<string, RenderObject>(), originals: RenderObject[] = []
    let source: RenderObject | undefined
    root.traverse(object => { originals.push(object); if (object.userData.factory_map_object_id) targets.set(String(object.userData.factory_map_object_id), object); if (object.isLineSegments) source = object })
    expect(source?.name).toBe('CAD_sharp_edges_and_boundaries')
    const sourceLine = source!, initialVisibility = originals.map(object => object.visible), colors = originals.filter(object => object.material?.color).map(object => [object.material, object.material.color.toArray(), object.material.opacity])
    const originalIndex = sourceLine.geometry.index, disposedGeometry = vi.spyOn(sourceLine.geometry, 'dispose'), disposedMaterial = vi.spyOn(sourceLine.material, 'dispose')
    const companions = createFactoryCadCompanions(root), view = createFactoryStageView(root, (id: string) => ({ object: targets.get(id), companions: companions.get(id, targets.get(id)) }))
    const subsetIndices = new Set<number>()
    for (let i = 0; i < originalIndex.count; i += 2) subsetIndices.add(originalIndex.getX(i) * 1000000 + originalIndex.getX(i + 1))
    for (const [id, target] of targets) {
      view.setObject(id)
      const parts = companions.get(id, target) as RenderObject[]
      expect(parts.length, id).toBe(1)
      const part = parts[0]
      expect(part.geometry.index.count, id).toBeGreaterThan(10000); expect(part.geometry.index.count).toBeLessThan(originalIndex.count)
      expect(part.material).toBe(sourceLine.material); expect(part.geometry.attributes.position).toBe(sourceLine.geometry.attributes.position)
      const machine = new Box3().setFromObject(target), lines = new Box3().setFromObject(part)
      expect(lines.getSize(new Vector3()).length(), id).toBeLessThan(machine.getSize(new Vector3()).length() + .001)
      expect(lines.getSize(new Vector3()).length(), id).toBeGreaterThan(machine.getSize(new Vector3()).length() * .98)
      expect(sourceLine.visible).toBe(false); expect(part.visible).toBe(true)
      for (let at = 0; at < part.geometry.index.count; at += 2) expect(subsetIndices.has(part.geometry.index.getX(at) * 1000000 + part.geometry.index.getX(at + 1)), id).toBe(true)
      const visible: RenderObject[] = []; root.traverseVisible(object => { if (object.isMesh || object.isLineSegments) visible.push(object) })
      expect(visible.every(object => object === part || (() => { for (let ancestor: RenderObject | null = object; ancestor; ancestor = ancestor.parent) if (ancestor === target) return true; return false })()), id).toBe(true)
    }
    for (const id of [targets.keys().next().value, 'node:20', 'node:7', 'node:20']) view.setObject(id)
    view.restore()
    expect(originals.map(object => object.visible)).toEqual(initialVisibility)
    for (const [, target] of targets) expect((companions.get('cached', target) as RenderObject[]).every(object => !object.visible)).toBe(true)
    for (const [material, color, opacity] of colors) { const typed = material as RenderObject['material']; expect(typed.color.toArray()).toEqual(color); expect(typed.opacity).toBe(opacity) }
    expect(disposedGeometry).not.toHaveBeenCalled(); expect(disposedMaterial).not.toHaveBeenCalled()
  }, 20000)
})

describe('selected apparatus framing and clipping', () => {
  it('uses the full resized viewport for long presses, compact slitters and the extruder without a factory floor or mobile-sheet crop', async () => {
    const root = await actualModel(), targets: RenderObject[] = []; root.traverse(object => { if (object.userData.factory_map_object_id) targets.push(object) })
    for (const target of targets) for (const aspect of [.25, .5, 1, 1.8, 2.4]) {
      const box = new Box3().setFromObject(target), center = box.getCenter(new Vector3()), camera = new PerspectiveCamera(35, aspect, .1, 400)
      camera.position.copy(center).add(new Vector3(20, 20, 20))
      const view = isolatedCamera(box, camera, center)
      camera.position.copy(view.position); camera.near = view.near; camera.far = view.far; camera.lookAt(view.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld()
      let occupancy = 0
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const corner = new Vector3(x, y, z).project(camera); occupancy = Math.max(occupancy, Math.abs(corner.x), Math.abs(corner.y))
        expect(Math.abs(corner.x), `x ${target.name} ${aspect}`).toBeLessThan(.9); expect(Math.abs(corner.y), `y ${target.name} ${aspect}`).toBeLessThan(.9); expect(Math.abs(corner.z)).toBeLessThan(1)
      }
      expect(occupancy, `readable ${target.name} ${aspect}`).toBeGreaterThan(.8)
      expect(view.offset).toBe(0); expect(view.minDistance).toBeLessThan(view.position.distanceTo(view.target)); expect(view.far).toBeGreaterThan(view.maxDistance)
    }
  })
  it('keeps the CAD in front of the near plane while orbiting close to a panned apparatus corner', () => {
    const box = new Box3(new Vector3(-1, -.5, -2), new Vector3(1, 2, 2)), radius = box.getSize(new Vector3()).length() / 2
    for (const theta of [0, Math.PI / 4, Math.PI / 2, Math.PI]) for (const target of [box.min.clone(), box.max.clone(), box.getCenter(new Vector3())]) {
      const position = target.clone().add(new Vector3(Math.sin(theta), .5, Math.cos(theta)).normalize().multiplyScalar(.01))
      constrainIsolatedCamera(position, target, box, radius * 6, radius * 1.12)
      const direction = position.clone().sub(target).normalize()
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) expect(position.clone().sub(new Vector3(x, y, z)).dot(direction)).toBeGreaterThan(radius * .015)
    }
  })
})
