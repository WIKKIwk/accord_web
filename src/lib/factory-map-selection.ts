import { canonicalFactoryMapObjectId } from './factory-map'
import type { FactoryRouteStage } from './factory-stage-navigation'

export type FactoryMapSelectionSource = 'overview' | 'apparatus' | 'stage'

/** Browsing a physical apparatus does not require membership in an order route. */
export function factoryMapIsolatedObjectId(source: FactoryMapSelectionSource, selectedObjectId: string, viewedStage?: Pick<FactoryRouteStage, 'objectId'>): string {
  const objectId = canonicalFactoryMapObjectId(selectedObjectId)
  if (source === 'apparatus') return objectId
  if (source === 'stage' && viewedStage?.objectId && objectId === viewedStage.objectId) return objectId
  return ''
}
