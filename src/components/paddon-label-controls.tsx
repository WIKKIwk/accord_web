import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Printer, QrCode, RefreshCw } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import { PaddonLabelApi, PaddonLabelUnknown, canReadPaddonLabelReport, paddonLabelIntentLedger, preparePaddonLabelOperation } from '@/lib/paddon-label'
import type { PaddonLabelIntent, PaddonLabelPreparation, PaddonLabelReport } from '@/lib/paddon-label'
import type { PaddonSummary } from '@/lib/paddons'
import { paddonQrSymbol, downloadPaddonLabel, openPaddonLabel } from '@/lib/paddon-qr'
import { PaddonError, PaddonLoading } from './paddon-controls'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'

const paddonQuantity = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 6 }).format(value)
const retryAllowed = (error: unknown) => !(error instanceof ApiError && [401, 403].includes(error.status))

export function PaddonLabelToolbar({ paddon }: { paddon: PaddonSummary }) {
  const { session, demo, scope } = useSession(), [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  const ledger = useMemo(() => paddonLabelIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot)
  useEffect(() => { if (!intent) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [intent])
  if (!canReadPaddonLabelReport(session)) return null
  return <><Button ref={trigger} variant="outline" disabled={demo} onClick={() => setOpen(true)}><QrCode />QR va yorliq{intent && <Badge variant="secondary">{intent.status === 'unknown' ? 'Javobni tekshirish' : 'Tayyorlanmoqda'}</Badge>}</Button>{open && <PaddonLabelManager key={scope} paddon={paddon} onClose={() => setOpen(false)} returnFocus={() => trigger.current?.focus()} />}</>
}

export function PaddonQrPreview({ code }: { code: string }) {
  const symbol = paddonQrSymbol(code)
  return <figure className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-white p-4 text-black" aria-label="Paddon QR yorlig‘i">
    <svg role="img" aria-label={`Paddon ${code} QR`} viewBox={`0 0 ${symbol.size} ${symbol.size}`} shapeRendering="crispEdges" className="size-48 max-w-full"><rect width={symbol.size} height={symbol.size} fill="white" /><path d={symbol.path} fill="black" /></svg>
    <figcaption className="font-mono text-2xl font-semibold tracking-widest">{code}</figcaption>
  </figure>
}

export function PaddonLabelReportView({ report }: { report: PaddonLabelReport }) {
  const p = report.paddon
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
      <PaddonQrPreview code={report.qr_payload} />
      <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><p className="text-lg font-semibold">Paddon {p.code}</p><Badge variant="outline">{p.locked_at_unix === null ? 'Bosish qulfi yo‘q' : 'Bosish qulfi bor'}</Badge></div>
        <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">Partiyalar</dt><dd className="font-medium">{p.item_count}</dd></div><div><dt className="text-muted-foreground">Mahsulot brutto, kg</dt><dd className="font-medium">{paddonQuantity(p.total_gross_kg)}</dd></div><div><dt className="text-muted-foreground">Mahsulot netto, kg</dt><dd className="font-medium">{paddonQuantity(p.total_net_kg)}</dd></div><div><dt className="text-muted-foreground">Joylashuv</dt><dd className="break-words">{p.location || '—'}</dd></div></dl>
        <p className="text-xs text-muted-foreground">Yorliq kodni saqlaydi. Jami vaznlar server hisobotidan olinadi; paddon tarasi qo‘shilmagan.</p>
      </div>
    </div>
    <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">Hisobotdagi partiyalar · {report.items.length}</summary><div className="mt-3 max-h-52 space-y-2 overflow-y-auto">{report.items.length ? report.items.map(item => <div key={item.batch_id} className="space-y-1 rounded-md bg-muted/30 p-2"><p className="break-words font-medium">{item.label_item_name || item.label_item_code}</p><p className="break-all text-xs text-muted-foreground">{item.batch_id} · {item.order_id}</p><p className="text-xs text-muted-foreground">{paddonQuantity(item.finished_goods_kg)} kg · {paddonQuantity(item.finished_goods_meter)} m</p></div>) : <p className="text-muted-foreground">Paddon tarkibi bo‘sh.</p>}</div></details>
  </div>
}

function LabelRecovery({ intent, checking, error, onCheck, onReviewed }: { intent: PaddonLabelIntent; checking: boolean; error: unknown; onCheck: () => void; onReviewed: () => void }) {
  const [reviewed, setReviewed] = useState(false)
  return <div className="space-y-4"><PaddonError error={new PaddonLabelUnknown(intent.operation)} /><p className="text-sm">Avvalgi paddon: <strong>{intent.operation.code}</strong>. Bu amal faqat yorliq ma’lumotini tayyorlaydi; printerga topshiriq yuborilmagan.</p>
    <Button variant="outline" disabled={checking} onClick={() => { setReviewed(false); onCheck() }}><RefreshCw className={checking ? 'animate-spin' : ''} />Yorliq hisobotini tekshirish</Button><PaddonError error={error} />
    {intent.observation && <><p className="text-sm">{intent.observation.state === 'missing' ? 'Paddon joriy hisobotda topilmadi.' : intent.observation.state === 'different' ? 'Paddon hisoboti avvalgi ko‘rinishdan farq qiladi.' : 'Paddonning joriy hisoboti avvalgi ko‘rinishga mos.'} Bu yo‘qolgan tayyorlash javobi yoki fizik bosma natijasini tasdiqlamaydi.</p>{intent.observation.report && <PaddonLabelReportView report={intent.observation.report} />}<Label className="flex items-start gap-3"><Checkbox checked={reviewed} disabled={checking} onCheckedChange={value => setReviewed(value === true)} /><span>Joriy hisobotni ko‘rdim. Fizik bosma tasdiqlanmaganini tushunaman.</span></Label><Button variant="outline" disabled={!reviewed || checking} onClick={onReviewed}>Yorliq tekshiruvini yakunlash</Button></>}
  </div>
}

function PaddonLabelManager({ paddon, onClose, returnFocus }: { paddon: PaddonSummary; onClose: () => void; returnFocus: () => void }) {
  const { client, session, demo, scope, connection } = useSession(), api = useMemo(() => client && session && !demo ? new PaddonLabelApi(client, session) : null, [client, session, demo])
  const ledger = useMemo(() => paddonLabelIntentLedger(scope), [scope]), intent = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot), leases = useMemo(() => new MutationScope(), []), busy = useRef(false)
  const [error, setError] = useState<unknown>(null), [localError, setLocalError] = useState<unknown>(null), [checking, setChecking] = useState(false), [prepared, setPrepared] = useState<PaddonLabelPreparation | null>(null)
  const query = useQuery({ queryKey: ['paddon-label-report', scope, paddon.id, paddon.code], queryFn: ({ signal }) => api!.report(paddon, signal), enabled: !!api && !intent, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => () => leases.cancelAll(), [leases])
  const ready = !!query.data && query.isFetchedAfterMount && !query.error && !query.isFetching, blocked = !!intent || !ready || connection !== 'online' || !!error
  async function refresh() { if (intent || busy.current) return; const result = await query.refetch(); if (!result.error) { setError(null); setLocalError(null); setPrepared(null) } }
  async function prepare() {
    if (!api || !query.data || blocked || busy.current || ledger.snapshot()) return
    const operation = preparePaddonLabelOperation(query.data); busy.current = true; ledger.begin(operation); setError(null); setPrepared(null); const lease = leases.begin()
    try { const result = await api.execute(operation, lease.controller.signal); if (!leases.isCurrent(lease)) { ledger.unknown(operation); return }; ledger.finish(operation); setPrepared(result) }
    catch (failure) { if (failure instanceof PaddonLabelUnknown) ledger.unknown(operation); else ledger.finish(operation); if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false }
  }
  async function observe() {
    const current = ledger.snapshot(); if (!api || connection === 'checking' || busy.current || current?.status !== 'unknown') return
    busy.current = true; setChecking(true); setError(null); const lease = leases.begin()
    try { const result = await api.observe(current.operation, lease.controller.signal); if (leases.isCurrent(lease)) ledger.observe(current.operation, result) }
    catch (failure) { if (leases.isCurrent(lease)) setError(failure) }
    finally { leases.finish(lease); busy.current = false; if (!lease.controller.signal.aborted) setChecking(false) }
  }
  function localLabel(kind: 'open' | 'download') {
    if (blocked || !query.data) return
    setLocalError(null)
    try { if (kind === 'download') downloadPaddonLabel(query.data.qr_payload); else if (!openPaddonLabel(query.data.qr_payload)) setLocalError(new Error('Brauzer yorliq oynasini blokladi. Yorliqni yuklab, alohida oching.')) }
    catch (failure) { setLocalError(failure) }
  }
  const recovery = intent?.status === 'unknown'
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}><DialogContent className="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); returnFocus() }}>
    <DialogHeader className="shrink-0 border-b p-4 pr-12 sm:p-5 sm:pr-12"><DialogTitle>{recovery ? 'Yorliq javobini tekshirish' : `Paddon ${paddon.code} · QR va yorliq`}</DialogTitle><DialogDescription>QR kodni ko‘ring yoki bosma oynasi uchun yorliqni oching.</DialogDescription></DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5" data-label-scroll>
      {recovery && intent ? <LabelRecovery intent={intent} checking={checking || connection === 'checking'} error={error instanceof PaddonLabelUnknown ? null : error} onCheck={() => void observe()} onReviewed={() => { ledger.resolveReviewed(intent.operation); setError(null); setPrepared(null); void query.refetch() }} /> : <>
        {query.isPending ? <PaddonLoading label="Paddon QR hisoboti yuklanmoqda…" /> : query.error ? <><PaddonError error={query.error} />{retryAllowed(query.error) && <Button variant="outline" onClick={() => void refresh()}>QR hisobotini qayta yuklash</Button>}</> : query.data && <PaddonLabelReportView report={query.data} />}
        <PaddonError error={error} /><PaddonError error={localError} />{!!error && retryAllowed(error) && <Button variant="outline" onClick={() => void refresh()}>Joriy hisobotni ko‘rib qayta boshlash</Button>}
        {prepared && <Alert><AlertDescription>Server {prepared.qr_payload} uchun yorliq ma’lumotini tayyorladi. Qog‘ozga bosish hali tasdiqlanmagan.</AlertDescription></Alert>}
        {intent?.status === 'pending' && <PaddonLoading label="Yorliq ma’lumoti tayyorlanmoqda…" />}
      </>}
    </div>
    <div className="shrink-0 border-t bg-background p-3 sm:p-4" data-label-footer>
      {!recovery && <p className="mb-3 text-xs text-muted-foreground">Bosma oynasini ochish yoki yopish paddonni bosilgan deb belgilamaydi.</p>}
      <DialogFooter className="m-0 grid grid-cols-2 gap-2 rounded-none border-0 bg-transparent p-0 sm:flex sm:flex-row sm:flex-wrap">
        {!recovery && <><Button variant="ghost" disabled={!!intent || query.isFetching} onClick={() => void refresh()}><RefreshCw />Hisobotni yangilash</Button><Button variant="outline" disabled={blocked} onClick={() => localLabel('download')}><Download />Yorliqni yuklash</Button><Button variant="outline" disabled={blocked} onClick={() => void prepare()}><QrCode />Yorliqni tayyorlash</Button><Button className="order-last col-span-2 sm:order-none" disabled={blocked} onClick={() => localLabel('open')}><Printer />Yorliq oynasini ochish</Button></>}
        <Button variant="outline" className={recovery ? 'col-span-2' : undefined} onClick={onClose}>Yorliq oynasini yopish</Button>
      </DialogFooter>
    </div>
  </DialogContent></Dialog>
}
