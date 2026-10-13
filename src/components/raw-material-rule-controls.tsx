import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import { MutationScope } from '@/lib/mutation-scope'
import type { MutationLease } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import {
  materialPolicyGroups, materialRuleCommand, materialRuleDrafts, MaterialRuleMutationError,
  rawMaterialRuleGroups, rawMaterialRulePermissions, rawMaterialRuleSnapshot, rawMaterialRules,
  reconcileMaterialRuleCommand, saveMaterialRuleCommand,
} from '@/lib/raw-material-rules'
import type { MaterialRuleCommand, MaterialRuleDraft, MaterialRuleLease, MaterialRuleMode, MaterialRuleProjection } from '@/lib/raw-material-rules'

const modes: Record<MaterialRuleMode, string> = { not_required: 'Material majburiy emas', all_required: 'Barcha guruhlar talab qilinadi', requirement_sets: 'Talab to‘plamlari' }
const operationLabels: Record<string, string> = { print: 'Bosma', laminate: 'Laminatsiya', cut: 'Kesish', package: 'Paket tayyorlash', glue: 'Yelimlash' }
const message = (value: unknown) => value instanceof Error ? value.message : 'Qoidani tekshirish yoki saqlash bajarilmadi.'
function Notice({ children }: { children: React.ReactNode }) { return <p className="text-sm text-muted-foreground">{children}</p> }
function Failure({ error, retry }: { error: Error; retry: () => void }) { return <Alert variant="destructive">
      <AlertDescription className="space-y-2">
      <p>{error.message}</p>
      <Button type="button" size="sm" variant="outline" onClick={retry}>Qayta yuklash</Button>
      </AlertDescription>
      </Alert> }
function PolicySummary({ rule }: { rule: MaterialRuleProjection }) {
  return <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2">
      <p className="font-medium">{modes[rule.policy.mode]}</p>
      <Badge variant="secondary">Revision {rule.source_revision}</Badge>
      </div>{rule.policy.mode === 'requirement_sets' ? <ul className="space-y-1">{rule.policy.sets.map(set => <li key={set.requirement_id}>{set.requirement_id}: {set.item_group_ids.join(' yoki ')} · Kamida {set.minimum_required_count}</li>)}</ul> : <p>{materialPolicyGroups(rule.policy).join(', ') || 'Material guruhlari tanlanmagan.'}</p>}<p className="text-xs text-muted-foreground">{rule.tooling.mode === 'qolip_scan_required' ? `Qolip skani talab qilinadi · ${rule.tooling.tooling_class_id}` : 'Qolip skani talab qilinmaydi.'}</p>
      </div>
}
function CommandSummary({ command }: { command: MaterialRuleCommand }) {
  return <div className="space-y-2">
      <p className="text-sm font-medium">{command.baseline.name} · {operationLabels[command.baseline.operation]}</p>
      <PolicySummary rule={{ ...command.baseline.rule, policy: command.body.material }} />
      <Notice>Qolip siyosati va apparatning boshqa sozlamalari saqlanadi.</Notice>
      </div>
}
function GroupPicker({ selected, options, label, disabled, onChange }: { selected: string[]; options: string[]; label: string; disabled: boolean; onChange: (ids: string[]) => void }) {
  return <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>{options.length ? <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border p-3">{options.map(id => <label className="flex items-start gap-2 text-sm" key={id}>
      <Checkbox checked={selected.includes(id)} disabled={disabled} onCheckedChange={value => onChange(value === true ? [...selected.filter(value => value !== id), id] : selected.filter(value => value !== id))} />
      <span className="break-words">{id}</span>
      </label>)}</div> : <Notice>Tanlash uchun material guruhi mavjud emas.</Notice>}</fieldset>
}

/** Mount on raw-materials; native rule permission remains independent of stock read/assignment. */
export function RawMaterialRuleToolbar({ onSaved }: { onSaved?: () => void } = {}) {
  const { scope } = useSession()
  materialRuleDrafts.activate(scope)
  return <RuleManagement key={scope} onSaved={onSaved} />
}
function RuleManagement({ onSaved }: { onSaved?: () => void }) {
  const { client, session, scope, demo, connection } = useSession()
  const queryClient = useQueryClient(), permissions = rawMaterialRulePermissions(session)
  useSyncExternalStore(materialRuleDrafts.subscribe, materialRuleDrafts.getRevision, materialRuleDrafts.getRevision)
  const editor = materialRuleDrafts.get(scope)
  const [open, setOpen] = useState(false), [selectedId, setSelectedId] = useState(() => materialRuleDrafts.selection(scope))
  const [review, setReview] = useState<MaterialRuleCommand | null>(null), [error, setError] = useState(''), [reloading, setReloading] = useState(false)
  const [mutations] = useState(() => new MutationScope())
  const running = useRef<MaterialRuleLease | null>(null), reloadLease = useRef<MutationLease | null>(null), inFlight = useRef(false), currentScope = useRef(scope)
  currentScope.current = scope
  const enabled = Boolean(open && client && session && permissions.manage && !demo)
  const rules = useQuery({ queryKey: ['raw-material-rules', scope, 'list'], queryFn: ({ signal }) => rawMaterialRules(client!, signal), enabled, retry: false, staleTime: 5_000 })
  const snapshot = useQuery({ queryKey: ['raw-material-rules', scope, 'snapshot', selectedId], queryFn: ({ signal }) => rawMaterialRuleSnapshot(client!, selectedId, signal), enabled: Boolean(enabled && permissions.apparatus && selectedId), retry: false, staleTime: 5_000 })
  const groups = useQuery({ queryKey: ['raw-material-rules', scope, 'groups'], queryFn: ({ signal }) => rawMaterialRuleGroups(client!, signal), enabled: enabled && permissions.groups, retry: false, staleTime: 5_000 })
  const options = groups.data ?? []
  useEffect(() => {
    if (!enabled || selectedId || !rules.data?.length || editor) return
    const id = rules.data[0].apparatus_id
    materialRuleDrafts.choose(scope, id); setSelectedId(id)
  }, [enabled, selectedId, rules.data, editor, scope])
  useEffect(() => { if (enabled && snapshot.data && !snapshot.isError && selectedId === snapshot.data.rule.apparatus_id && materialRuleDrafts.selection(scope) === selectedId && !materialRuleDrafts.get(scope)) materialRuleDrafts.select(scope, snapshot.data) }, [enabled, snapshot.data, snapshot.isError, selectedId, scope])
  useEffect(() => { if (editor && editor.snapshot.rule.apparatus_id !== selectedId && ['pending', 'uncertain'].includes(editor.phase)) { setSelectedId(editor.snapshot.rule.apparatus_id); setReview(null) } }, [editor, selectedId])
  useEffect(() => () => { mutations.cancelAll(); if (running.current) materialRuleDrafts.interrupt(running.current) }, [mutations])
  const pending = editor?.phase === 'pending', uncertain = editor?.phase === 'uncertain', confirmed = editor?.phase === 'confirmed'
  const locked = Boolean(pending || uncertain || confirmed || editor?.phase === 'conflict')
  const stale = Boolean(editor && snapshot.data && (editor.snapshot.rule.source_revision !== snapshot.data.rule.source_revision || editor.snapshot.rule.source_aasx_sha256 !== snapshot.data.rule.source_aasx_sha256))
  const fresh = Boolean(editor && snapshot.data && !stale && editor.snapshot.active && !snapshot.isError && !snapshot.isFetching && !rules.isError && !rules.isFetching && Date.now() - snapshot.dataUpdatedAt < 30_000 && (!permissions.groups || groups.data && !groups.isError && !groups.isFetching && Date.now() - groups.dataUpdatedAt < 30_000))
  const canOperate = Boolean(client && permissions.manage && permissions.apparatus && !demo && connection !== 'offline')
  const ready = Boolean(canOperate && fresh && !locked && !reloading)
  const knownGroups = editor ? materialPolicyGroups(editor.snapshot.rule.policy) : []
  const choices = [...new Set([...options, ...knownGroups])].sort()
  let preview: MaterialRuleCommand | null = null, issue = ''
  if (editor && !locked) try { preview = materialRuleCommand(editor.snapshot, editor.draft, session, options, 'preview-only') } catch (caught) { issue = message(caught) }
  function refresh() { void queryClient.invalidateQueries({ queryKey: ['raw-material-rules', scope] }) }
  function invalidate() {
    refresh()
    for (const key of [['resource', scope, 'raw-materials'], ['detail', scope, 'raw-materials'], ['resource', scope, 'apparatus'], ['detail', scope, 'apparatus'], ['apparatus-admin-source', scope], ['apparatus-admin-create-catalog', scope], ['raw-material-admin', scope], [scope, 'production-snapshot'], [scope, 'production-control-apparatus'], ['wip-admin', scope, 'apparatus'], ['apparatus-planning', scope]]) void queryClient.invalidateQueries({ queryKey: key })
  }
  function close(value: boolean) {
    if (!value) { mutations.cancelAll(); if (running.current) materialRuleDrafts.interrupt(running.current); running.current = null; reloadLease.current = null; inFlight.current = false; setReloading(false); setReview(null) }
    setOpen(value)
  }
  function choose(id: string) { try { materialRuleDrafts.choose(scope, id); setSelectedId(id); setReview(null); setError('') } catch (caught) { setError(message(caught)) } }
  function change(draft: MaterialRuleDraft) { try { materialRuleDrafts.edit(scope, draft); setReview(null); setError('') } catch (caught) { setError(message(caught)) } }
  async function reloadCurrent() {
    if (!client || !canOperate || !selectedId || pending || uncertain || inFlight.current) return
    const lease = mutations.begin(), requestScope = scope
    reloadLease.current = lease; inFlight.current = true; setReloading(true)
    try {
      const current = await rawMaterialRuleSnapshot(client, selectedId, lease.controller.signal)
      if (!mutations.isCurrent(lease) || currentScope.current !== requestScope) return
      materialRuleDrafts.rebase(scope, current); setReview(null); setError(''); refresh()
    } catch (caught) { if (mutations.isCurrent(lease) && currentScope.current === requestScope) setError(message(caught)) }
    finally { mutations.finish(lease); if (reloadLease.current === lease) { reloadLease.current = null; inFlight.current = false; if (currentScope.current === requestScope && mutations.isCurrent(lease)) setReloading(false) } }
  }
  async function run(command: MaterialRuleCommand, action: 'save' | 'read' | 'retry') {
    if (!client || !session || demo || !permissions.manage || !permissions.apparatus || inFlight.current || connection === 'offline') return
    let retained: MaterialRuleLease
    try { retained = materialRuleDrafts.begin(scope, command, action !== 'save') } catch (caught) { setError(message(caught)); return }
    const lease = mutations.begin(), requestScope = scope, requestClient = client, requestSession = session
    const current = () => mutations.isCurrent(lease) && currentScope.current === requestScope
    running.current = retained; inFlight.current = true; setError('')
    try {
      const observed = action === 'save' ? null : await reconcileMaterialRuleCommand(requestClient, command, lease.controller.signal)
      if (observed?.state === 'superseded') { materialRuleDrafts.finish(retained, { superseded: observed.current }); if (current()) { setReview(null); refresh() }; return }
      const saved = observed?.state === 'confirmed' ? { rule: observed.current.rule, snapshot: observed.current, observed: true } : action === 'read' ? null : await saveMaterialRuleCommand(requestClient, requestSession, command, lease.controller.signal, () => materialRuleDrafts.dispatched(retained))
      materialRuleDrafts.finish(retained, saved ? { result: saved } : { error: 'Server hali avvalgi revisionni qaytarmoqda. Yuborilgan so‘rov yo‘qligi tasdiqlanmadi; yangi amal qulflangan.', uncertain: true })
      if (!current()) return
      setReview(null); invalidate()
      if (saved) { toast.success(saved.observed ? 'Qoidaning joriy qiymatlari serverda tasdiqlandi.' : 'Qoida canonical revisionda saqlandi.'); onSaved?.() }
    } catch (caught) {
      materialRuleDrafts.finish(retained, { error: message(caught), uncertain: caught instanceof MaterialRuleMutationError && caught.uncertain })
      if (current()) { setError(message(caught)); setReview(null); refresh() }
    } finally {
      mutations.finish(lease)
      if (running.current === retained) { running.current = null; inFlight.current = false }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!editor || !ready || !preview) return
    if (review) { void run(review, 'save'); return }
    try { setReview(materialRuleCommand(editor.snapshot, editor.draft, session, options)) } catch (caught) { setError(message(caught)) }
  }
  const idPrefix = useId()
  const shownError = error || editor?.error || ''
  if (!permissions.manage) return <Notice>Xomashyo qoidalarini o‘qish va boshqarish uchun raw_material.rule.manage ruxsati kerak.</Notice>
  return <div className="space-y-2">
      <Button type="button" variant="outline" disabled={!client || demo} onClick={() => { setSelectedId(materialRuleDrafts.selection(scope)); setOpen(true); refresh() }}>
      <Settings2 />Xomashyo qoidalari</Button>{demo && <Notice>Ko‘rish rejimida qoidalar o‘zgartirilmaydi.</Notice>}{uncertain && <Notice>Avvalgi qoida saqlash natijasi aniqlanmagan · {editor?.snapshot.rule.apparatus_id}. Yangi amal qulflangan; oynani ochib server holatini tekshiring.</Notice>}<Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
      <DialogTitle>Xomashyo qoidalari</DialogTitle>
      <DialogDescription>Tanlangan apparatning material guruhlari va boshlash talablari. Talabni olib tashlash apparat yoki uning boshqa sozlamalarini o‘chirmaydi.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>{rules.isPending && <Skeleton className="h-20 w-full" />}{rules.isError && <Failure error={rules.error} retry={() => void rules.refetch()} />}{rules.data && !rules.isError && <div className="space-y-2">
      <Label>Canonical apparat</Label>{rules.data.length ? <Select value={editor?.snapshot.rule.apparatus_id ?? selectedId} onValueChange={choose} disabled={Boolean(pending || uncertain)}>
      <SelectTrigger className="w-full" aria-label="Canonical apparat">
      <SelectValue placeholder="Apparatni tanlang" />
      </SelectTrigger>
      <SelectContent>{rules.data.map(rule => <SelectItem key={rule.apparatus_id} value={rule.apparatus_id}>{rule.apparatus_id} · {modes[rule.policy.mode]}</SelectItem>)}</SelectContent>
      </Select> : <Notice>Canonical apparat qoidalari mavjud emas.</Notice>}</div>}{!permissions.apparatus && <Notice>Apparatning faol holati va operatsiyasini o‘qish uchun ruxsat kerak. Qoidalar ro‘yxati mavjud; saqlash qulflangan.</Notice>}{permissions.apparatus && selectedId && snapshot.isPending && <Skeleton className="h-24 w-full" />}{snapshot.isError && <Failure error={snapshot.error} retry={() => void snapshot.refetch()} />}{snapshot.data && !snapshot.isError && <div className="space-y-2">
      <p className="font-medium">{snapshot.data.name} · {operationLabels[snapshot.data.operation]}</p>
      <PolicySummary rule={snapshot.data.rule} />{!snapshot.data.active && <Notice>Apparat foydalanishdan chiqarilgan; material qoidasi tahrirlanmaydi.</Notice>}</div>}{stale && !uncertain && <Notice>Draft saqlangan, ammo serverdagi apparat revision’i o‘zgargan. Joriy qoidani yuklang va tahrirni qayta ko‘rib chiqing.</Notice>}{editor && !locked && !snapshot.isError && <>
      <div className="space-y-2">
      <Label>Material talabi</Label>
      <Select value={editor.draft.mode} disabled={!ready} onValueChange={value => change({ ...editor.draft, mode: value as MaterialRuleMode, sets: value === 'requirement_sets' && !editor.draft.sets.length ? [{ id: '', groupIds: [...editor.draft.groupIds], minimum: '1' }] : editor.draft.sets })}>
      <SelectTrigger className="w-full" aria-label="Material talabi">
      <SelectValue />
      </SelectTrigger>
      <SelectContent>{Object.entries(modes).map(([mode, label]) => <SelectItem key={mode} value={mode}>{label}</SelectItem>)}</SelectContent>
      </Select>
      </div>{!permissions.groups ? <Notice>Yangi material guruhlarini tanlash uchun guruhlar ro‘yxatini o‘qish ruxsati kerak. Saqlangan guruhlarni shu apparatda saqlab qolish yoki olib tashlash mumkin.</Notice> : <>{groups.isPending && <Skeleton className="h-16 w-full" />}{groups.isError && <Failure error={groups.error} retry={() => void groups.refetch()} />}{groups.data && !options.length && <Notice>Homashyo bo‘limining material guruhlari mavjud emas.</Notice>}</>}{knownGroups.some(id => !options.includes(id)) && permissions.groups && groups.data && <Notice>Ba’zi saqlangan guruhlar joriy Homashyo ro‘yxatida yo‘q. Ular belgilangan holda saqlanadi; yangi guruhlar joriy ro‘yxatdan tanlanadi.</Notice>}{editor.draft.mode === 'requirement_sets' ? <div className="space-y-3">{editor.draft.sets.map((set, index) => <fieldset className="space-y-3 rounded-lg border p-3" key={index}>
      <legend className="px-1 text-sm font-medium">{index + 1}-talab to‘plami</legend>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
      <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-name-${index}`}>Talab identifikatori</Label>
      <Input id={`${idPrefix}-name-${index}`} value={set.id} maxLength={512} disabled={!ready} onChange={event => change({ ...editor.draft, sets: editor.draft.sets.map((value, i) => i === index ? { ...value, id: event.target.value } : value) })} />
      </div>
      <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-count-${index}`}>Kamida nechta</Label>
      <Input id={`${idPrefix}-count-${index}`} type="number" min="1" max={Math.min(65535, set.groupIds.length) || 1} step="1" value={set.minimum} disabled={!ready} onChange={event => change({ ...editor.draft, sets: editor.draft.sets.map((value, i) => i === index ? { ...value, minimum: event.target.value } : value) })} />
      </div>
      </div>
      <GroupPicker label="Mos material guruhlari" options={choices} selected={set.groupIds} disabled={!ready} onChange={ids => change({ ...editor.draft, sets: editor.draft.sets.map((value, i) => i === index ? { ...value, groupIds: ids } : value) })} />
      <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => change({ ...editor.draft, sets: editor.draft.sets.filter((_, i) => i !== index) })}>
      <Trash2 />Talab to‘plamini olib tashlash</Button>
      </fieldset>)}<Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => change({ ...editor.draft, sets: [...editor.draft.sets, { id: '', groupIds: [], minimum: '1' }] })}>
      <Plus />Talab to‘plami qo‘shish</Button>
      </div> : <>
      <GroupPicker label={editor.draft.mode === 'not_required' ? 'Ruxsatli guruhlar (ixtiyoriy)' : 'Talab qilinadigan guruhlar'} options={choices} selected={editor.draft.groupIds} disabled={!ready} onChange={ids => change({ ...editor.draft, groupIds: ids })} />{editor.draft.mode === 'not_required' && <Notice>Material majburiyligi olib tashlanadi. Tanlangan ixtiyoriy guruhlar va qolip siyosati saqlanadi.</Notice>}</>}{issue && <Notice>{issue}</Notice>}</>}{shownError && <Alert variant="destructive">
      <AlertDescription>{shownError}</AlertDescription>
      </Alert>}{(pending || reloading) && <p className="flex items-center gap-2 text-sm" aria-live="polite">
      <Loader2 className="size-4 animate-spin" />Canonical holat tekshirilmoqda…</p>}{uncertain && editor.command && <div className="space-y-3">
      <CommandSummary command={editor.command} />
      <Notice>Avvalgi so‘rov va revision sharti saqlangan. Yangi qoida yuborishdan oldin natijani tekshiring.</Notice>
      <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => void run(editor.command!, 'read')}>
      <RefreshCw />Server holatini tekshirish</Button>
      <Button type="button" variant="outline" disabled={!canOperate || pending} onClick={() => setReview(editor.command!)}>Avvalgi so‘rovni ko‘rib chiqish</Button>
      </div>
      </div>}{review && <Alert>
      <AlertDescription className="space-y-3">
      <p className="font-medium">Saqlanadigan qoida</p>
      <CommandSummary command={review} />{uncertain && <Notice>Aynan avvalgi so‘rov o‘sha revision sharti bilan yuboriladi. Server revision o‘zgargan bo‘lsa uni rad etadi.</Notice>}</AlertDescription>
      </Alert>}{confirmed && editor.result && <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm">
      <CheckCircle2 className="size-4" />{editor.result.observed ? 'Qoidaning joriy qiymatlari server o‘qishida tasdiqlandi.' : 'Qoida canonical revisionda saqlandi.'}</p>
      <PolicySummary rule={editor.result.rule} />
      </div>}{(stale || confirmed || editor?.phase === 'conflict') && <Button type="button" variant="outline" disabled={Boolean(pending || uncertain || reloading) || !canOperate} onClick={() => void reloadCurrent()}>Joriy qoidani yuklash</Button>}<DialogFooter>
      <Button type="button" variant="outline" onClick={() => close(false)}>Yopish</Button>{uncertain && review ? <Button type="button" disabled={pending || !canOperate} onClick={() => void run(review, 'retry')}>Avvalgi so‘rovni aynan yuborish</Button> : !locked && <Button type="submit" disabled={!ready || !preview}>{review ? 'Tasdiqlash va saqlash' : 'Qoidani ko‘rib chiqish'}</Button>}</DialogFooter>
      </form>
      </DialogContent>
      </Dialog>
      </div>
}
