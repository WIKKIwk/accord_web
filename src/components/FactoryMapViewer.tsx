import { useEffect, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

export interface FactoryMapObject {
  objectId: string
  label: string
  aliases?: string[]
}

export interface FactoryMapViewerProps {
  liveState?: object
  stockState?: object
  selectedObjectId?: string
  focusedObjectId?: string
  resetRevision?: number
  showLabels?: boolean
  renderSuspended?: boolean
  className?: string
  onObjectTap?: (object: FactoryMapObject) => void
  onObjectsReady?: (objects: FactoryMapObject[]) => void
  onFocusComplete?: (objectId: string) => void
  onLoad?: () => void
  onError?: (message: string) => void
}

interface FactoryRendererModule {
  mountFactoryMap: (canvas: HTMLCanvasElement) => () => void
}

interface RendererMessage {
  type?: string
  objectId?: string
  label?: string
  message?: string
  objects?: FactoryMapObject[]
  loaded?: number
  total?: number
}

const assetBase = `${import.meta.env.BASE_URL}factory-map/`
let rendererPromise: Promise<FactoryRendererModule> | null = null
let rendererAttempt = 0

function rendererModule(): FactoryRendererModule | undefined {
  return (window as Window & { __accordFactoryMapRenderer?: FactoryRendererModule }).__accordFactoryMapRenderer
}

// A public module entry must load as a browser script. Importing public/ from
// source makes Vite 8 treat the URL as application code and reject it in dev.
function loadFactoryMapRenderer(): Promise<FactoryRendererModule> {
  const loaded = rendererModule()
  if (loaded) return Promise.resolve(loaded)
  if (rendererPromise) return rendererPromise
  rendererPromise = new Promise<FactoryRendererModule>((resolve, reject) => {
    const script = document.createElement('script')
    const attempt = String(rendererAttempt++)
    script.type = 'module'
    script.src = `${assetBase}factory-map-entry.js?v=20261013cad1&attempt=${attempt}`
    script.dataset.accordFactoryMapModule = 'true'
    const timeout = window.setTimeout(() => fail('3D xarita moduli yuklanishi tugamadi.'), 60_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      script.onload = null
      script.onerror = null
      window.removeEventListener('accord-factory-map-ready', ready)
      window.removeEventListener('accord-factory-map-error', error)
    }
    const fail = (reason: string) => { cleanup(); script.remove(); reject(new Error(reason)) }
    const finish = () => {
      const module = rendererModule()
      if (!module) return
      cleanup()
      resolve(module)
    }
    const ready = (event: Event) => {
      const detail = (event as CustomEvent<{ attempt: string; module?: FactoryRendererModule }>).detail
      if (detail?.attempt !== attempt) return
      const module = detail.module ?? rendererModule()
      if (!module?.mountFactoryMap) { fail('3D xarita moduli ochilmadi.'); return }
      cleanup()
      resolve(module)
    }
    const error = (event: Event) => {
      const detail = (event as CustomEvent<{ attempt: string; message?: string }>).detail
      if (detail?.attempt === attempt) fail(detail.message || '3D xarita moduli yuklanmadi.')
    }
    // A module tag's load event is not the asynchronous import handshake.
    // Wait for the entry's ready event after its dependency graph is available.
    script.onload = finish
    script.onerror = () => fail('3D xarita moduli yuklanmadi.')
    window.addEventListener('accord-factory-map-ready', ready)
    window.addEventListener('accord-factory-map-error', error)
    document.head.append(script)
  }).catch((error: unknown) => {
    rendererPromise = null
    throw error
  })
  return rendererPromise
}

/** The same renderer and persisted object identities as the mobile factory map. */
export function FactoryMapViewer(props: FactoryMapViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const callbacksRef = useRef(props)
  callbacksRef.current = props
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState({ loaded: 0, total: 0, preparing: false })
  const [error, setError] = useState('')
  const rendererState = JSON.stringify({
    enabled: true,
    live: props.liveState ?? {},
    stock: props.stockState ?? {},
    selectedObjectId: props.selectedObjectId ?? '',
    focusedObjectId: props.focusedObjectId ?? '',
    resetRevision: props.resetRevision ?? 0,
    showLabels: props.showLabels !== false,
    renderSuspended: props.renderSuspended === true,
  })

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    let cancelled = false
    let dispose: (() => void) | undefined
    setLoading(true)
    setError('')
    setProgress({ loaded: 0, total: 0, preparing: false })

    const receiveMessage = (event: Event) => {
      const bridge = event.target
      if (!(bridge instanceof HTMLElement) || !bridge.hasAttribute('data-factory-map-bridge')) return
      let message: RendererMessage
      try { message = JSON.parse(bridge.getAttribute('data-model-viewer-message') ?? '{}') as RendererMessage }
      catch { return }
      if (cancelled) return
      const callbacks = callbacksRef.current
      switch (message.type) {
        case 'load_progress':
          setProgress({ loaded: message.loaded ?? 0, total: message.total ?? 0, preparing: false })
          break
        case 'load_prepare':
          setProgress(previous => ({ ...previous, preparing: true }))
          break
        case 'load_complete':
          setLoading(false)
          callbacks.onObjectsReady?.(message.objects ?? [])
          callbacks.onLoad?.()
          break
        case 'load_error': {
          const reason = message.message || 'Zavod modeli yuklanmadi.'
          setError(reason)
          setLoading(false)
          callbacks.onError?.(reason)
          break
        }
        case 'object_tap':
          if (message.objectId) callbacks.onObjectTap?.({ objectId: message.objectId, label: message.label ?? message.objectId })
          break
        case 'focus_complete':
          if (message.objectId) callbacks.onFocusComplete?.(message.objectId)
          break
      }
    }
    host.addEventListener('model-viewer-plus-message', receiveMessage)
    void loadFactoryMapRenderer().then(module => {
      if (!cancelled) dispose = module.mountFactoryMap(canvas)
    }).catch((cause: unknown) => {
      if (cancelled) return
      const reason = cause instanceof Error ? cause.message : '3D xarita ochilmadi.'
      setError(reason)
      setLoading(false)
      callbacksRef.current.onError?.(reason)
    })

    return () => {
      cancelled = true
      host.removeEventListener('model-viewer-plus-message', receiveMessage)
      dispose?.()
    }
  }, [attempt])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.setAttribute('data-model-viewer-state', rendererState)
    host.dispatchEvent(new Event('model-viewer-state'))
  }, [rendererState, attempt])

  const percentage = progress.preparing ? 95 : progress.total ? Math.min(94, Math.round(progress.loaded / progress.total * 94)) : 0

  return (
    <div ref={hostRef} className={cn('relative isolate min-h-[480px] w-full overflow-hidden bg-zinc-100', props.className)} data-model-viewer-state={rendererState}>
      <canvas
        key={attempt}
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        data-factory-map-canvas
        data-model-src={`${assetBase}zavod6-cad-line-art.glb`}
        data-model-gzip-src={`${assetBase}zavod6-cad-line-art.glb.gz`}
        data-selected-object-id={props.selectedObjectId ?? ''}
        data-selection-mode="false"
        draggable={false}
        aria-label="Zavodning interaktiv 3D xaritasi"
      />
      <div hidden className="absolute inset-0" data-factory-map-status />
      <div hidden data-factory-map-bridge />
      {(loading || error) && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-background/95 px-6">
          <div className="w-full max-w-xs space-y-4 text-center" role={error ? 'alert' : 'status'} aria-live="polite">
            {error ? <AlertCircle className="mx-auto size-8 text-destructive" /> : <LoaderCircle className="mx-auto size-8 animate-spin text-muted-foreground" />}
            <div className="space-y-1">
              <p className="font-medium">{error ? 'Zavod modeli ochilmadi' : progress.preparing ? '3D xarita tayyorlanmoqda' : 'Zavod xaritasi yuklanmoqda'}</p>
              <p className="text-sm text-muted-foreground">{error || (progress.loaded ? `${(progress.loaded / 1048576).toFixed(1)}${progress.total ? ` / ${(progress.total / 1048576).toFixed(1)}` : ''} MB` : 'Model va apparatlar tayyorlanmoqda.')}</p>
            </div>
            {error ? (
              <Button variant="outline" onClick={() => setAttempt(previous => previous + 1)}><RotateCcw />Qayta yuklash</Button>
            ) : <Progress value={percentage} aria-label="Model yuklanishi" />}
          </div>
        </div>
      )}
    </div>
  )
}
