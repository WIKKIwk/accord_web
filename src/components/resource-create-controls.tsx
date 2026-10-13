import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ResourceKind, Row } from '@/lib/api-types'
import { ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { ResourceCreateApi, ResourceCreateUnknown, canCreateResource, canReviewResourceCreate, isResourceCreateKind, resourceCreateError, resourceCreateMemory } from '@/lib/resource-create'
import type { ResourceCreateContext, ResourceCreateReceipt } from '@/lib/resource-create'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** The generic form keeps its fields; this hook owns scoped RAM drafts and confirmed create settlement. */
export function useResourceCreate(kind: ResourceKind, initialValues: Row, onConfirmed: (receipt: ResourceCreateReceipt) => void) {
  const { client, session, demo, scope } = useSession(), queryClient = useQueryClient()
  useMemo(() => resourceCreateMemory.activate(scope), [scope])
  const subscribe = useCallback((listener: () => void) => resourceCreateMemory.subscribe(scope, kind, listener), [scope, kind])
  const snapshot = useCallback(() => resourceCreateMemory.read(scope, kind, initialValues)!, [scope, kind, initialValues])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [mutations] = useState(() => new MutationScope()), [pendingKey, setPendingKey] = useState<string | null>(null)
  const key = `${scope}:${kind}`, currentKey = useRef(key), busyKey = useRef<string | null>(null), mounted = useRef(true), callback = useRef(onConfirmed)
  currentKey.current = key; callback.current = onConfirmed
  const api = useMemo(() => client && session && !demo ? new ResourceCreateApi(client, session, intent => resourceCreateMemory.markSent(scope, intent)) : null, [client, session, demo, scope])
  useEffect(() => { mounted.current = true; busyKey.current = null; setPendingKey(null); return () => { mounted.current = false; mutations.cancelAll() } }, [key, mutations])
  useEffect(() => {
    if (!entry.intent) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [entry.intent])
  const setValues: Dispatch<SetStateAction<Row>> = useCallback(values => { const current = resourceCreateMemory.read(scope, kind); if (current) resourceCreateMemory.patch(scope, kind, { values: typeof values === 'function' ? values(current.values) : values }) }, [scope, kind])
  const pending = pendingKey === key
  function current(captured: string, lease: ReturnType<MutationScope['begin']>) { return mounted.current && currentKey.current === captured && mutations.isCurrent(lease) }
  function confirmed(receipt: ResourceCreateReceipt) {
    resourceCreateMemory.patch(scope, kind, { values: initialValues, intent: null, error: null, review: null })
    void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
    callback.current(receipt)
  }
  async function submit(body: Row = entry.values, context: ResourceCreateContext = {}) {
    if (busyKey.current === key) return
    if (!api || !isResourceCreateKind(kind) || !canCreateResource(session, kind)) { resourceCreateMemory.patch(scope, kind, { error: new ApiError(403, 'forbidden') }); return }
    const existing = resourceCreateMemory.read(scope, kind)?.intent
    if (existing) { resourceCreateMemory.patch(scope, kind, { error: new ResourceCreateUnknown(existing) }); return }
    busyKey.current = key; setPendingKey(key); resourceCreateMemory.patch(scope, kind, { error: null, review: null })
    const captured = key, lease = mutations.begin()
    try { const receipt = await api.create(kind, body, context, lease.controller.signal); if (current(captured, lease)) confirmed(receipt) }
    catch (error) { if (current(captured, lease)) resourceCreateMemory.patch(scope, kind, { error, ...(error instanceof ResourceCreateUnknown ? {} : { intent: null }) }) }
    finally { mutations.finish(lease); if (currentKey.current === captured && !lease.controller.signal.aborted) { busyKey.current = null; if (mounted.current) setPendingKey(null) } }
  }
  async function reviewExisting(offset = 0) {
    const intent = resourceCreateMemory.read(scope, kind)?.intent
    if (!api || !intent || busyKey.current === key) return
    busyKey.current = key; setPendingKey(key)
    const captured = key, lease = mutations.begin()
    try { const review = await api.review(intent, offset, lease.controller.signal); if (current(captured, lease)) resourceCreateMemory.patch(scope, kind, { review, error: new ResourceCreateUnknown(intent) }) }
    catch (error) { if (current(captured, lease)) resourceCreateMemory.patch(scope, kind, { error }) }
    finally { mutations.finish(lease); if (currentKey.current === captured && !lease.controller.signal.aborted) { busyKey.current = null; if (mounted.current) setPendingKey(null) } }
  }
  function acknowledgeExisting(receipt: ResourceCreateReceipt, confirmation: boolean) {
    const intent = resourceCreateMemory.read(scope, kind)?.intent
    if (!api || !intent || pending || !mounted.current) return
    try { confirmed(api.acknowledgeExisting(intent, receipt.row, confirmation)) }
    catch (error) { resourceCreateMemory.patch(scope, kind, { error }) }
  }
  function newDecision(confirmed: boolean) { if (!pending) resourceCreateMemory.newDecision(scope, kind, initialValues, confirmed) }
  return { values: entry.values, setValues, error: entry.error, intent: entry.intent, review: entry.review, pending, blocked: pending || !!entry.intent || demo || !canCreateResource(session, kind), canReview: !!entry.intent && canReviewResourceCreate(session, entry.intent.kind), submit, reviewExisting, acknowledgeExisting, newDecision, kind }
}
export type ResourceCreateController = ReturnType<typeof useResourceCreate>
export function ResourceCreateNotice({ state }: { state: ResourceCreateController }) {
  const { scope } = useSession()
  return <ScopedResourceCreateNotice key={`${scope}:${state.kind}`} state={state} />
}
function ScopedResourceCreateNotice({ state }: { state: ResourceCreateController }) {
  const [decision, setDecision] = useState<'new' | ResourceCreateReceipt | null>(null)
  if (!state.error && !state.intent) return null
  const unknown = !!state.intent
  return <div className="space-y-3">
    <Alert variant="destructive"><AlertDescription className="space-y-3"><p>{state.pending ? 'Saqlash holati tekshirilmoqda…' : resourceCreateError(state.error)}</p>{unknown && <><p className="text-xs">Yuborilgan yozuv: {String(state.intent!.body.name ?? state.intent!.body.warehouse ?? '')}. Qayta saqlash bloklangan.</p><div className="flex flex-wrap gap-2">{state.canReview && <Button type="button" variant="outline" size="sm" disabled={state.pending} onClick={() => void state.reviewExisting()}>{state.pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Saqlangan yozuvlarni tekshirish</Button>}<Button type="button" variant="outline" size="sm" asChild><Link to={`/app/${state.kind}`}>Ro‘yxatni ko‘rish</Link></Button><Button type="button" variant="outline" size="sm" disabled={state.pending} onClick={() => setDecision('new')}>Yangi yozuv boshlash</Button></div>{!state.canReview && <p className="text-xs">Saqlangan yozuvlarni tekshirish uchun ko‘rish ruxsati yetarli emas.</p>}</>}</AlertDescription></Alert>
    {state.review && <div className="space-y-3 rounded-md border p-3"><p className="text-sm font-medium">Mos yozuvlar</p>{state.review.candidates.length ? <ul className="space-y-2">{state.review.candidates.map(receipt => <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"><div className="min-w-0 text-sm"><p className="break-words font-medium">{String(receipt.row.name ?? receipt.row.warehouse ?? receipt.id)}</p><p className="break-all text-xs text-muted-foreground">{receipt.id}{receipt.row.phone ? ` · ${String(receipt.row.phone)}` : ''}</p></div><Button type="button" variant="outline" size="sm" disabled={state.pending} onClick={() => setDecision(receipt)}>Shu yozuvdan foydalanish</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Bu ro‘yxatda mos yozuv topilmadi. Saqlash natijasi hali tasdiqlanmagan.</p>}<p className="text-xs text-muted-foreground">{state.review.loaded} ta yozuv tekshirildi. Ro‘yxatda yo‘qligi so‘rov bajarilmaganini tasdiqlamaydi.</p>{state.review.atLimit && ['items', 'suppliers', 'customers'].includes(state.kind) && <Button type="button" variant="outline" size="sm" disabled={state.pending} onClick={() => void state.reviewExisting(state.review!.offset + state.review!.limit!)}>Keyingi yozuvlarni tekshirish</Button>}</div>}
    <Dialog open={!!decision} onOpenChange={open => { if (!open) setDecision(null) }}><DialogContent><DialogHeader><DialogTitle>{decision === 'new' ? 'Yangi yozuv boshlash' : 'Topilgan yozuvdan foydalanish'}</DialogTitle><DialogDescription>{decision === 'new' ? 'Oldingi so‘rov natijasi hali aniq emas. Ro‘yxatni tekshirib, yangi yozuv boshlashga qaror qilganingizni tasdiqlang.' : 'Bu mavjud yozuv yuborilgan maydonlarga mos. Undan foydalanish takroriy yozuv yaratmaydi.'}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDecision(null)}>Bekor qilish</Button><Button type="button" disabled={state.pending} onClick={() => { if (decision === 'new') state.newDecision(true); else if (decision) state.acknowledgeExisting(decision, true); setDecision(null) }}>Tasdiqlash</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
