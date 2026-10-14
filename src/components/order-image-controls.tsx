import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Image as ImageIcon, ImageOff, RefreshCw } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { OrderImagesApi, canReadOrderImages, canReadPendingImages, canReadTemplateImages } from '@/lib/order-images'
import type { OrderImageResult } from '@/lib/order-images'
import { orderPhotoKey } from '@/lib/order-photo'
import type { OrderPhotoReference } from '@/lib/order-photo'
import { orderImageReadQueue } from '@/lib/order-image-queue'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Skeleton } from './ui/skeleton'

const denied = (failure: unknown) => failure instanceof ApiError && [401, 403].includes(failure.status)
function missingFailure(result: OrderImageResult | undefined): Error | null {
  if (result?.kind !== 'missing' || result.reason === 'no_image') return null
  return new Error(result.reason === 'route_unavailable' ? 'Rasm xizmati topilmadi. Qayta tekshirib ko‘ring.' : result.reason === 'order_missing' ? 'Buyurtma serverda topilmadi. Ro‘yxatni yangilang.' : 'Rasm javobi aniqlanmadi. Qayta yuklab ko‘ring.')
}
const imageBlob = (result: OrderImageResult | undefined) => result?.kind === 'image' ? result.blob : undefined

function useBlobUrl(blob: Blob | undefined, key: string): string | undefined {
  const [entry, setEntry] = useState<{ blob: Blob; key: string; url: string } | null>(null)
  useEffect(() => { if (!blob) return; const url = URL.createObjectURL(blob); setEntry({ blob, key, url }); return () => URL.revokeObjectURL(url) }, [blob, key])
  return entry?.blob === blob && entry?.key === key ? entry.url : undefined
}
const watchers = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null
function observeNearViewport(node: Element, change: (visible: boolean) => void): () => void {
  if (!('IntersectionObserver' in window)) return () => {}
  observer ??= new IntersectionObserver(entries => { for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting) }, { rootMargin: '96px 0px', threshold: 0 })
  watchers.set(node, change); observer.observe(node)
  return () => { observer?.unobserve(node); watchers.delete(node); if (!watchers.size) { observer?.disconnect(); observer = null } }
}
function ImagePlaceholder({ state = 'idle' }: { state?: string }) { return <span className="flex size-full items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">{state === 'error' ? <ImageOff className="size-4" /> : <ImageIcon className="size-4" />}</span> }

export function OrderImageThumbnail({ photo, title }: { photo: OrderPhotoReference | null; title: string }) {
  const { client, session, demo, scope } = useSession(), trigger = useRef<HTMLButtonElement>(null), [near, setNear] = useState(false), [openKey, setOpenKey] = useState<string | null>(null)
  const key = photo ? orderPhotoKey(photo) : 'absent', scopedKey = `${scope}:${key}`
  const permitted = !!photo && (photo.kind === 'production' ? canReadOrderImages(session) : photo.kind === 'template' ? canReadTemplateImages(session) : canReadPendingImages(session))
  const api = useMemo(() => client && session && !demo ? new OrderImagesApi(client, session) : null, [client, session, demo])
  useEffect(() => { const node = trigger.current; if (!node || !permitted || demo || photo?.kind === 'pending') return; return observeNearViewport(node, setNear) }, [permitted, demo, photo?.kind])
  const [observed, setObserved] = useState<{ key: string; state: string } | null>(null), state = !photo ? 'missing' : !permitted ? 'denied' : observed?.key === scopedKey ? observed.state : photo.kind === 'pending' ? 'on-demand' : 'idle'
  const onThumbnailState = useCallback((next: string) => setObserved(previous => previous?.key === scopedKey && previous.state === next ? previous : { key: scopedKey, state: next }), [scopedKey])
  const blocked = !api || !permitted || ['missing', 'denied'].includes(state), fallbackTitle = state === 'missing' ? 'Rasm yo‘q' : state === 'denied' ? 'Rasmni ko‘rish uchun ruxsat yetarli emas' : state === 'error' ? 'Kichik rasm olinmadi. Kattalashtirib ko‘ring.' : photo?.kind === 'pending' ? 'Rasmni ochish' : 'Rasmni kattalashtirish'
  return <span className="contents" onClick={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="h-10 w-12 shrink-0 overflow-hidden rounded-md border bg-muted/30 p-0 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" aria-label={`${title}: ${["missing", "denied"].includes(state) ? fallbackTitle : "rasmni kattalashtirish"}`} title={fallbackTitle} disabled={blocked} data-order-image data-image-state={state} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation() }} onClick={event => { event.stopPropagation(); if (!blocked) setOpenKey(scopedKey) }}>
      {near && permitted && api && client && photo && photo.kind !== 'pending' ? <NearThumbnail key={scopedKey} photo={photo} api={api} client={client} scope={scope} title={title} onState={onThumbnailState} /> : <ImagePlaceholder state={state} />}
    </button>
    {openKey === scopedKey && api && permitted && photo && <OrderImageViewer key={scopedKey} photo={photo} api={api} scope={scope} title={title} onClose={() => setOpenKey(null)} returnFocus={() => trigger.current?.focus()} />}
  </span>
}
function NearThumbnail({ photo, api, client, scope, title, onState }: { photo: Exclude<OrderPhotoReference, { kind: 'pending' }>; api: OrderImagesApi; client: NonNullable<ReturnType<typeof useSession>['client']>; scope: string; title: string; onState: (state: string) => void }) {
  const key = orderPhotoKey(photo), [decode, setDecode] = useState<{ blob: Blob | undefined; failed: boolean } | null>(null)
  const query = useQuery({ queryKey: ['order-image-thumb', scope, key], queryFn: ({ signal }) => orderImageReadQueue(client).run(() => photo.kind === 'production' ? api.thumbnail(photo.image, signal) : api.templateThumbnail(photo.image, signal), signal), staleTime: 0, gcTime: 30_000, retry: false, refetchOnWindowFocus: false })
  const blob = imageBlob(query.data), url = useBlobUrl(blob, `${scope}:${key}`), decoded = decode?.blob === blob && decode?.failed === false, decodeError = decode?.blob === blob && decode?.failed === true
  const state = denied(query.error) ? 'denied' : query.error || decodeError ? 'error' : query.data?.kind === 'missing' ? query.data.reason === 'no_image' ? 'missing' : 'error' : decoded ? 'loaded' : 'loading'
  useEffect(() => { onState(state) }, [state, onState])
  return <span className="relative block size-full">
    {state === 'loading' && <Skeleton className="absolute inset-0 size-full rounded-none" />}
    {url && !decodeError && <img src={url} alt={`${title} buyurtma rasmi`} width={48} height={40} decoding="async" draggable={false} className={`size-full object-cover motion-safe:transition-opacity motion-safe:duration-150 ${decoded ? 'opacity-100' : 'opacity-0'}`} onLoad={event => { const image = event.currentTarget; setDecode({ blob, failed: Math.max(image.naturalWidth, image.naturalHeight) > 256 }) }} onError={() => setDecode({ blob, failed: true })} />}
    {['missing', 'error', 'denied'].includes(state) && <span className="absolute inset-0"><ImagePlaceholder state={state} /></span>}
  </span>
}
function OrderImageViewer({ photo, api, scope, title, onClose, returnFocus }: { photo: OrderPhotoReference; api: OrderImagesApi; scope: string; title: string; onClose: () => void; returnFocus: () => void }) {
  const key = orderPhotoKey(photo), [decode, setDecode] = useState<{ blob: Blob | undefined; failed: boolean } | null>(null)
  const query = useQuery({ queryKey: ['order-image-full', scope, key], queryFn: ({ signal }) => photo.kind === 'production' ? api.full(photo.image, signal) : photo.kind === 'template' ? api.templateFull(photo.image, signal) : api.pendingFull(photo.image, signal), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false })
  const result = query.isFetching ? undefined : query.data, blob = imageBlob(result), url = useBlobUrl(blob, `${scope}:${key}`), decoded = decode?.blob === blob && decode?.failed === false, decodeError = decode?.blob === blob && decode?.failed === true, failure = query.isFetching ? null : query.error || missingFailure(result) || (decodeError ? new Error('Rasm faylini ko‘rsatib bo‘lmadi.') : null)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (["Enter", " "].includes(event.key)) event.stopPropagation() }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus() }}>
    <DialogHeader className="shrink-0 border-b p-4 pr-12"><DialogTitle>Buyurtma rasmi · {title}</DialogTitle><DialogDescription>Buyurtmaning serverdagi joriy rasmi.</DialogDescription></DialogHeader>
    <div className="flex h-[min(68svh,640px)] min-h-0 items-center justify-center overflow-auto bg-muted/20 p-4" data-order-image-viewport>
      {failure ? <div className="max-w-md space-y-3"><Alert variant="destructive"><AlertDescription>{failure.message}</AlertDescription></Alert>{!denied(failure) && <Button variant="outline" onClick={() => { setDecode(null); void query.refetch() }}><RefreshCw />Rasmni qayta yuklash</Button>}</div> : result?.kind === 'missing' ? <p role="status" className="text-sm text-muted-foreground">Bu buyurtmada ko‘rinadigan rasm topilmadi.</p> : <>
        {(!url || !decoded) && <div role="status" className="w-full max-w-lg space-y-3"><Skeleton className="aspect-[4/3] max-h-96 w-full" /><p className="text-center text-sm text-muted-foreground">Rasm yuklanmoqda…</p></div>}
        {url && <img src={url} alt={`${title} buyurtma rasmi, katta ko‘rinish`} decoding="async" draggable={false} className={`${decoded ? 'block' : 'hidden'} max-h-full max-w-full rounded-sm object-contain`} onLoad={() => setDecode({ blob, failed: false })} onError={() => setDecode({ blob, failed: true })} />}
      </>}
    </div>
    <DialogFooter className="m-0 shrink-0 flex-row p-3" data-order-image-footer><Button variant="outline" onClick={onClose}>Rasmni yopish</Button></DialogFooter>
  </DialogContent></Dialog>
}
