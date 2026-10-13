import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, EyeOff, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import {
  MaterialCatalogApi, MaterialCatalogConflict, MaterialSaveUnknown, coefficientToGsm, effectiveMaterialGsm,
  gsmToCoefficient, materialCatalogError, materialFormFrom, materialInputFromForm, parseCatalogMaterial, parseMaterialDecimal,
} from '@/lib/material-catalog'
import type { CatalogMaterial, MaterialCatalogSnapshot, MaterialForm, MaterialSaveResult, MaterialVariantForm } from '@/lib/material-catalog'
import { MutationScope } from '@/lib/mutation-scope'
import { hasCapability } from '@/lib/permissions'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type SavedCallback = () => void
const displayNumber = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('uz-UZ', { maximumFractionDigits: 6 })
function useMaterialApi() {
  const session = useSession()
  const api = useMemo(() => session.client && session.session && !session.demo ? new MaterialCatalogApi(session.client, session.session) : null, [session.client, session.session, session.demo])
  return { ...session, api }
}
function useMaterialWrite(identity: string, onSaved?: SavedCallback) {
  const { api, scope } = useMaterialApi()
  const queryClient = useQueryClient()
  const [mutations] = useState(() => new MutationScope())
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(null)
  const busy = useRef(false), current = useRef(`${scope}:${identity}`)
  current.current = `${scope}:${identity}`
  useEffect(() => () => mutations.cancelAll(), [mutations, scope, identity])
  async function run(execute: (api: MaterialCatalogApi, signal: AbortSignal) => Promise<MaterialSaveResult>, success?: (result: MaterialSaveResult) => void) {
    if (busy.current) return
    if (!api) { setError(new Error('Ko‘rish rejimida o‘zgarish saqlanmaydi.')); return }
    busy.current = true; setPending(true); setError(null)
    const key = current.current, lease = mutations.begin()
    try {
      const result = await execute(api, lease.controller.signal)
      if (key !== current.current || !mutations.isCurrent(lease)) return
      queryClient.setQueryData(['material-catalog', scope], result.snapshot)
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
      onSaved?.()
      toast.success(result.recovered ? 'O‘zgarish serverda tasdiqlandi.' : result.changedDuringSave ? 'O‘zgarish saqlandi, materiallar ro‘yxati yangilandi.' : 'O‘zgarish saqlandi.')
      success?.(result)
    } catch (error) {
      if (key === current.current && mutations.isCurrent(lease)) setError(error)
    } finally {
      mutations.finish(lease)
      if (key === current.current && !lease.controller.signal.aborted) { busy.current = false; setPending(false) }
    }
  }
  return { pending, error, setError, run }
}
function MaterialError({ error }: { error: unknown }) {
  return error ? <Alert variant="destructive" role="alert"><AlertDescription>{materialCatalogError(error)}</AlertDescription></Alert> : null
}
function CatalogReadState({ pending, error, retry, children }: { pending: boolean; error: unknown; retry: () => void; children: ReactNode }) {
  if (pending) return <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Materiallar yuklanmoqda…</p>
  if (error) return <div className="space-y-3"><MaterialError error={error} />{!(error instanceof ApiError && error.status === 403) && <Button variant="outline" onClick={retry}>Qayta urinish</Button>}</div>
  return children
}
function MaterialDialog({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>
}
function SaveLabel({ pending, label = 'Saqlash' }: { pending: boolean; label?: string }) { return <>{pending && <Loader2 className="size-4 animate-spin" />}{pending ? 'Tekshirilmoqda…' : label}</> }
function MaterialVariants({ material }: { material: CatalogMaterial }) {
  if (!material.variants.length) return <p className="text-sm text-muted-foreground">Mikron variantlari yo‘q. Hisoblash zichlik bo‘yicha bajariladi.</p>
  return <Table><TableHeader><TableRow><TableHead>Mikron</TableHead><TableHead className="text-right">GSM, g/m²</TableHead><TableHead className="text-right">Koeffitsiyent</TableHead></TableRow></TableHeader><TableBody>{material.variants.map(variant => <TableRow key={variant.micron}><TableCell>{variant.micron}</TableCell><TableCell className="text-right">{displayNumber(effectiveMaterialGsm(material.density_g_cm3, variant))}</TableCell><TableCell className="text-right">{displayNumber(variant.coefficient)}</TableCell></TableRow>)}</TableBody></Table>
}

/** Place in the materials DetailSheet. Reads and writes stay scoped to this row. */
export function MaterialCatalogControls({ row, onSaved, onRemoved }: { row: Row; onSaved?: SavedCallback; onRemoved?: SavedCallback }) {
  const { scope } = useSession()
  let material: CatalogMaterial
  try { material = parseCatalogMaterial(row) } catch { return null }
  return <MaterialControls key={`${scope}:${material.id}`} material={material} onSaved={onSaved} onRemoved={onRemoved} />
}
function MaterialControls({ material, onSaved, onRemoved }: { material: CatalogMaterial; onSaved?: SavedCallback; onRemoved?: SavedCallback }) {
  const { session, demo } = useSession()
  const [dialog, setDialog] = useState<'edit' | 'visibility' | null>(null)
  return <div className="space-y-4 border-t pt-4"><div><p className="mb-2 text-sm font-medium">Mikronlar</p><MaterialVariants material={material} /></div>
    {hasCapability(session, 'admin.access') && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={demo} onClick={() => setDialog('edit')}><Pencil />Materialni tahrirlash</Button><Button variant="outline" disabled={demo} onClick={() => setDialog('visibility')}>{material.active ? <EyeOff /> : <Eye />}{material.active ? 'Hisoblashda yashirish' : 'Hisoblashda ko‘rsatish'}</Button></div>}
    {dialog === 'edit' && <MaterialEditor materialId={material.id} onSaved={onSaved} onClose={() => setDialog(null)} />}
    {dialog === 'visibility' && <MaterialVisibilityDialog materialId={material.id} active={!material.active} onSaved={onSaved} onRemoved={onRemoved} onClose={() => setDialog(null)} />}
  </div>
}
/** Place in the materials list toolbar. All active rows participate in ordering. */
export function MaterialCatalogToolbar({ onSaved }: { onSaved?: SavedCallback }) {
  const { scope, session, demo } = useSession()
  const [dialog, setDialog] = useState<'new' | 'sequence' | null>(null)
  useEffect(() => setDialog(null), [scope])
  if (!hasCapability(session, 'admin.access')) return null
  return <div className="flex flex-wrap gap-2"><Button disabled={demo} onClick={() => setDialog('new')}><Plus />Material qo‘shish</Button><Button variant="outline" disabled={demo} onClick={() => setDialog('sequence')}><ArrowUpDown />Tartibni o‘zgartirish</Button>
    {dialog === 'new' && <MaterialEditor key={`${scope}:new`} onSaved={onSaved} onClose={() => setDialog(null)} />}
    {dialog === 'sequence' && <MaterialSequenceDialog key={`${scope}:sequence`} onSaved={onSaved} onClose={() => setDialog(null)} />}
  </div>
}
function useCatalogForEditor() {
  const { api, scope } = useMaterialApi()
  const [baseline, setBaseline] = useState<MaterialCatalogSnapshot | null>(null)
  const query = useQuery({ queryKey: ['material-catalog', scope], queryFn: ({ signal }) => api!.read(signal), enabled: !!api, retry: false, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => {
    if (!baseline && !query.isFetching && !query.error && query.data) setBaseline(query.data)
  }, [baseline, query.isFetching, query.error, query.data])
  // A background refresh must not discard an in-progress draft. save() checks it.
  return { data: baseline ?? undefined, isPending: !baseline && !query.error, isFetching: !baseline && query.isFetching, error: baseline ? null : query.error, refetch: query.refetch }
}
function MaterialEditor({ materialId, onSaved, onClose }: { materialId?: string; onSaved?: SavedCallback; onClose: () => void }) {
  const catalog = useCatalogForEditor()
  const material = catalog.data?.materials.find(material => material.id === materialId)
  return <MaterialDialog title={materialId ? 'Materialni tahrirlash' : 'Yangi hisoblash materiali'} description="Zichlikni va mikronlar uchun hisoblash qiymatlarini kiriting." onClose={onClose}>
    <CatalogReadState pending={catalog.isPending || catalog.isFetching} error={catalog.error} retry={() => void catalog.refetch()}>{catalog.data && (!materialId || material) ? <MaterialFormEditor initial={material} snapshot={catalog.data} onSaved={onSaved} onClose={onClose} /> : <p className="text-sm text-muted-foreground">Material topilmadi. Ro‘yxatni yangilang.</p>}</CatalogReadState>
  </MaterialDialog>
}
function RecoveryControls({ error, pending, onRecover, onLoad }: { error: unknown; pending: boolean; onRecover: (error: MaterialSaveUnknown) => void; onLoad: (snapshot: MaterialCatalogSnapshot) => void }) {
  const current = error instanceof MaterialCatalogConflict || error instanceof MaterialSaveUnknown ? error.current : undefined
  return <div className="space-y-3"><MaterialError error={error} />
    {current && <p className="text-xs text-muted-foreground">Serverdagi joriy ro‘yxatda {current.materials.length} ta material bor.</p>}
    {(current || error instanceof MaterialSaveUnknown) && <div className="flex flex-wrap gap-2">{error instanceof MaterialSaveUnknown && <Button type="button" variant="outline" disabled={pending} onClick={() => onRecover(error)}>Serverdagi saqlashni tekshirish</Button>}{current && <Button type="button" variant="outline" disabled={pending} onClick={() => onLoad(current)}>Joriy nusxani yuklash</Button>}</div>}
  </div>
}
function formVariantGsm(density: string, variant: MaterialVariantForm): number | undefined {
  try {
    const micron = Number(variant.micron)
    if (!Number.isInteger(micron) || micron <= 0) return undefined
    const value = variant.mode === 'density' ? micron * parseMaterialDecimal(density, 'Zichlik', true) : parseMaterialDecimal(variant.value, 'Qiymat')
    const gsm = variant.mode === 'coefficient' ? coefficientToGsm(value) : value
    return Number.isFinite(gsm) && gsm > 0 ? gsm : undefined
  } catch { return undefined }
}
function MaterialFormEditor({ initial, snapshot, onSaved, onClose }: { initial?: CatalogMaterial; snapshot: MaterialCatalogSnapshot; onSaved?: SavedCallback; onClose: () => void }) {
  const id = useId(), counter = useRef(0), write = useMaterialWrite(`material:${initial?.id ?? 'new'}`, onSaved)
  const [baseline, setBaseline] = useState(snapshot), [form, setForm] = useState<MaterialForm>(() => materialFormFrom(initial))
  const [validation, setValidation] = useState('')
  const blocked = write.pending || write.error instanceof MaterialSaveUnknown || write.error instanceof MaterialCatalogConflict
  function setVariant(key: string, patch: Partial<MaterialVariantForm>) { setForm(previous => ({ ...previous, variants: previous.variants.map(variant => variant.key === key ? { ...variant, ...patch } : variant) })) }
  function changeMode(variant: MaterialVariantForm, mode: MaterialVariantForm['mode']) {
    const gsm = formVariantGsm(form.density, variant)
    setVariant(variant.key, { mode, value: mode === 'density' ? '' : gsm === undefined ? '' : String(mode === 'gsm' ? gsm : gsmToCoefficient(gsm)) })
  }
  function loadCurrent(current: MaterialCatalogSnapshot) {
    const material = initial ? current.materials.find(material => material.id === initial.id) : undefined
    if (initial && !material) { setValidation('Material joriy ro‘yxatda topilmadi. Tahrirni yoping va ro‘yxatni yangilang.'); return }
    setBaseline(current); setForm(materialFormFrom(material)); setValidation(''); write.setError(null)
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (blocked) return
    try {
      const draft = materialInputFromForm(form)
      setValidation('')
      void write.run((api, signal) => api.save(baseline, draft, signal), onClose)
    } catch (error) { setValidation(materialCatalogError(error)) }
  }
  return <form className="space-y-5" onSubmit={submit} noValidate aria-busy={write.pending}>
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-name`}>Material nomi</Label><Input id={`${id}-name`} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} autoComplete="off" disabled={write.pending} required /></div><div className="space-y-2"><Label htmlFor={`${id}-density`}>Zichlik, g/cm³</Label><Input id={`${id}-density`} inputMode="decimal" value={form.density} onChange={event => setForm({ ...form, density: event.target.value })} disabled={write.pending} placeholder="0,905" /><p className="text-xs text-muted-foreground">Zichlik barcha musbat mikronlarni hisoblash uchun ishlatiladi. Haqiqiy GSM qiymati undan ustun turadi.</p></div></div>
    <Label htmlFor={`${id}-active`} className="flex items-center gap-3"><Checkbox id={`${id}-active`} checked={form.active} disabled={write.pending} onCheckedChange={checked => setForm({ ...form, active: checked === true })} /><span>Hisoblash uchun tanlovda ko‘rsatish</span></Label>
    <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">Mikron variantlari</p><Button type="button" variant="outline" size="sm" disabled={write.pending || !form.variants.length || !(Number(form.density.replace(',', '.')) > 0)} onClick={() => setForm({ ...form, variants: form.variants.map(variant => ({ ...variant, mode: 'density', value: '' })) })}>Barchasiga zichlikni qo‘llash</Button></div>
      {!form.variants.length && <p className="text-sm text-muted-foreground">Mikronlar yo‘q. Zichlik kiritilsa, mikron variantlarisiz ham saqlash mumkin.</p>}
      {form.variants.map((variant, index) => {
        const gsm = formVariantGsm(form.density, variant)
        return <fieldset key={variant.key} className="space-y-3 rounded-xl border p-3" disabled={write.pending}><legend className="px-1 text-xs text-muted-foreground">{index + 1}-variant</legend><div className="grid gap-3 sm:grid-cols-[100px_1fr_1fr_auto]">
          <div className="space-y-2"><Label htmlFor={`${id}-${variant.key}-micron`}>Mikron</Label><Input id={`${id}-${variant.key}-micron`} inputMode="numeric" value={variant.micron} onChange={event => setVariant(variant.key, { micron: event.target.value })} disabled={write.pending} /></div>
          <div className="space-y-2"><Label htmlFor={`${id}-${variant.key}-mode`}>Hisoblash usuli</Label><Select value={variant.mode} onValueChange={value => changeMode(variant, value as MaterialVariantForm['mode'])} disabled={write.pending}><SelectTrigger id={`${id}-${variant.key}-mode`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="density">Zichlik bo‘yicha</SelectItem><SelectItem value="gsm">Haqiqiy GSM</SelectItem><SelectItem value="coefficient">Koeffitsiyent</SelectItem></SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor={`${id}-${variant.key}-value`}>{variant.mode === 'coefficient' ? 'Koeffitsiyent' : 'GSM, g/m²'}</Label><Input id={`${id}-${variant.key}-value`} inputMode="decimal" value={variant.mode === 'density' ? gsm === undefined ? '' : String(gsm) : variant.value} onChange={event => setVariant(variant.key, { value: event.target.value })} readOnly={variant.mode === 'density'} disabled={write.pending} /></div>
          <Button type="button" variant="ghost" size="icon" className="sm:mt-7" aria-label={`${index + 1}-mikronni olib tashlash`} disabled={write.pending} onClick={() => setForm({ ...form, variants: form.variants.filter(item => item.key !== variant.key) })}><Trash2 /></Button>
        </div><p className="text-xs text-muted-foreground">GSM: {displayNumber(gsm)} · Koeffitsiyent: {displayNumber(gsm === undefined ? undefined : gsmToCoefficient(gsm))}</p></fieldset>
      })}
      <Button type="button" variant="outline" disabled={write.pending} onClick={() => { counter.current += 1; setForm({ ...form, variants: [...form.variants, { key: `new-${counter.current}`, micron: '', mode: Number(form.density.replace(',', '.')) > 0 ? 'density' : 'gsm', value: '' }] }) }}><Plus />Mikron qo‘shish</Button>
    </div>
    {validation && <MaterialError error={new Error(validation)} />}
    <RecoveryControls error={write.error} pending={write.pending} onRecover={error => void write.run((api, signal) => api.recover(error.operation, signal), onClose)} onLoad={loadCurrent} />
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Bekor qilish</Button><Button type="submit" disabled={blocked || !form.name.trim()}><SaveLabel pending={write.pending} /></Button></DialogFooter>
  </form>
}

function MaterialVisibilityDialog({ materialId, active, onSaved, onRemoved, onClose }: { materialId: string; active: boolean; onSaved?: SavedCallback; onRemoved?: SavedCallback; onClose: () => void }) {
  const catalog = useCatalogForEditor()
  const material = catalog.data?.materials.find(material => material.id === materialId)
  return <MaterialDialog title={active ? 'Materialni hisoblashda ko‘rsatish' : 'Materialni hisoblashda yashirish'} description={active ? 'Material hisoblashda tanlash uchun yana ko‘rinadi.' : 'Material hisoblash tanlovidan yashiriladi. Keyin uni qayta ko‘rsatish mumkin.'} onClose={onClose}><CatalogReadState pending={catalog.isPending || catalog.isFetching} error={catalog.error} retry={() => void catalog.refetch()}>{catalog.data && material ? <MaterialVisibilityForm initial={material} snapshot={catalog.data} active={active} onSaved={onSaved} onRemoved={onRemoved} onClose={onClose} /> : <p className="text-sm text-muted-foreground">Material topilmadi.</p>}</CatalogReadState></MaterialDialog>
}
function MaterialVisibilityForm({ initial, snapshot, active, onSaved, onRemoved, onClose }: { initial: CatalogMaterial; snapshot: MaterialCatalogSnapshot; active: boolean; onSaved?: SavedCallback; onRemoved?: SavedCallback; onClose: () => void }) {
  const write = useMaterialWrite(`material:${initial.id}:visibility`, onSaved)
  const [baseline, setBaseline] = useState(snapshot), [material, setMaterial] = useState(initial)
  const changed = material.active === active
  const finish = () => { if (!active) onRemoved?.(); onClose() }
  function loadCurrent(current: MaterialCatalogSnapshot) {
    const material = current.materials.find(material => material.id === initial.id)
    if (!material) return
    setBaseline(current); setMaterial(material); write.setError(null)
  }
  return <div className="space-y-4"><p className="font-medium">{material.name}</p><MaterialVariants material={material} />{changed && <p className="text-sm text-muted-foreground">Material allaqachon {active ? 'faol' : 'yashirilgan'}.</p>}
    <RecoveryControls error={write.error} pending={write.pending} onRecover={error => void write.run((api, signal) => api.recover(error.operation, signal), finish)} onLoad={loadCurrent} />
    <DialogFooter><Button variant="outline" onClick={onClose}>Bekor qilish</Button><Button variant={active ? 'default' : 'outline'} disabled={write.pending || changed || write.error instanceof MaterialSaveUnknown || write.error instanceof MaterialCatalogConflict} onClick={() => void write.run((api, signal) => api.save(baseline, { ...material, active }, signal), finish)}><SaveLabel pending={write.pending} label={active ? 'Hisoblashda ko‘rsatish' : 'Yashirishni tasdiqlash'} /></Button></DialogFooter>
  </div>
}
function MaterialSequenceDialog({ onSaved, onClose }: { onSaved?: SavedCallback; onClose: () => void }) {
  const catalog = useCatalogForEditor()
  return <MaterialDialog title="Materiallar tartibi" description="Faol materiallarni yuqoriga yoki pastga ko‘chiring. Yashirilgan materiallar ro‘yxat oxirida qoladi." onClose={onClose}><CatalogReadState pending={catalog.isPending || catalog.isFetching} error={catalog.error} retry={() => void catalog.refetch()}>{catalog.data && <MaterialSequenceForm snapshot={catalog.data} onSaved={onSaved} onClose={onClose} />}</CatalogReadState></MaterialDialog>
}
function MaterialSequenceForm({ snapshot, onSaved, onClose }: { snapshot: MaterialCatalogSnapshot; onSaved?: SavedCallback; onClose: () => void }) {
  const write = useMaterialWrite('material-sequence', onSaved)
  const [baseline, setBaseline] = useState(snapshot), [ids, setIds] = useState(snapshot.materials.filter(material => material.active).map(material => material.id))
  const same = JSON.stringify(ids) === JSON.stringify(baseline.materials.filter(material => material.active).map(material => material.id))
  const blocked = write.pending || write.error instanceof MaterialSaveUnknown || write.error instanceof MaterialCatalogConflict
  function move(index: number, delta: number) {
    if (blocked || index + delta < 0 || index + delta >= ids.length) return
    const next = [...ids]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; setIds(next)
  }
  function loadCurrent(current: MaterialCatalogSnapshot) { setBaseline(current); setIds(current.materials.filter(material => material.active).map(material => material.id)); write.setError(null) }
  return <div className="space-y-4" aria-busy={write.pending}>{!ids.length && <p className="text-sm text-muted-foreground">Faol materiallar yo‘q.</p>}<ol className="max-h-96 space-y-2 overflow-y-auto">{ids.map((id, index) => {
    const material = baseline.materials.find(material => material.id === id)!
    return <li key={id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="flex min-w-0 items-center gap-3"><Badge variant="secondary">{index + 1}</Badge><span className="break-words text-sm font-medium">{material.name}</span></div><div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" aria-label={`${material.name} yuqoriga ko‘chirish`} disabled={blocked || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button><Button variant="ghost" size="icon" aria-label={`${material.name} pastga ko‘chirish`} disabled={blocked || index === ids.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button></div></li>
  })}</ol><p className="text-xs text-muted-foreground">{baseline.materials.filter(material => !material.active).length} ta yashirilgan materialning tartibi saqlanadi.</p>
    <RecoveryControls error={write.error} pending={write.pending} onRecover={error => void write.run((api, signal) => api.recover(error.operation, signal), onClose)} onLoad={loadCurrent} />
    <DialogFooter><Button variant="outline" onClick={onClose}>Bekor qilish</Button><Button disabled={blocked || same || ids.length < 2} onClick={() => void write.run((api, signal) => api.reorder(baseline, ids, signal), onClose)}><SaveLabel pending={write.pending} /></Button></DialogFooter>
  </div>
}
