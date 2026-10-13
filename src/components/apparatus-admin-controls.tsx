import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, CheckCircle2, FileUp, Loader2, Pencil, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError, isRecord } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import {
  ApparatusAdminApi, ApparatusAdminConflict, ApparatusAdminUnknown, apparatusAdminError,
  apparatusAdminId, apparatusAdminPermissions, apparatusCreateDraft,
  apparatusCreateOperation, apparatusDefaultForm, apparatusImportOperation, apparatusOperationLabels,
  apparatusPatchOperation, apparatusProfileForm, apparatusRetireOperation, apparatusTechnologies,
  apparatusTechnologyLabels, inspectApparatusAasx,
} from '@/lib/apparatus-admin'
import type {
  ApparatusAdminOperation, ApparatusAdminOptions, ApparatusAdminResult, ApparatusAdminSnapshot,
  ApparatusAasxPreview, ApparatusDraft, ApparatusProfileForm,
  ApparatusProjection, ApparatusReferences,
} from '@/lib/apparatus-admin'
import { MutationScope } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type SavedCallback = () => void
type Action = 'edit' | 'retire' | 'import'
const pendingWrites = new Map<string, ApparatusAdminOperation>()
const profile = (value: Row): Row => isRecord(value.runtime_projection) ? value.runtime_projection : value
const text = (value: unknown): string => typeof value === 'string' ? value : ''
function useApparatusApi() {
  const context = useSession()
  const api = useMemo(() => context.client && context.session && !context.demo ? new ApparatusAdminApi(context.client, context.session) : null, [context.client, context.session, context.demo])
  return { ...context, api, permissions: apparatusAdminPermissions(context.session) }
}
function useApparatusWrite(identity: string, onSaved?: SavedCallback, onRetired?: SavedCallback) {
  const { scope, api, permissions, connection } = useApparatusApi(), queryClient = useQueryClient()
  const context = `${scope}:apparatus-admin:${identity}`, current = useRef(context), busy = useRef(false), leases = useMemo(() => new MutationScope(), [])
  current.current = context
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(() => pendingWrites.has(context) ? new ApparatusAdminUnknown(pendingWrites.get(context)!) : null)
  const unknown = error instanceof ApparatusAdminUnknown ? error : null
  useEffect(() => {
    busy.current = false; setPending(false)
    const operation = pendingWrites.get(context)
    if (operation) setError(new ApparatusAdminUnknown(operation))
    return () => leases.cancelAll()
  }, [context, api, leases])
  async function run(operation: ApparatusAdminOperation, done: (result: ApparatusAdminResult) => void, recovery = false) {
    if (busy.current || !api || !permissions.manage || connection !== 'online' || !recovery && pendingWrites.has(context)) return
    busy.current = true; setPending(true); setError(null); pendingWrites.set(context, operation)
    const lease = leases.begin(), key = context
    try {
      const result = recovery ? await api.recover(operation, lease.controller.signal) : await api.execute(operation, lease.controller.signal)
      if (key !== current.current || !leases.isCurrent(lease)) return
      pendingWrites.delete(key)
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
      onSaved?.(); if (operation.kind === 'retire') onRetired?.()
      done(result); toast.success(result.recovered ? 'Serverdagi apparat revisioni tasdiqlandi.' : 'Apparatning yangi revisioni saqlandi.')
    } catch (failure) {
      if (key !== current.current || !leases.isCurrent(lease)) return
      if (!(failure instanceof ApparatusAdminUnknown)) pendingWrites.delete(key)
      setError(failure)
    } finally {
      leases.finish(lease)
      if (key === current.current && leases.isCurrent(lease)) { busy.current = false; setPending(false) }
    }
  }
  return { pending, error, unknown, run, clear: () => { if (!pending && !unknown) setError(null) }, canWrite: Boolean(api && permissions.manage && connection === 'online' && !pending && !unknown && !pendingWrites.has(context)), canRecover: Boolean(api && permissions.manage && connection === 'online' && !pending), discard: () => { if (!pending) { pendingWrites.delete(context); setError(null) } } }
}
function ErrorNotice({ error }: { error: unknown }) { return error ? <Alert variant="destructive"><AlertDescription>{apparatusAdminError(error)}</AlertDescription></Alert> : null }
function ReadState({ loading, error, retry, children }: { loading: boolean; error: unknown; retry: () => void; children: ReactNode }) {
  if (loading) return <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Amaldagi apparat profili yuklanmoqda…</p>
  if (error) return <div className="space-y-3"><ErrorNotice error={error} />{!(error instanceof ApiError && [401, 403].includes(error.status)) && <Button variant="outline" onClick={retry}>Qayta yuklash</Button>}</div>
  return children
}
function AdminDialog({ title, description, onClose, locked = false, children }: { title: string; description: string; onClose: () => void; locked?: boolean; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose() }}><DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-3xl" showCloseButton={!locked} onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onInteractOutside={event => { if (locked) event.preventDefault() }}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>
}
function SavedRevision({ result, onClose }: { result: ApparatusAdminResult; onClose: () => void }) {
  return <div className="space-y-4"><div className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />Serverdagi apparat tasdiqlandi.</div><dl className="grid gap-2 text-sm sm:grid-cols-[140px_1fr]"><dt className="text-muted-foreground">Nomi</dt><dd>{result.snapshot.revision.display.display_name}</dd><dt className="text-muted-foreground">Apparat ID</dt><dd className="break-all">{result.snapshot.revision.apparatus_id}</dd><dt className="text-muted-foreground">Revision</dt><dd>{result.snapshot.projection.source_revision}</dd><dt className="text-muted-foreground">AASX SHA-256</dt><dd className="break-all text-xs">{result.snapshot.projection.source_aasx_sha256}</dd></dl><DialogFooter><Button variant="outline" onClick={onClose}>Yopish</Button><Button asChild><Link to={`/app/apparatus?selected=${encodeURIComponent(result.snapshot.revision.apparatus_id)}`} onClick={onClose}>Apparat tafsilotlari</Link></Button></DialogFooter></div>
}
function ProfileSummary({ revision }: { revision: Pick<ApparatusDraft, 'display' | 'capabilities' | 'execution_profile' | 'training'> }) {
  return <dl className="grid gap-2 text-sm sm:grid-cols-[160px_1fr]"><dt className="text-muted-foreground">Nomi</dt><dd>{revision.display.display_name}</dd><dt className="text-muted-foreground">Izoh / tartib</dt><dd>{revision.display.description || '—'} · {revision.display.catalog_order}</dd><dt className="text-muted-foreground">Operatsiya</dt><dd>{apparatusOperationLabels[revision.execution_profile.operation]} · {apparatusTechnologyLabels[revision.execution_profile.technology]}</dd><dt className="text-muted-foreground">Eni, mm</dt><dd>{revision.execution_profile.min_web_width_mm ?? '—'} — {revision.execution_profile.max_web_width_mm ?? '—'}</dd><dt className="text-muted-foreground">Rang stansiyalari</dt><dd>{revision.execution_profile.color_station_count ?? '—'}</dd><dt className="text-muted-foreground">Imkoniyatlar</dt><dd className="flex flex-wrap gap-1">{revision.capabilities.map(capability => <Badge key={capability.code} variant="outline">{capability.code}: {capability.level}</Badge>)}</dd><dt className="text-muted-foreground">Virtual ish / qayta yo‘l</dt><dd>{revision.execution_profile.virtual_tasks === 'input_bridge' ? 'Yoqilgan' : 'O‘chirilgan'} / {revision.execution_profile.capability_compatible_reroute ? 'Ruxsat berilgan' : 'O‘chirilgan'}</dd><dt className="text-muted-foreground">O‘quv profili</dt><dd>{revision.training.enabled ? `Yoqilgan · navbat ${revision.training.queue_enabled ? 'ha' : 'yo‘q'} · material hisobi ${revision.training.material_tracking_enabled ? 'ha' : 'yo‘q'}` : 'O‘chirilgan'}</dd></dl>
}
function Confirmation({ operation, write, onClose, onDone, onCurrent }: { operation: ApparatusAdminOperation; write: ReturnType<typeof useApparatusWrite>; onClose: () => void; onDone: (result: ApparatusAdminResult) => void; onCurrent?: (snapshot: ApparatusAdminSnapshot) => void }) {
  const current = write.error instanceof ApparatusAdminConflict ? write.error.current : undefined
  const title = operation.kind === 'create' ? 'Yangi apparatni yaratish' : operation.kind === 'retire' ? 'Apparatni foydalanishdan chiqarish' : operation.kind === 'import' ? 'AASX orqali apparatni yangilash' : 'Apparat profilini saqlash'
  return <AdminDialog title={title} description="Qiymatlarni tekshirib, ushbu bitta apparat uchun amalni tasdiqlang." locked={write.pending || Boolean(write.unknown)} onClose={onClose}>
    {operation.kind !== 'create' && <p className="break-all text-xs text-muted-foreground">{operation.baseline.revision.apparatus_id} · Asos revision {operation.baseline.projection.source_revision}</p>}
    {operation.kind === 'retire' ? <div className="space-y-3"><p className="text-sm">{operation.baseline.revision.display.display_name}</p><p className="text-sm">Sabab: {operation.reason}</p><Alert><AlertDescription>Apparat foydalanishdan chiqariladi va keyingi tahrirlar qulflanadi. Bu tizimda uni qayta faol qilish amali mavjud emas. Tarixiy identifikatori saqlanadi.</AlertDescription></Alert></div> : <ProfileSummary revision={operation.kind === 'create' ? operation.draft : operation.kind === 'patch' ? operation.input : operation.file.revision} />}
    {operation.kind === 'create' && <div className="space-y-2 rounded-lg border p-3 text-xs"><p>Jismoniy aktiv: {operation.draft.physical_asset_id}</p><p>Uskuna klassi: {operation.draft.equipment_class_id}</p>{Object.entries(operation.draft.hierarchy).map(([key, value]) => <p key={key}>{key}: {value}</p>)}<p>Yangi quvvat: 1 parallel joy, 100% samaradorlik, har doim; tayyorlash/tozalash 0 daqiqa. Qat’iy navbat. Xomashyo va qolip skani hali talab qilinmaydi. 3D biriktirish bo‘sh.</p><p>Apparatning canonical ID sini server yaratadi.</p></div>}
    {operation.kind === 'patch' && <p className="text-xs text-muted-foreground">Canonical va jismoniy identifikatorlar, ierarxiya, joylashuv, quvvat hamda navbat/xomashyo/qolip qoidalari saqlanadi.</p>}
    {operation.kind === 'import' && <div className="space-y-2 rounded-lg border p-3 text-xs"><p>{operation.file.name} · {(operation.file.size / 1048576).toFixed(2)} MiB</p><p className="break-all">Fayl SHA-256: {operation.file.sha256}</p><p>Fayldagi profil o‘qildi. Server AASX semantikasi va yaxlitligini yakuniy tekshiradi. Identifikator, joylashuv va rejalashtirish qoidalari joriy nusxaga mos.</p></div>}
    <ErrorNotice error={write.error} />
    {write.unknown && <div className="space-y-2"><p className="text-xs text-muted-foreground">So‘rov avtomatik takrorlanmaydi. Tekshirish faqat serverdagi joriy nusxani o‘qiydi.</p><Button variant="outline" disabled={!write.canRecover} onClick={() => void write.run(write.unknown!.operation, onDone, true)}>Serverdagi saqlashni tekshirish</Button></div>}
    {current && onCurrent && <Button variant="outline" disabled={write.pending} onClick={() => onCurrent(current)}>Joriy nusxani yuklash</Button>}
    <DialogFooter><Button variant="outline" disabled={write.pending || Boolean(write.unknown)} onClick={onClose}>Yopish</Button><Button disabled={!write.canWrite || Boolean(write.error)} onClick={() => void write.run(operation, onDone)}>{write.pending && <Loader2 className="size-4 animate-spin" />}{write.pending ? 'Server tekshirilmoqda…' : 'Tasdiqlash va saqlash'}</Button></DialogFooter>
  </AdminDialog>
}

export function ApparatusAdminControls({ row, onSaved, onRetired }: { row: Row; onSaved?: SavedCallback; onRetired?: SavedCallback }) {
  const { scope, permissions } = useApparatusApi(), id = apparatusAdminId(row)
  if (!id || !permissions.read) return null
  return <ApparatusMaintenanceEntry key={`${scope}:${id}`} id={id} row={profile(row)} onSaved={onSaved} onRetired={onRetired} />
}
function ApparatusMaintenanceEntry({ id, row, onSaved, onRetired }: { id: string; row: Row; onSaved?: SavedCallback; onRetired?: SavedCallback }) {
  const { demo, permissions } = useApparatusApi(), write = useApparatusWrite(id, onSaved, onRetired)
  const [action, setAction] = useState<Action | null>(null), [result, setResult] = useState<ApparatusAdminResult | null>(null)
  const lifecycle = isRecord(row.lifecycle) ? text(row.lifecycle.state) : '', active = lifecycle === 'active'
  const projection = row, display = isRecord(projection.display) ? projection.display : {}
  return <div className="space-y-3 border-t pt-4"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">Apparat profili</p><Badge variant="outline">{active ? 'Faol' : lifecycle === 'retired' ? 'Foydalanishdan chiqarilgan' : 'Hayot sikli noma’lum'}</Badge></div><p className="break-all text-xs text-muted-foreground">{id}</p>{projection.physical_asset_id !== undefined && <p className="break-all text-xs text-muted-foreground">Jismoniy aktiv: {text(projection.physical_asset_id)}</p>}
    {lifecycle === 'retired' && <p className="text-xs leading-relaxed text-muted-foreground">{isRecord(row.lifecycle) ? text(row.lifecycle.retirement_reason) : ''} Foydalanishdan chiqarilgan apparat tahrirlanmaydi. Qayta faol qilish amali mavjud emas.</p>}
    {permissions.manage && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={demo || !active || !write.canWrite} onClick={() => { setResult(null); write.clear(); setAction('edit') }}><Pencil />Apparatni tahrirlash</Button><Button variant="outline" disabled={demo || !active || !write.canWrite} onClick={() => { setResult(null); write.clear(); setAction('import') }}><FileUp />AASX faylidan yangilash</Button><Button variant="outline" disabled={demo || !active || !write.canWrite} onClick={() => { setResult(null); write.clear(); setAction('retire') }}><Archive />Foydalanishdan chiqarish</Button></div>}
    {permissions.manage && active && isRecord(row.execution_profile) && row.execution_profile.operation === 'print' && <p className="text-xs text-muted-foreground">Bosma apparat navbat siyosati mobil qoidaga ko‘ra qulflangan. Ushbu profil oynasi navbat siyosatini o‘zgartirmaydi.</p>}
    {write.unknown && !action && <Confirmation operation={write.unknown.operation} write={write} onClose={() => {}} onDone={saved => setResult(saved)} />}
    {!action && <ErrorNotice error={write.error && !write.unknown ? write.error : null} />}
    {action && <ApparatusMaintenanceDialog id={id} name={text(display.display_name) || id} action={action} write={write} onClose={() => setAction(null)} onDone={saved => { setResult(saved); setAction(null) }} />}
    {result && <AdminDialog title="Apparat revisioni tasdiqlandi" description="Server qaytargan apparat identifikatori va amaldagi revision." onClose={() => setResult(null)}><SavedRevision result={result} onClose={() => setResult(null)} /></AdminDialog>}
  </div>
}
function ApparatusMaintenanceDialog({ id, name, action, write, onClose, onDone }: { id: string; name: string; action: Action; write: ReturnType<typeof useApparatusWrite>; onClose: () => void; onDone: (result: ApparatusAdminResult) => void }) {
  const { api, scope } = useApparatusApi()
  const query = useQuery({ queryKey: ['apparatus-admin-source', scope, id], queryFn: ({ signal }) => api!.read(id, signal), enabled: !!api, staleTime: 0, retry: false, refetchOnWindowFocus: false })
  const options = useQuery({ queryKey: ['apparatus-admin-options', scope], queryFn: ({ signal }) => api!.options(signal), enabled: action === 'edit' && !!api, staleTime: 60_000, retry: false })
  const references = useQuery({ queryKey: ['apparatus-admin-references', scope, id], queryFn: ({ signal }) => api!.references(id, signal), enabled: !!api, staleTime: 0, retry: false, refetchOnWindowFocus: false })
  return <AdminDialog title={action === 'edit' ? 'Apparat profilini tahrirlash' : action === 'retire' ? 'Foydalanishdan chiqarish' : 'AASX faylidan yangilash'} description={name} locked={write.pending || Boolean(write.unknown)} onClose={onClose}><ApparatusMaintenanceReadView source={query} action={action} options={options} references={references} write={write} onDone={onDone} retry={() => { void query.refetch(); if (action === 'edit') void options.refetch() }} /></AdminDialog>
}
type MaintenanceRead<T> = { data?: T; error: unknown; isPending: boolean }
export function ApparatusMaintenanceReadView({ source, action, options, references, write, onDone, retry }: {
  source: MaintenanceRead<ApparatusAdminSnapshot> & { isFetchedAfterMount: boolean }
  action: Action
  options: MaintenanceRead<ApparatusAdminOptions>
  references: MaintenanceRead<ApparatusReferences> & { isFetching: boolean }
  write: ReturnType<typeof useApparatusWrite>
  onDone: (result: ApparatusAdminResult) => void
  retry: () => void
}) {
  // Cached data cannot seed a new command until this dialog's canonical read finishes.
  // Later background reads leave the mounted form's reviewed draft intact.
  const pending = source.isPending || !source.isFetchedAfterMount || action === 'edit' && options.isPending
  return <ReadState loading={pending} error={source.error || action === 'edit' && options.error} retry={retry}>{source.data && (action !== 'edit' || options.data) && <MaintenanceForm initial={source.data} action={action} options={options.data} references={references.data} referencesError={references.error} referencesLoading={references.isPending || references.isFetching} write={write} onDone={onDone} />}</ReadState>
}
function ReferenceNotice({ references, error, loading }: { references?: ApparatusReferences; error: unknown; loading: boolean }) {
  if (loading) return <p className="text-xs text-muted-foreground" role="status">Bog‘liq buyurtmalar tekshirilmoqda…</p>
  if (error || !references) return <Alert><AlertDescription>Buyurtma bog‘lanishlari tasdiqlanmadi. Faqat nom, izoh va ro‘yxat tartibini o‘zgartirish mumkin.</AlertDescription></Alert>
  return <div className="space-y-1 rounded-lg border p-3 text-xs text-muted-foreground"><p>Faol buyurtmalar: {references.activeOrderIds.length} · Holati noma’lum: {references.unknownOrderIds.length} · Tarixiy: {references.historicalOrderIds.length}</p>{references.activeOrderIds.length + references.unknownOrderIds.length > 0 && <p>Web faol yoki holati noma’lum buyurtmaga bog‘liq apparatni chiqarish va ish profilini o‘zgartirishni bloklaydi. Nom va izohni tahrirlash mumkin.</p>}<p>Ishchi biriktirishlari uchun apparatga oid alohida bog‘liqlik tekshiruvi mavjud emas.</p></div>
}
function MaintenanceForm({ initial, action, options, references, referencesError, referencesLoading, write, onDone }: { initial: ApparatusAdminSnapshot; action: Action; options?: ApparatusAdminOptions; references?: ApparatusReferences; referencesError: unknown; referencesLoading: boolean; write: ReturnType<typeof useApparatusWrite>; onDone: (result: ApparatusAdminResult) => void }) {
  const id = useId(), [baseline, setBaseline] = useState(initial), [form, setForm] = useState(() => apparatusProfileForm(initial.revision)), [reason, setReason] = useState('')
  const [file, setFile] = useState<ApparatusAasxPreview | null>(null), [reading, setReading] = useState(false), fileEpoch = useRef(0)
  const [validation, setValidation] = useState(''), [confirm, setConfirm] = useState<ApparatusAdminOperation | null>(() => write.unknown?.operation ?? null)
  const referenceBlocked = referencesLoading || Boolean(referencesError) || !references || references.activeOrderIds.length > 0 || references.unknownOrderIds.length > 0
  const blocked = !write.canWrite || reading || baseline.revision.lifecycle.state !== 'active'
  useEffect(() => () => { fileEpoch.current++ }, [])
  async function chooseFile(value?: File) {
    const epoch = ++fileEpoch.current; setFile(null); setValidation(''); setReading(false)
    if (!value) return
    setReading(true)
    try { const preview = await inspectApparatusAasx(value); if (epoch !== fileEpoch.current) return; apparatusImportOperation(baseline, preview); setFile(preview) }
    catch (error) { if (epoch === fileEpoch.current) setValidation(apparatusAdminError(error)) }
    finally { if (epoch === fileEpoch.current) setReading(false) }
  }
  function review(event: FormEvent) {
    event.preventDefault(); if (blocked) return
    try { const operation = action === 'edit' ? apparatusPatchOperation(baseline, form) : action === 'retire' ? apparatusRetireOperation(baseline, reason) : file ? apparatusImportOperation(baseline, file) : null; if (!operation) throw new Error('AASX faylini tanlang.'); setValidation(''); write.clear(); setConfirm(operation) }
    catch (error) { setValidation(apparatusAdminError(error)) }
  }
  function loadCurrent(current: ApparatusAdminSnapshot) { fileEpoch.current++; setReading(false); setBaseline(current); setForm(apparatusProfileForm(current.revision)); setFile(null); setConfirm(null); write.discard(); setValidation('') }
  return <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-xs text-muted-foreground">{baseline.revision.apparatus_id}</p><Badge variant="outline">Revision {baseline.projection.source_revision}</Badge></div><ReferenceNotice references={references} error={referencesError} loading={referencesLoading} />
    {baseline.revision.lifecycle.state !== 'active' && <Alert><AlertDescription>Apparat foydalanishdan chiqarilgan. Uni tahrirlash yoki qayta faol qilish amali mavjud emas.</AlertDescription></Alert>}
    <form onSubmit={review} noValidate className="space-y-5">{action === 'edit' && options && <ProfileFields form={form} setForm={setForm} options={options} disabled={blocked} structuralDisabled={blocked || referenceBlocked} toolingRequired={isRecord(baseline.revision.policies.tooling) && baseline.revision.policies.tooling.mode === 'qolip_scan_required'} />}
      {action === 'retire' && <><p className="text-sm">Apparat tarixiy identifikatorini saqlab, foydalanishdan chiqariladi. Keyingi tahrirlar qulflanadi; qayta faol qilish amali mavjud emas.</p><div className="space-y-2"><Label htmlFor={`${id}-reason`}>Foydalanishdan chiqarish sababi</Label><Input id={`${id}-reason`} value={reason} disabled={blocked || referenceBlocked} maxLength={256} onChange={event => setReason(event.target.value)} /></div></>}
      {action === 'import' && <div className="space-y-3"><Label htmlFor={`${id}-file`}>Canonical .aasx fayli, 16 MiB gacha</Label><Input key={baseline.projection.source_aasx_sha256} id={`${id}-file`} type="file" accept=".aasx" disabled={blocked || referenceBlocked} onChange={event => void chooseFile(event.target.files?.[0])} />{reading && <p className="text-sm text-muted-foreground" role="status">Fayldagi canonical profil o‘qilmoqda…</p>}{file && <div className="space-y-3 rounded-lg border p-3"><p className="text-sm">{file.name} · {(file.size / 1048576).toFixed(2)} MiB</p><ProfileSummary revision={file.revision} /></div>}<p className="text-xs leading-relaxed text-muted-foreground">Import faqat joriy apparat uchun. Canonical va jismoniy ID, ierarxiya, 3D biriktirish, hayot sikli, quvvat va navbat/xomashyo/qolip qoidalari joriy nusxaga mos bo‘lishi kerak. Fayl tanlash serverga yozmaydi.</p></div>}
      <ErrorNotice error={validation ? new Error(validation) : null} /><DialogFooter><Button type="submit" disabled={blocked || action !== 'edit' && referenceBlocked || action === 'import' && !file}>Amalni ko‘rib chiqish</Button></DialogFooter>
    </form>{confirm && <Confirmation operation={confirm} write={write} onClose={() => { setConfirm(null); write.clear() }} onDone={onDone} onCurrent={loadCurrent} />}
  </div>
}
function ProfileFields({ form, setForm, options, disabled, structuralDisabled, toolingRequired = false }: { form: ApparatusProfileForm; setForm: (value: ApparatusProfileForm) => void; options: ApparatusAdminOptions; disabled: boolean; structuralDisabled: boolean; toolingRequired?: boolean }) {
  const id = useId(), supportedTechnologies = apparatusTechnologies(form.operation).filter(value => options.technologies.includes(value))
  const field = (key: 'name' | 'description' | 'catalogOrder' | 'colorStations' | 'minWidth' | 'maxWidth', label: string, structural = false) => <div className="space-y-2"><Label htmlFor={`${id}-${key}`}>{label}</Label><Input id={`${id}-${key}`} value={form[key]} inputMode={['catalogOrder', 'colorStations', 'minWidth', 'maxWidth'].includes(key) ? 'numeric' : undefined} disabled={disabled || structural && structuralDisabled} onChange={event => setForm({ ...form, [key]: event.target.value })} /></div>
  function setTraining(enabled: boolean) { const levels = { ...form.levels }; if (enabled) levels.training ??= '1'; else delete levels.training; setForm({ ...form, levels, training: { enabled, queue_enabled: enabled && form.training.queue_enabled, material_tracking_enabled: enabled && form.training.material_tracking_enabled } }) }
  return <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2">{field('name', 'Apparat nomi')}{field('catalogOrder', 'Ro‘yxat tartibi')}{field('description', 'Izoh (bitta satr, 2000 belgigacha)')}</div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-operation`}>Operatsiya</Label><Select value={form.operation} disabled={structuralDisabled} onValueChange={value => { const operation = value as ApparatusProfileForm['operation'], technology = apparatusTechnologies(operation).find(value => options.technologies.includes(value)); if (technology) setForm({ ...form, operation, technology, colorStations: operation === 'print' ? form.colorStations || '7' : '', levels: { ...form.levels, [operation]: form.levels[operation] ?? '1' } }) }}><SelectTrigger id={`${id}-operation`}><SelectValue /></SelectTrigger><SelectContent>{options.operations.map(operation => <SelectItem key={operation} value={operation}>{apparatusOperationLabels[operation]}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label htmlFor={`${id}-technology`}>Texnologiya</Label><Select value={form.technology} disabled={structuralDisabled} onValueChange={value => setForm({ ...form, technology: value as ApparatusProfileForm['technology'] })}><SelectTrigger id={`${id}-technology`}><SelectValue /></SelectTrigger><SelectContent>{supportedTechnologies.map(technology => <SelectItem key={technology} value={technology}>{apparatusTechnologyLabels[technology]}</SelectItem>)}</SelectContent></Select></div>{form.operation === 'print' && field('colorStations', 'Rang stansiyalari, 1–32', true)}{field('minWidth', 'Eng kam eni, mm (ixtiyoriy)', true)}{field('maxWidth', 'Eng katta eni, mm (ixtiyoriy)', true)}</div>
    <div className="space-y-2"><p className="text-sm font-medium">Imkoniyatlar va darajalar</p>{options.capabilities.filter(code => code !== 'training').map(code => { const required = code === form.operation || code === 'tooling' && toolingRequired || code === 'virtual_task' && form.virtualTasks; return <div key={code} className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><Label htmlFor={`${id}-${code}`} className="flex flex-1 items-center gap-2"><Checkbox id={`${id}-${code}`} checked={form.levels[code] !== undefined} disabled={structuralDisabled || required} onCheckedChange={checked => { const levels = { ...form.levels }; if (checked === true) levels[code] = '1'; else delete levels[code]; setForm({ ...form, levels }) }} />{code}{required ? ' · profil uchun talab qilinadi' : ''}</Label>{form.levels[code] !== undefined && <div className="flex items-center gap-2"><Label htmlFor={`${id}-${code}-level`}>Daraja, 1–100</Label><Input id={`${id}-${code}-level`} className="w-20" inputMode="numeric" value={form.levels[code]} disabled={structuralDisabled} onChange={event => setForm({ ...form, levels: { ...form.levels, [code]: event.target.value } })} /></div>}</div> })}</div>
    <div className="space-y-3"><Label className="flex items-center gap-2" htmlFor={`${id}-virtual`}><Checkbox id={`${id}-virtual`} checked={form.virtualTasks} disabled={structuralDisabled || !options.capabilities.includes('virtual_task')} onCheckedChange={value => setForm({ ...form, virtualTasks: value === true, levels: value === true ? { ...form.levels, virtual_task: form.levels.virtual_task ?? '1' } : form.levels })} />Virtual ishga kirishni yoqish</Label><Label className="flex items-center gap-2" htmlFor={`${id}-reroute`}><Checkbox id={`${id}-reroute`} checked={form.reroute} disabled={structuralDisabled} onCheckedChange={value => setForm({ ...form, reroute: value === true })} />Mos imkoniyatli apparatga qayta yo‘l berish</Label><Label className="flex items-center gap-2" htmlFor={`${id}-training`}><Checkbox id={`${id}-training`} checked={form.training.enabled} disabled={structuralDisabled || !options.capabilities.includes('training')} onCheckedChange={value => setTraining(value === true)} />O‘quv profilini yoqish</Label>{form.training.enabled && <div className="space-y-2 rounded-lg border p-3">{(['queue_enabled', 'material_tracking_enabled'] as const).map(key => <Label className="flex items-center gap-2" key={key} htmlFor={`${id}-${key}`}><Checkbox id={`${id}-${key}`} checked={form.training[key]} disabled={structuralDisabled} onCheckedChange={value => setForm({ ...form, training: { ...form.training, [key]: value === true } })} />{key === 'queue_enabled' ? 'O‘quv navbati' : 'O‘quv material hisobini yuritish'}</Label>)}<div className="space-y-2"><Label htmlFor={`${id}-training-level`}>Training darajasi, 1–100</Label><Input id={`${id}-training-level`} className="w-24" inputMode="numeric" value={form.levels.training ?? ''} disabled={structuralDisabled} onChange={event => setForm({ ...form, levels: { ...form.levels, training: event.target.value } })} /></div></div>}</div>
  </div>
}

export function ApparatusAdminToolbar({ onSaved }: { onSaved?: SavedCallback }) {
  const { scope, demo, permissions } = useApparatusApi()
  if (!permissions.manage) return null
  return <ApparatusCreateEntry key={scope} demo={demo} onSaved={onSaved} />
}
function ApparatusCreateEntry({ demo, onSaved }: { demo: boolean; onSaved?: SavedCallback }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<ApparatusAdminResult | null>(null), write = useApparatusWrite('new', onSaved)
  function done(saved: ApparatusAdminResult) { setResult(saved); setOpen(false) }
  return <><Button disabled={demo || !write.canWrite} onClick={() => { write.clear(); setResult(null); setOpen(true) }}><Plus />Apparat qo‘shish</Button>{open && <ApparatusCreateDialog write={write} onClose={() => setOpen(false)} onDone={done} />}{write.unknown && !open && <Confirmation operation={write.unknown.operation} write={write} onClose={() => {}} onDone={done} />}{result && <AdminDialog title="Yangi apparat tasdiqlandi" description="Canonical identifikator va revision server tomonidan qaytarildi." onClose={() => setResult(null)}><SavedRevision result={result} onClose={() => setResult(null)} /></AdminDialog>}</>
}
function ApparatusCreateDialog({ write, onClose, onDone }: { write: ReturnType<typeof useApparatusWrite>; onClose: () => void; onDone: (result: ApparatusAdminResult) => void }) {
  const { api, scope } = useApparatusApi()
  const options = useQuery({ queryKey: ['apparatus-admin-options', scope], queryFn: ({ signal }) => api!.options(signal), enabled: !!api, retry: false, staleTime: 60_000 })
  const catalog = useQuery({ queryKey: ['apparatus-admin-create-catalog', scope], queryFn: ({ signal }) => api!.list('', signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  return <AdminDialog title="Yangi canonical apparat" description="Haqiqiy jismoniy aktiv va ierarxiya identifikatorlarini kiriting. Server apparat ID sini o‘zi belgilaydi." onClose={onClose} locked={write.pending || Boolean(write.unknown)}><ReadState loading={options.isPending || catalog.isPending} error={options.error || catalog.error} retry={() => { void options.refetch(); void catalog.refetch() }}>{options.data && catalog.data && <ApparatusCreateForm options={options.data} catalog={catalog.data.items} bounded={catalog.data.bounded} write={write} onDone={onDone} />}</ReadState></AdminDialog>
}
function ApparatusCreateForm({ options, catalog, bounded, write, onDone }: { options: ApparatusAdminOptions; catalog: ApparatusProjection[]; bounded: boolean; write: ReturnType<typeof useApparatusWrite>; onDone: (result: ApparatusAdminResult) => void }) {
  const id = useId(), [form, setForm] = useState(apparatusDefaultForm), [template, setTemplate] = useState('')
  const [equipmentClass, setEquipmentClass] = useState(''), [physicalAsset, setPhysicalAsset] = useState(''), [hierarchy, setHierarchy] = useState<ApparatusDraft['hierarchy']>({ enterprise_id: '', site_id: '', area_id: '', work_center_id: '', work_unit_id: '' })
  const [confirm, setConfirm] = useState<ApparatusAdminOperation | null>(() => write.unknown?.operation ?? null), [validation, setValidation] = useState('')
  const hierarchyLabels: Record<keyof ApparatusDraft['hierarchy'], string> = { enterprise_id: 'Korxona ID', site_id: 'Maydon ID', area_id: 'Hudud ID', work_center_id: 'Ish markazi ID', work_unit_id: 'Ish birligi ID' }
  function submit(event: FormEvent) { event.preventDefault(); if (!write.canWrite) return; try { const draft = apparatusCreateDraft(form, { equipmentClass, physicalAsset, hierarchy }); if (catalog.some(item => item.physical_asset_id === draft.physical_asset_id)) throw new Error('Jismoniy aktiv boshqa apparatga tegishli. Yangi aktiv ID sini kiriting.'); setConfirm(apparatusCreateOperation(draft)); write.clear(); setValidation('') } catch (error) { setValidation(apparatusAdminError(error)) } }
  return <form onSubmit={submit} noValidate className="space-y-5"><div className="space-y-2"><Label htmlFor={`${id}-template`}>Ierarxiya uchun mavjud apparat namunasi (ixtiyoriy)</Label><Select value={template || '__none__'} disabled={!write.canWrite} onValueChange={value => { setTemplate(value === '__none__' ? '' : value); const selected = catalog.find(item => item.apparatus_id === value); if (selected) { setHierarchy({ ...selected.hierarchy }); setEquipmentClass(selected.equipment_class_id) } }}><SelectTrigger id={`${id}-template`}><SelectValue placeholder="Namuna tanlang" /></SelectTrigger><SelectContent><SelectItem value="__none__">Qo‘lda kiriting</SelectItem>{catalog.filter(item => item.lifecycle.state === 'active').map(item => <SelectItem key={item.apparatus_id} value={item.apparatus_id}>{item.display.display_name}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Namuna faqat ierarxiya va klassni to‘ldiradi. Yangi jismoniy aktivni alohida kiriting.</p>{bounded && <p className="text-xs text-muted-foreground">Namuna ro‘yxati eng ko‘p 500 apparatdan iborat; bu to‘liq katalog soni emas.</p>}</div><ProfileFields form={form} setForm={setForm} options={options} disabled={!write.canWrite} structuralDisabled={!write.canWrite} />
    <div className="space-y-3 border-t pt-4"><p className="text-sm font-medium">Jismoniy aktiv va ierarxiya</p><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-asset`}>Yangi jismoniy aktiv ID</Label><Input id={`${id}-asset`} value={physicalAsset} disabled={!write.canWrite} placeholder="physical-asset:…" onChange={event => setPhysicalAsset(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-class`}>Uskuna klassi ID</Label><Input id={`${id}-class`} value={equipmentClass} disabled={!write.canWrite} placeholder="equipment-class:…" onChange={event => setEquipmentClass(event.target.value)} /></div>{Object.entries(hierarchyLabels).map(([key, label]) => <div key={key} className="space-y-2"><Label htmlFor={`${id}-${key}`}>{label}</Label><Input id={`${id}-${key}`} value={hierarchy[key as keyof typeof hierarchy]} disabled={!write.canWrite} onChange={event => setHierarchy({ ...hierarchy, [key]: event.target.value })} /></div>)}</div><p className="text-xs text-muted-foreground">Identifikatorlar bo‘shliqsiz, ikki nuqtali shaklda yoziladi. Jismoniy aktiv ID si keyingi revisionlarda o‘zgartirilmaydi. Apparat ID sini server belgilaydi.</p></div>
    <ErrorNotice error={validation ? new Error(validation) : null} /><DialogFooter><Button type="submit" disabled={!write.canWrite}>Yangi apparatni ko‘rib chiqish</Button></DialogFooter>{confirm && <Confirmation operation={confirm} write={write} onClose={() => { setConfirm(null); write.clear() }} onDone={onDone} />}
  </form>
}
