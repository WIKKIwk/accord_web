import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ClipboardPlus, Loader2, RefreshCw, Save, Trash2, Waypoints } from 'lucide-react'
import type { Row } from '@/lib/api-types'
import { newOrderDraft } from '@/lib/order-draft'
import type { OrderDraft } from '@/lib/order-draft'
import { useProductionWorkflow } from '@/lib/production-workflow'
import type { ProductionWorkflowValue } from '@/lib/production-workflow'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { CalculatorManagementApi, CalculatorSaveUnknown, CalculatorSourceConflict, calculatorCanManage, calculatorManagementError, calculatorMemory, calculatorMemoryKey, calculatorRouteCompatible } from '@/lib/calculator-management'
import type { CalculatorMode, CalculatorSource, CalculatorSaveResult, CalculatorRetainedState } from '@/lib/calculator-management'
import type { CalculateOrderTemplate } from '@/lib/api-types'
import { ApiError, text } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type DraftState = Pick<ProductionWorkflowValue, 'draft' | 'setDraft' | 'selectedMaterials' | 'setSelectedMaterials' | 'calculated' | 'setCalculated' | 'map' | 'setMap' | 'mapSignature' | 'setMapSignature' | 'localImage' | 'setLocalImage' | 'uncertain' | 'setUncertain' | 'reset'>
function useRetainedCalculator(mode: CalculatorMode) {
  const { scope } = useSession(), key = calculatorMemoryKey(mode)
  useState(() => calculatorMemory.activate(scope))
  const subscribe = useCallback((listener: () => void) => calculatorMemory.subscribe(scope, key, listener), [scope, key])
  const getSnapshot = useCallback(() => calculatorMemory.read(scope, key)!, [scope, key])
  const retained = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { scope, key, retained }
}
/** Existing/template/pending forms do not overwrite the unfinished new order. */
export function useCalculatorDraftState(mode: CalculatorMode): DraftState & { retainedDraft: boolean } {
  const shared = useProductionWorkflow()
  const { scope, key, retained } = useRetainedCalculator(mode)
  const setters = useMemo(() => {
    function setter<K extends 'draft' | 'selectedMaterials' | 'calculated' | 'map' | 'mapSignature' | 'localImage' | 'uncertain'>(field: K): Dispatch<SetStateAction<NonNullable<typeof retained>[K]>> {
      return value => { const current = calculatorMemory.read(scope, key); if (current) calculatorMemory.patch(scope, key, { [field]: typeof value === 'function' ? (value as (before: CalculatorRetainedState[K]) => CalculatorRetainedState[K])(current[field]) : value }) }
    }
    const updateDraft: Dispatch<SetStateAction<OrderDraft>> = value => { const current = calculatorMemory.read(scope, key); if (current) calculatorMemory.patch(scope, key, { draft: typeof value === 'function' ? value(current.draft ?? newOrderDraft()) : value }) }
    return { setDraft: updateDraft, setSelectedMaterials: setter('selectedMaterials'), setCalculated: setter('calculated'), setMap: setter('map'), setMapSignature: setter('mapSignature'), setLocalImage: setter('localImage'), setUncertain: setter('uncertain'), reset: () => calculatorMemory.resetDraft(scope, key) }
  }, [scope, key])
  return mode.kind !== 'new' ? { draft: retained.draft ?? newOrderDraft(), selectedMaterials: retained.selectedMaterials, calculated: retained.calculated, map: retained.map, mapSignature: retained.mapSignature, localImage: retained.localImage, uncertain: retained.uncertain, ...setters, retainedDraft: !!retained.draft } : { ...shared, retainedDraft: false }
}
export function useCalculatorManagement(mode: CalculatorMode) {
  const { client, session, demo, scope } = useSession()
  const { key: memoryKey, retained } = useRetainedCalculator(mode)
  const queryClient = useQueryClient()
  const api = useMemo(() => client && session && !demo ? new CalculatorManagementApi(client, session, operation => calculatorMemory.markSent(scope, memoryKey, operation)) : null, [client, session, demo, scope, memoryKey])
  const key = `${scope}:${mode.kind}:${mode.kind === 'new' ? '' : mode.id}`
  const source = retained.source, error = retained.error
  const setSource = useCallback((source: CalculatorSource) => calculatorMemory.patch(scope, memoryKey, { source }), [scope, memoryKey])
  const setError = useCallback((error: unknown) => calculatorMemory.patch(scope, memoryKey, { error }), [scope, memoryKey])
  const [pending, setPending] = useState(false)
  const [mutations] = useState(() => new MutationScope()), currentKey = useRef(key), busy = useRef(false)
  currentKey.current = key
  useEffect(() => () => mutations.cancelAll(), [key, mutations])
  const load = useQuery({ queryKey: ['calculator-source', scope, mode], queryFn: ({ signal }) => api!.load(mode as Exclude<CalculatorMode, { kind: 'new' }>, signal), enabled: mode.kind !== 'new' && !!api && calculatorCanManage(session), retry: false, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => { if (!source && !load.isFetching && !load.error && load.data) setSource(load.data) }, [source, load.isFetching, load.error, load.data])
  async function run(execute: (api: CalculatorManagementApi, signal: AbortSignal) => Promise<CalculatorSaveResult>, success: (result: CalculatorSaveResult) => void) {
    if (busy.current || !api) return
    busy.current = true; setPending(true); setError(null)
    const captured = currentKey.current, lease = mutations.begin()
    try {
      const result = await execute(api, lease.controller.signal)
      if (captured !== currentKey.current || !mutations.isCurrent(lease)) return
      calculatorMemory.patch(scope, memoryKey, { operation: null, error: null })
      if (mode.kind !== 'new') { calculatorMemory.resetDraft(scope, memoryKey); calculatorMemory.patch(scope, memoryKey, { source: null }) }
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
      success(result)
    } catch (error) { if (captured === currentKey.current && mutations.isCurrent(lease)) { if (!(error instanceof CalculatorSaveUnknown)) calculatorMemory.patch(scope, memoryKey, { operation: null }); setError(error) } }
    finally { mutations.finish(lease); if (captured === currentKey.current && !lease.controller.signal.aborted) { busy.current = false; setPending(false) } }
  }
  async function reload() {
    if (busy.current || !api) return
    if (retained.operation) return
    if (mode.kind === 'new') { void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) }); return }
    if (error instanceof CalculatorSaveUnknown && ['template-open', 'automatic-open'].includes(error.operation.kind)) return
    busy.current = true; setPending(true)
    const captured = currentKey.current, lease = mutations.begin()
    try {
      const source = await api.load(mode, lease.controller.signal)
      if (captured === currentKey.current && mutations.isCurrent(lease)) { calculatorMemory.resetDraft(scope, memoryKey); setSource(source); setError(null) }
    } catch (error) { if (captured === currentKey.current && mutations.isCurrent(lease)) setError(error) }
    finally { mutations.finish(lease); if (captured === currentKey.current && !lease.controller.signal.aborted) { busy.current = false; setPending(false) } }
  }
  const clearAutomatic = () => { if (calculatorMemory.read(scope, memoryKey)?.operation?.kind === 'automatic-open') calculatorMemory.patch(scope, memoryKey, { operation: null, error: null }) }
  return { api, source, pending, error, setError, run, reload, clearAutomatic, loadError: source ? null : load.error, loading: mode.kind !== 'new' && !source && !load.error && !demo, demo, allowed: calculatorCanManage(session) }
}
export type CalculatorManagement = ReturnType<typeof useCalculatorManagement>
export function CalculatorManagementNotice({ management, onSaved }: { management: CalculatorManagement; onSaved: (result: CalculatorSaveResult) => void }) {
  const error = management.error
  if (!error) return null
  const unknown = error instanceof CalculatorSaveUnknown
  return <Alert variant="destructive"><AlertDescription className="space-y-3"><p>{calculatorManagementError(error)}</p><div className="flex flex-wrap gap-2">{unknown && !['template-open', 'automatic-open'].includes(error.operation.kind) && <Button type="button" variant="outline" size="sm" disabled={management.pending} onClick={() => void management.run((api, signal) => api.recover(error.operation, signal), onSaved)}><RefreshCw />Saqlangan holatni tekshirish</Button>}{error instanceof CalculatorSourceConflict || error instanceof ApiError && error.status === 409 ? <Button type="button" variant="outline" size="sm" disabled={management.pending} onClick={() => void management.reload()}>Joriy nusxani yuklash</Button> : null}{unknown && <Button type="button" variant="outline" size="sm" asChild><Link to={error.operation.kind === 'template-save' || error.operation.kind === 'template-delete' ? '/app/templates' : '/app/orders'}>Ro‘yxatni tekshirish</Link></Button>}</div></AlertDescription></Alert>
}
export function CalculatorManagementActions({ mode, management, result, productName, prepareTemplate, busy, onSaved }: {
  mode: CalculatorMode; management: CalculatorManagement; result: Row | null; productName: string;
  prepareTemplate: (reusable: boolean, name?: string) => CalculateOrderTemplate; busy: boolean; onSaved: (result: CalculatorSaveResult) => void;
}) {
  const { scope, key: memoryKey, retained } = useRetainedCalculator(mode)
  const [dialog, setDialog] = useState<'template' | 'delete' | 'order' | 'route' | null>(retained.purpose?.dialog ?? null)
  const name = retained.purpose?.name ?? '', routeId = retained.purpose?.routeId ?? ''
  function openDialog(dialog: NonNullable<typeof retained.purpose>['dialog'], defaultName = '', defaultRouteId = '') {
    const previous = calculatorMemory.read(scope, memoryKey)?.purpose
    calculatorMemory.patch(scope, memoryKey, { purpose: previous?.dialog === dialog ? previous : { dialog, name: defaultName, routeId: defaultRouteId } }); setDialog(dialog)
  }
  const setName = (name: string) => { if (retained.purpose) calculatorMemory.patch(scope, memoryKey, { purpose: { ...retained.purpose, name } }) }
  const setRouteId = (routeId: string) => { if (retained.purpose) calculatorMemory.patch(scope, memoryKey, { purpose: { ...retained.purpose, routeId } }) }
  const source = management.source
  const templates = useQuery({ queryKey: ['calculator-route-templates', scope], queryFn: ({ signal }) => management.api!.templates(signal), enabled: dialog === 'route' && !!management.api, retry: false })
  let currentTemplate: CalculateOrderTemplate | null = null
  try { if (result) currentTemplate = prepareTemplate(false) } catch { /* Validation is shown when the user submits. */ }
  const choices = (templates.data ?? []).filter(template => text(template.source_map_id, '').trim() && currentTemplate && calculatorRouteCompatible(template, currentTemplate))
  const blocked = busy || management.demo || !management.allowed || management.error instanceof CalculatorSaveUnknown || management.error instanceof CalculatorSourceConflict || management.error instanceof ApiError && management.error.status === 409
  const completed = source?.kind === 'pending' && !!source.pending.completion
  function finish(result: CalculatorSaveResult) { calculatorMemory.patch(scope, memoryKey, { purpose: null }); setDialog(null); onSaved(result) }
  function submit() {
    if (blocked) return
    try {
      if (dialog === 'template') {
        const template = prepareTemplate(true, name)
        void management.run((api, signal) => api.saveTemplate(template, mode.kind === 'template' && mode.edit && source?.kind === 'template' ? source.template : null, signal), finish)
      } else if (dialog === 'delete' && source?.kind === 'template') void management.run((api, signal) => api.deleteTemplate(source.template, true, signal), finish)
      else if (dialog === 'order' && source?.kind === 'order' && result) {
        const template = prepareTemplate(false)
        void management.run((api, signal) => api.saveOrder(source.order, template, signal), finish)
      } else if (dialog === 'route' && result && source) {
        const route = choices.find(template => template.id === routeId)
        if (!route) { management.setError(new Error('Mos xarita shablonini tanlang.')); return }
        const template = prepareTemplate(false)
        void management.run((api, signal) => api.openWithRoute(route, template, result, source.kind === 'pending' ? source.pending : undefined, signal), finish)
      }
    } catch (error) { management.setError(error) }
  }
  if (completed) return <Button type="button" variant="outline" className="w-full" asChild><Link to={`/app/orders?selected=${encodeURIComponent(source.pending.id)}`}>Ochilgan buyurtmani ko‘rish</Link></Button>
  return <div className="space-y-2">
    {mode.kind === 'order' ? <Button type="button" className="w-full" disabled={blocked || !result} onClick={() => openDialog('order')}><Save />Buyurtma tahririni saqlash</Button> : mode.kind === 'pending' ? <Button type="button" className="w-full" disabled={blocked || !result} onClick={() => openDialog('route')}><ClipboardPlus />Ishlab chiqarishga chiqarish</Button> : <>
      <Button type="button" variant="outline" className="w-full" disabled={blocked} onClick={() => openDialog('template', mode.kind === 'template' && mode.edit ? text(source?.template.name, productName) : productName)}><Save />{mode.kind === 'template' && mode.edit ? 'Shablonni yangilash' : 'Shablon sifatida saqlash'}</Button>
      {mode.kind === 'template' && !mode.edit && text(source?.template.source_map_id, '').trim() && <Button type="button" variant="outline" className="w-full" disabled={blocked || !result} onClick={() => openDialog('route', '', text(source?.template.id, ''))}><Waypoints />Shablon xaritasidan buyurtma ochish</Button>}
      {mode.kind === 'template' && mode.edit && <Button type="button" variant="outline" className="w-full text-destructive" disabled={blocked} onClick={() => openDialog('delete')}><Trash2 />Shablonni o‘chirish</Button>}
    </>}
    <Dialog open={!!dialog} onOpenChange={open => { if (!open) setDialog(null) }}><DialogContent><DialogHeader><DialogTitle>{dialog === 'template' ? 'Buyurtma shablonini saqlash' : dialog === 'delete' ? 'Shablonni o‘chirish' : dialog === 'order' ? 'Buyurtma tahririni saqlash' : mode.kind === 'pending' ? 'Kutilayotgan buyurtmani chiqarish' : 'Shablondan yangi buyurtma ochish'}</DialogTitle><DialogDescription>{dialog === 'delete' ? `${text(source?.template.name, '')} shablonini o‘chirishni tasdiqlang.` : dialog === 'order' ? `№${text(source?.template.order_number, '')} buyurtmaning hisob parametrlari saqlanadi.` : dialog === 'route' && mode.kind === 'pending' ? `№${text(source?.template.order_number, '')} raqami saqlanadi. Mos xarita shablonini tanlang.` : dialog === 'route' ? 'Yangi buyurtma raqamini ERP serveri beradi.' : 'Shablon keyingi buyurtmalar uchun hisob parametrlarini saqlaydi.'}</DialogDescription></DialogHeader>
      {dialog === 'template' && <div className="space-y-2"><Label htmlFor="calculator-template-name">Shablon nomi</Label><Input id="calculator-template-name" value={name} onChange={event => setName(event.target.value)} disabled={management.pending} autoComplete="off" /></div>}
      {dialog === 'route' && <div className="space-y-3">{templates.isPending ? <p role="status" className="flex gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Xarita shablonlari yuklanmoqda…</p> : templates.error ? <Alert variant="destructive"><AlertDescription>{calculatorManagementError(templates.error)}</AlertDescription></Alert> : <><Label htmlFor="calculator-route">Xarita shabloni</Label><Select value={routeId} onValueChange={setRouteId} disabled={management.pending || !choices.length}><SelectTrigger id="calculator-route" className="w-full"><SelectValue placeholder="Mos shablonni tanlang" /></SelectTrigger><SelectContent>{choices.map(template => <SelectItem key={text(template.id, '')} value={text(template.id, '')}>{template.name} · {template.product}</SelectItem>)}</SelectContent></Select>{!choices.length && <p className="text-sm text-muted-foreground">Mos xarita shabloni topilmadi. Saqlangan buyurtmalardagi xarita va hisob sozlamalarini tekshiring.</p>}</>}</div>}
      <CalculatorManagementNotice management={management} onSaved={finish} />
      <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Bekor qilish</Button><Button variant={dialog === 'delete' ? 'destructive' : 'default'} disabled={blocked || dialog === 'template' && !name.trim() || dialog === 'route' && (!routeId || templates.isPending || Boolean(templates.error))} onClick={submit}>{management.pending && <Loader2 className="size-4 animate-spin" />}Tasdiqlash</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>
}
