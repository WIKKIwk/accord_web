/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { factoryModelObjects, factoryModelSourceSha256 } from '../lib/factory-map-model'
// @ts-expect-error The unchanged Three.js loader is vendored as a browser module.
import { GLTFLoader } from '../../public/factory-map/GLTFLoader.js'
// @ts-expect-error The mobile performance module is shared as browser JavaScript.
import { loadMapBytes } from '../../public/factory-map/factory-map-performance.js'
// @ts-expect-error The native scene policy preserves persisted mobile identities.
import { apparatusObjectId } from '../../public/factory-map/factory-map-scene-policy.js'
// @ts-expect-error The web framing uses the same vendored Three.js math.
import { Box3, PerspectiveCamera, Vector3 } from '../../public/factory-map/three.module.js'
// @ts-expect-error The native camera helper is adapted for complete web overviews.
import { overviewCamera } from '../../public/factory-map/factory-map-navigation.js'

interface SceneObject {
  name: string
  isLineSegments?: boolean
  isMesh?: boolean
  userData: { factory_map_object_id?: string; factory_map_aliases?: string[]; factory_map_style?: string }
  material?: { isMeshBasicMaterial?: boolean }
  traverse: (visitor: (object: SceneObject) => void) => void
}

const model = readFileSync(new URL('../../public/factory-map/zavod6-cad-line-art.glb', import.meta.url))

describe('factory CAD model and native renderer', () => {
  it('pairs placement aliases with the exact shipped CAD source', () => {
    expect(createHash('sha256').update(model).digest('hex')).toBe(factoryModelSourceSha256)
    const document = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString('utf8'))
    const tagged = document.nodes.filter((node: { extras?: { factory_map_object_id?: string } }) => node.extras?.factory_map_object_id)
    expect(tagged.length).toBe(factoryModelObjects.length)
    for (const object of factoryModelObjects) {
      const source = tagged.find((node: { extras: { factory_map_object_id: string } }) => node.extras.factory_map_object_id === object.objectId)
      expect(source.extras.factory_map_aliases).toEqual(object.aliases)
    }
  })
  it('ships the actual source GLB and a lossless transfer copy', () => {
    const packed = readFileSync(new URL('../../public/factory-map/zavod6-cad-line-art.glb.gz', import.meta.url))
    expect(model.readUInt32LE(0)).toBe(0x46546c67)
    expect(model.readUInt32LE(8)).toBe(model.byteLength)
    expect(gunzipSync(packed).equals(model)).toBe(true)
  })

  it('loads CAD contours and resolves complete machine parts through mobile IDs', async () => {
    const bytes = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
    const scene = await new Promise<SceneObject>((resolve, reject) => {
      new GLTFLoader().parse(bytes, '', (gltf: { scene: SceneObject }) => resolve(gltf.scene), reject)
    })
    expect(scene.userData.factory_map_style).toBe('cad-line-art')
    const identities = new Set<string>()
    let contours = 0
    let selectedParts = 0
    let unlitSurfaces = 0
    scene.traverse(object => {
      if (object.userData.factory_map_object_id) identities.add(object.userData.factory_map_object_id)
      if (object.isLineSegments) contours++
      if (object.isMesh && apparatusObjectId(object)) selectedParts++
      if (object.isMesh && object.material?.isMeshBasicMaterial) unlitSurfaces++
    })
    expect(identities.size).toBe(13)
    expect(identities.has('node:7')).toBe(true)
    expect(identities.has('node:20')).toBe(true)
    expect(identities.has('equipment:rezka:5')).toBe(true)
    expect(contours).toBeGreaterThan(0)
    expect(selectedParts).toBeGreaterThan(150)
    expect(unlitSurfaces).toBeGreaterThan(150)
  })

  it('streams progress and retains decoded source bytes for route re-entry', async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])
    let requests = 0
    const fetcher = async () => {
      requests++
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 4))
        controller.enqueue(bytes.slice(4))
        controller.close()
      } }), { headers: { 'content-length': '8' } })
    }
    const progress: number[] = []
    const signal = new AbortController().signal
    const first = await loadMapBytes('fixture-cad-model', signal, fetcher, '', (loaded: number, total: number) => {
      expect(total).toBe(8)
      progress.push(loaded)
    })
    const second = await loadMapBytes('fixture-cad-model', signal, fetcher)
    expect(new Uint8Array(first)).toEqual(bytes)
    expect(second).toBe(first)
    expect(requests).toBe(1)
    expect(progress).toEqual([4, 8, 8])
  })

  it('fits every factory bound corner in wide, square and narrow overview viewports', async () => {
    const bytes = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
    const scene = await new Promise<SceneObject>((resolve, reject) => {
      new GLTFLoader().parse(bytes, '', (gltf: { scene: SceneObject }) => resolve(gltf.scene), reject)
    })
    const bounds = new Box3().setFromObject(scene)
    for (const aspect of [0.25, 0.5, 1, 1.5, 2.4]) {
      const camera = new PerspectiveCamera(35, aspect, 0.1, 400)
      const view = overviewCamera(bounds, camera, [])
      camera.position.copy(view.position)
      camera.lookAt(view.target)
      camera.updateMatrixWorld()
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new Vector3(x, y, z).project(camera)
        expect(Math.abs(corner.x), `horizontal framing at aspect ${aspect}`).toBeLessThan(0.96)
        expect(Math.abs(corner.y), `vertical framing at aspect ${aspect}`).toBeLessThan(0.96)
        expect(Math.abs(corner.z), `depth framing at aspect ${aspect}`).toBeLessThan(1)
      }
      expect(view.position.distanceTo(view.target)).toBeLessThanOrEqual(view.maxDistance)
    }
  })
})
