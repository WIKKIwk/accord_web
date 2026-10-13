import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FactoryStageStrip } from './factory-stage-strip'
import type { FactoryRouteStage, FactoryStageRoute } from '@/lib/factory-stage-navigation'

const first: FactoryRouteStage = { key: 'node:cut', index: 0, nodeId: 'cut', nodeIds: ['cut'], title: 'Qayta kesish', operation: 'cut', apparatusId: 'apparatus:default:cut', apparatusName: 'Rezka 1', objectId: 'node:20', candidateApparatusIds: [], candidateNames: [], state: 'in_progress', statusLabel: 'Ishlamoqda', activeExecution: true, alternative: false, branch: false, issue: '' }
const second: FactoryRouteStage = { ...first, key: 'node:custom', index: 1, nodeId: 'custom', title: 'Maxsus bosqich', operation: 'glue', state: 'pending', statusLabel: 'Navbatda', activeExecution: false }
const route: FactoryStageRoute = { orderId: 'order:1', orderLabel: '№ Q-15', map: null, stages: [first, second], fresh: true, issue: '' }
function render(value = route, viewedKey = '', apparatusSelection?: { objectId: string; label: string }) { return renderToStaticMarkup(<FactoryStageStrip route={value} orderChoices={[{ id: value.orderId, label: value.orderLabel }]} viewedKey={viewedKey} apparatusSelection={apparatusSelection} onOrderChange={() => {}} onStageChange={() => {}} />) }
describe('factory stage strip', () => {
  it('renders actual route labels, overview, keyboard targets and accessible previous/next controls', () => {
    const html = render()
    expect(html).toContain('Qayta kesish'); expect(html).toContain('Maxsus bosqich')
    expect(html).toContain('data-stage-key="overview"'); expect(html).toContain('Oldingi bosqich'); expect(html).toContain('Keyingi bosqich')
    expect(html).toContain('aria-current="step"')
    expect(html).not.toContain('Laminatsiya'); expect(html).not.toContain('Qadoqlash')
  })
  it('separates the viewed future stage from the currently executing ERP stage', () => {
    const html = render(route, 'node:custom')
    expect(html).toContain('02 / 02'); expect(html).toContain('Ko‘rilayotgan bosqich: Maxsus bosqich')
    expect(html).toContain('ERPda bajarilayotgan bosqich: Qayta kesish')
    expect(html).toContain('Harakat ERP holatining sxematik ko‘rinishi')
  })
  it('labels stale state and unresolved alternatives without a confirmed execution marker', () => {
    const unresolved = { ...first, alternative: true, apparatusId: '', apparatusName: '', objectId: '', state: 'unknown' as const, activeExecution: false, statusLabel: 'Holat noma’lum', candidateNames: ['Rezka A', 'Rezka B'], issue: 'Muqobil apparat tanlanmagan.' }
    const html = render({ ...route, fresh: false, stages: [unresolved] }, unresolved.key)
    expect(html).toContain('bajarilayotgan bosqich noma’lum')
    expect(html).toContain('Muqobil apparat tanlanmagan')
    expect(html).not.toContain('ERPda bajarilayotgan bosqich:')
  })
  it('describes an apparatus outside the viewed order route without claiming factory overview', () => {
    const html = render(route, '', { objectId: 'node:6:instance:6', label: 'QA Laminator' })
    expect(html).toContain('Apparat ko‘rinishi'); expect(html).toContain('QA Laminator')
    expect(html).toContain('Tanlangan apparat alohida ko‘rsatilmoqda.')
    expect(html).toContain('data-factory-apparatus-view="node:6:instance:6"')
    expect(html).not.toContain('Zavodning to‘liq modeli.')
    expect(html).not.toContain('aria-current="step"')
    expect(html).toContain('ERPda bajarilayotgan bosqich: Qayta kesish')
  })
  it('retains actual stage captions and navigation when the direct apparatus matches the viewed stage', () => {
    const html = render(route, first.key, { objectId: first.objectId, label: first.apparatusName })
    expect(html).toContain('01 / 02'); expect(html).toContain('Ko‘rilayotgan bosqich: Qayta kesish')
    expect(html).toContain('aria-current="step"'); expect(html).not.toContain('Apparat ko‘rinishi')
    expect(html).not.toContain('data-factory-apparatus-view=')
  })
  it('does not label a different stage as viewed after a route edit during direct apparatus browsing', () => {
    const html = render(route, first.key, { objectId: 'node:1:instance:0', label: 'QA Flexo 1' })
    expect(html).toContain('Apparat ko‘rinishi'); expect(html).toContain('QA Flexo 1')
    expect(html).not.toContain('Ko‘rilayotgan bosqich: Qayta kesish')
    expect(html).not.toContain('aria-current="step"')
  })
  it('describes a directly selected apparatus without an order or route stages', () => {
    const html = render({ ...route, orderId: '', stages: [] }, '', { objectId: 'node:18:instance:2', label: 'Holodniy kley aparat' })
    expect(html).toContain('Apparat ko‘rinishi'); expect(html).toContain('Holodniy kley aparat')
    expect(html).toContain('Tanlangan apparat alohida ko‘rsatilmoqda.')
    expect(html).not.toContain('Umumiy ko‘rinish'); expect(html).not.toContain('aria-current="step"')
  })
})
