/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { factoryModelSourceSha256 } from './factory-map-model'
// @ts-expect-error Test the same vendored browser material implementation.
import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Texture } from '../../public/factory-map/three.module.js'
// @ts-expect-error Test the renderer's actual public theme helper.
import { createFactoryCadTheme, FACTORY_CAD_THEME } from '../../public/factory-map/factory-map-cad-theme.js'
// @ts-expect-error Load the actual unchanged CAD model with its browser loader.
import { GLTFLoader } from '../../public/factory-map/GLTFLoader.js'
// @ts-expect-error Exercise lazy native contour registration in dark mode.
import { createFactoryCadCompanions } from '../../public/factory-map/factory-map-cad-companions.js'
// @ts-expect-error Isolation reuses the original scene and its CAD contours.
import { createFactoryStageView } from '../../public/factory-map/factory-map-stage-view.js'

interface CadMaterial {
  color: { getHex: () => number; toArray: () => number[] }
  opacity: number; transparent: boolean; side: number; depthTest: boolean; depthWrite: boolean
  toJSON: () => unknown; dispose: () => void
}
interface CadObject {
  material?: CadMaterial | CadMaterial[]
  geometry?: { attributes: Record<string, unknown>; index: { count: number; array: Uint16Array | Uint32Array } }
  visible: boolean; isMesh?: boolean; isLineSegments?: boolean
  userData: { factory_map_object_id?: string }
  traverse: (visit: (object: CadObject) => void) => void
}
const materials = (object: CadObject): CadMaterial[] => object.material ? Array.isArray(object.material) ? object.material : [object.material] : []
async function actualModel(): Promise<CadObject> {
  const model = readFileSync(new URL('../../public/factory-map/zavod6-cad-line-art.glb', import.meta.url))
  expect(createHash('sha256').update(model).digest('hex')).toBe(factoryModelSourceSha256)
  return new Promise((resolve, reject) => new GLTFLoader().parse(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '', (gltf: { scene: CadObject }) => resolve(gltf.scene), reject))
}

describe('renderer-owned CAD theme variants', () => {
  it('restores exact light refs and properties, keeps shared renderers separate, and disposes only its own clones', () => {
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    const texture = new Texture()
    const pale = new MeshBasicMaterial({ color: 0xf8f8f8, map: texture, opacity: .26, transparent: true, side: 2, depthWrite: false })
    const gray = new MeshBasicMaterial({ color: 0xaaaaaa })
    const black = new LineBasicMaterial({ color: 0x020202, linewidth: 2 })
    const originalArray = [pale, gray], originalProperties = [pale, gray, black].map(material => JSON.stringify(material.toJSON()))
    const root = new Group(), otherRoot = new Group()
    const surface = new Mesh(geometry, originalArray), line = new LineSegments(geometry, black)
    const otherSurface = new Mesh(geometry, pale), otherLine = new LineSegments(geometry, black)
    root.add(surface, line); otherRoot.add(otherSurface, otherLine)
    const originalDisposal = [pale, gray, black, texture, geometry].map(value => vi.spyOn(value, 'dispose'))
    const theme = createFactoryCadTheme(root), otherTheme = createFactoryCadTheme(otherRoot)
    expect(surface.material).toBe(originalArray); expect(line.material).toBe(black)
    theme.setTheme('dark')
    const darkArray = surface.material, darkLine = line.material
    expect(otherSurface.material).toBe(pale); expect(otherLine.material).toBe(black)
    expect(darkArray[0]).not.toBe(pale); expect(darkArray[0].map).toBeNull()
    expect(darkArray[0].opacity).toBe(pale.opacity); expect(darkArray[0].transparent).toBe(true)
    expect(darkArray[0].side).toBe(pale.side); expect(darkArray[0].depthWrite).toBe(false)
    expect(darkLine.color.getHex()).toBe(FACTORY_CAD_THEME.dark.contour); expect(darkLine.linewidth).toBe(2)
    otherTheme.setTheme('dark')
    expect(otherSurface.material).not.toBe(darkArray[0]); expect(otherLine.material).not.toBe(darkLine)
    const ownDisposal = [...darkArray, darkLine].map(material => vi.spyOn(material, 'dispose'))
    const otherDisposal = vi.spyOn(otherSurface.material, 'dispose')
    for (let i = 0; i < 3; i++) {
      theme.setTheme('light')
      expect(surface.material).toBe(originalArray); expect(line.material).toBe(black)
      expect([pale, gray, black].map(material => JSON.stringify(material.toJSON()))).toEqual(originalProperties)
      theme.setTheme('dark')
      expect(surface.material[0]).toBe(darkArray[0]); expect(surface.material[1]).toBe(darkArray[1]); expect(line.material).toBe(darkLine)
    }
    theme.dispose(); theme.dispose()
    expect(surface.material).toBe(originalArray); expect(line.material).toBe(black)
    for (const disposed of ownDisposal) expect(disposed).toHaveBeenCalledTimes(1)
    for (const disposed of originalDisposal) expect(disposed).not.toHaveBeenCalled()
    expect(otherDisposal).not.toHaveBeenCalled()
    expect(theme.setTheme('dark')).toBe(false)
    otherTheme.dispose()
    for (const disposed of originalDisposal) expect(disposed).not.toHaveBeenCalled()
  })

  it('keeps the real model detail, geometry, topology and source materials while adapting all thirteen lazy isolated views', async () => {
    const root = await actualModel(), targets = new Map<string, CadObject>(), objects: CadObject[] = []
    let source: CadObject | undefined
    root.traverse(object => {
      objects.push(object)
      if (object.userData.factory_map_object_id) targets.set(object.userData.factory_map_object_id, object)
      if (object.isLineSegments) source = object
    })
    expect(targets.size).toBe(13)
    const originalRefs = objects.map(object => object.material), originalVisibility = objects.map(object => object.visible)
    const originalMaterials = [...new Set(objects.flatMap(materials))], properties = originalMaterials.map(material => JSON.stringify(material.toJSON()))
    const geometryRefs = objects.map(object => object.geometry), contourIndex = source!.geometry!.index
    const contourBytes = createHash('sha256').update(contourIndex.array).digest('hex')
    const theme = createFactoryCadTheme(root)
    theme.setTheme('dark')
    const surfaceColors = new Set<number>()
    root.traverse(object => {
      if (object.isMesh) for (const material of materials(object)) {
        const hex = material.color.getHex(), red = hex >> 16 & 255, green = hex >> 8 & 255, blue = hex & 255
        expect(red).toBe(green); expect(green).toBe(blue)
        expect(red).toBeGreaterThanOrEqual(FACTORY_CAD_THEME.dark.surfaceMin)
        expect(red).toBeLessThanOrEqual(FACTORY_CAD_THEME.dark.surfaceMax)
        surfaceColors.add(hex)
      }
    })
    expect(surfaceColors.size).toBeGreaterThanOrEqual(10)
    expect((source!.material as CadMaterial).color.getHex()).toBe(FACTORY_CAD_THEME.dark.contour)
    const factory = createFactoryCadCompanions(root, theme.register)
    const view = createFactoryStageView(root, (id: string) => ({ object: targets.get(id), companions: factory.get(id, targets.get(id)) }))
    for (const [id, target] of targets) {
      view.setObject(id)
      const [companion] = factory.get(id, target) as CadObject[]
      expect(companion.visible, id).toBe(true)
      expect(companion.material, id).toBe(source!.material)
      expect((companion.material as CadMaterial).color.getHex(), id).toBe(FACTORY_CAD_THEME.dark.contour)
      expect(companion.geometry!.attributes.position, id).toBe(source!.geometry!.attributes.position)
      expect(companion.geometry!.index.count, id).toBeGreaterThan(10000)
      const currentVisibility = objects.map(object => object.visible)
      for (let i = 0; i < 3; i++) {
        theme.setTheme('light')
        expect(companion.material, id).toBe(originalRefs[objects.indexOf(source!)])
        expect(objects.map(object => object.material)).toEqual(originalRefs)
        theme.setTheme('dark')
        expect(companion.material, id).toBe(source!.material)
        expect(view.isolatedObjectId, id).toBe(id)
        expect(objects.map(object => object.visible), id).toEqual(currentVisibility)
      }
    }
    view.restore(); theme.dispose()
    expect(objects.map(object => object.material)).toEqual(originalRefs)
    expect(objects.map(object => object.visible)).toEqual(originalVisibility)
    expect(objects.map(object => object.geometry)).toEqual(geometryRefs)
    expect(originalMaterials.map(material => JSON.stringify(material.toJSON()))).toEqual(properties)
    expect(source!.geometry!.index).toBe(contourIndex)
    expect(createHash('sha256').update(contourIndex.array).digest('hex')).toBe(contourBytes)
    for (const [, target] of targets) expect((factory.get('cached', target) as CadObject[]).every(object => !object.visible)).toBe(true)
  }, 25000)
})
