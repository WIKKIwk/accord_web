import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2, Loader2, Pencil, Plus, ShieldCheck, Trash2, Warehouse } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { ResourceKind, Row } from '@/lib/api-types'
import {
  AdminIdentityApi, WorkerRemovalConflict, assignmentForIdentity, canAssignIdentityRole, canReadIdentityItemGroups,
  identityErrorMessage, isCurrentIdentity, ownRoleAccessPreserved, resolveAdminIdentity, roleFromRow, warehouseAssigneeAllowed,
  warehouseAssignmentKey, workerLevels,
} from '@/lib/admin-identity'
import type { AdminIdentity, IdentityAssignment, IdentityDetail, IdentityRole, ScopeCatalog, ScopeChoice, WarehouseIdentityAssignment, WorkerRemovalCheck } from '@/lib/admin-identity'
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

type SavedCallback = () => void
function useIdentityApi() {
  const session = useSession()
  const api = useMemo(() => session.client && session.session && !session.demo ? new AdminIdentityApi(session.client, session.session) : null, [session.client, session.session, session.demo])
  return { ...session, api }
}

/** A closed dialog, changed record, or changed session cannot publish a late write. */
function useIdentityWrite(identityKey: string, onSaved?: SavedCallback) {
  const { api, scope } = useIdentityApi()
  const queryClient = useQueryClient()
  const [mutations] = useState(() => new MutationScope())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const busy = useRef(false)
  const currentKey = useRef(`${scope}:${identityKey}`)
  currentKey.current = `${scope}:${identityKey}`
  useEffect(() => () => mutations.cancelAll(), [mutations, scope, identityKey])
  async function run<T>(execute: (api: AdminIdentityApi, signal: AbortSignal) => Promise<T>, success?: (value: T) => void): Promise<void> {
    if (busy.current) return
    if (!api) { setError(new Error('Ko‘rish rejimida amal bajarilmaydi.')); return }
    busy.current = true
    setPending(true); setError(null)
    const key = currentKey.current, lease = mutations.begin()
    try {
      const result = await execute(api, lease.controller.signal)
      if (key !== currentKey.current || !mutations.isCurrent(lease)) return
      success?.(result)
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(scope) })
      onSaved?.()
      toast.success('O‘zgarish saqlandi.')
    } catch (error) {
      if (key === currentKey.current && mutations.isCurrent(lease)) setError(error)
    } finally {
      mutations.finish(lease)
      if (key === currentKey.current && !lease.controller.signal.aborted) {
        busy.current = false; setPending(false)
      }
    }
  }
  return { pending, error, setError, run }
}
function WriteError({ error }: { error: unknown }) {
  return error ? <Alert variant="destructive" role="alert"><AlertDescription>{identityErrorMessage(error)}</AlertDescription></Alert> : null
}
function ReadStatus({ pending, error, retry, children }: { pending: boolean; error: unknown; retry: () => void; children: ReactNode }) {
  if (pending) return <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Ma’lumot yuklanmoqda…</p>
  if (error) return <div className="space-y-3"><WriteError error={error} />{!(error instanceof ApiError && error.status === 403) && <Button variant="outline" onClick={retry}>Qayta urinish</Button>}</div>
  return children
}
function EditorDialog({ title, description, onClose, pending = false, children }: { title: string; description: string; onClose: () => void; pending?: boolean; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl" aria-busy={pending}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {children}
    </DialogContent>
  </Dialog>
}
function SubmitLabel({ pending, label = 'Saqlash' }: { pending: boolean; label?: string }) { return <>{pending && <Loader2 className="size-4 animate-spin" />}{pending ? 'Saqlanmoqda…' : label}</> }
function BoundedNotice({ catalog }: { catalog?: ScopeCatalog }) {
  return catalog?.bounded ? <p className="text-xs text-muted-foreground">Ro‘yxatning bir qismi ko‘rsatilmoqda. Kerakli tanlovni qidiruv orqali toping.</p> : null
}
function ChoiceChecklist({ title, choices, selected, onChange, disabled, search, onSearch, bounded = false }: {
  title: string; choices: ScopeChoice[]; selected: string[]; onChange: (values: string[]) => void; disabled: boolean;
  search?: string; onSearch?: (value: string) => void; bounded?: boolean;
}) {
  const id = useId()
  const missing = selected.filter(value => !choices.some(choice => choice.value === value))
  return <fieldset className="space-y-3" disabled={disabled}>
    <legend className="text-sm font-medium">{title}</legend>
    {onSearch && <Input aria-label={`${title} qidirish`} placeholder="Qidirish…" value={search ?? ''} onChange={event => onSearch(event.target.value)} disabled={disabled} />}
    {bounded && <p className="text-xs text-muted-foreground">Barcha tanlovlarni topish uchun qidiruvdan foydalaning.</p>}
    <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2">
      {!choices.length && !missing.length && <p className="p-2 text-sm text-muted-foreground">Mos ma’lumot topilmadi.</p>}
      {[...missing.map(value => ({ value, label: `${value} (biriktirilgan)` })), ...choices].map((choice, index) => <Label key={choice.value} htmlFor={`${id}-${index}`} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-muted">
        <Checkbox id={`${id}-${index}`} checked={selected.includes(choice.value)} disabled={disabled} onCheckedChange={checked => onChange(checked === true ? [...new Set([...selected, choice.value])] : selected.filter(value => value !== choice.value))} />
        <span className="min-w-0 break-words leading-5">{choice.label}</span>
      </Label>)}
    </div>
    <p className="text-xs text-muted-foreground">{selected.length} ta tanlangan</p>
  </fieldset>
}

export interface AdminIdentityControlsProps {
  kind: ResourceKind
  row: Row
  onSaved?: SavedCallback
  onRemoved?: SavedCallback
}
export function AdminIdentityControls({ kind, row, onSaved, onRemoved }: AdminIdentityControlsProps) {
  const { scope, session } = useSession()
  if (kind === 'roles') {
    let role: IdentityRole
    try { role = roleFromRow(row) } catch { return null }
    return <RoleControls key={`${scope}:role:${role.id}`} role={role} onSaved={onSaved} />
  }
  const identity = resolveAdminIdentity(kind, row)
  if (!identity || !session) return null
  return <IdentityControls key={`${scope}:${identity.role}:${identity.ref}`} identity={identity} onSaved={onSaved} onRemoved={onRemoved} />
}
function IdentityControls({ identity, onSaved, onRemoved }: { identity: AdminIdentity; onSaved?: SavedCallback; onRemoved?: SavedCallback }) {
  const { session, demo } = useSession()
  const [dialog, setDialog] = useState<'profile' | 'role' | 'warehouse' | 'groups' | 'code' | 'remove' | null>(null)
  const admin = hasCapability(session, 'admin.access'), self = isCurrentIdentity(session, identity)
  const canEdit = identity.kind === 'material' ? hasCapability(session, 'party.customer.manage') : admin
  const canRole = hasCapability(session, 'role.capability.read') && hasCapability(session, 'role.capability.manage') && !self
  const canGroups = identity.kind === 'material' && admin && canReadIdentityItemGroups(session) && !self
  const warehouseRead = hasCapability(session, session?.profile.role === 'material_taminotchi' ? 'raw_material.assign' : session?.profile.role === 'werka' ? 'inventory.movement.manage' : 'catalog.item.read')
  const canWarehouse = admin && warehouseRead && (identity.kind === 'worker' || ['material_taminotchi', 'qolipchi', 'tayyorlov_masteri', 'homashyo_rezkachi'].includes(identity.role))
  const canCode = identity.kind === 'material' ? hasCapability(session, 'party.customer.code.manage') : admin
  const close = () => setDialog(null)
  if (!canEdit && !canRole && !canGroups && !canWarehouse && !canCode) return null
  return <div className="space-y-3 border-t pt-4">
    <p className="text-sm font-medium">Boshqarish</p>
    {demo && <p className="text-xs text-muted-foreground">Ko‘rish rejimida o‘zgarishlar saqlanmaydi.</p>}
    <div className="flex flex-wrap gap-2">
      {canEdit && <Button variant="outline" disabled={demo} onClick={() => setDialog('profile')}><Pencil />Tahrirlash</Button>}
      {canRole && <Button variant="outline" disabled={demo} onClick={() => setDialog('role')}><ShieldCheck />Rol va ruxsat doirasi</Button>}
      {canGroups && !canRole && <Button variant="outline" disabled={demo} onClick={() => setDialog('groups')}><Link2 />Mahsulot guruhlari</Button>}
      {canWarehouse && <Button variant="outline" disabled={demo} onClick={() => setDialog('warehouse')}><Warehouse />Omborlar</Button>}
      {canCode && <Button variant="outline" disabled={demo} onClick={() => setDialog('code')}><KeyRound />Kodni yangilash</Button>}
      {identity.kind === 'worker' && admin && !self && <Button variant="outline" disabled={demo} className="text-destructive" onClick={() => setDialog('remove')}><Trash2 />Faolsizlantirish</Button>}
    </div>
    {dialog === 'profile' && <ProfileEditor identity={identity} onSaved={onSaved} onClose={close} />}
    {dialog === 'role' && <AssignmentEditor identity={identity} onSaved={onSaved} onClose={close} />}
    {dialog === 'warehouse' && <WarehouseEditor identity={identity} onSaved={onSaved} onClose={close} />}
    {dialog === 'groups' && <MaterialGroupsEditor identity={identity} onSaved={onSaved} onClose={close} />}
    {dialog === 'code' && <CodeRegenerationDialog identity={identity} onSaved={onSaved} onClose={close} />}
    {dialog === 'remove' && <WorkerRemovalDialog identity={identity} onSaved={onSaved} onRemoved={onRemoved} onClose={close} />}
  </div>
}
function RoleControls({ role, onSaved }: { role: IdentityRole; onSaved?: SavedCallback }) {
  const { session, demo } = useSession()
  const [open, setOpen] = useState(false)
  if (role.system) return <p className="text-sm text-muted-foreground">Tizim rolining ruxsatlari oldindan belgilangan.</p>
  if (!hasCapability(session, 'role.capability.read') || !hasCapability(session, 'role.capability.manage')) return null
  return <div className="border-t pt-4"><Button variant="outline" disabled={demo} onClick={() => setOpen(true)}><Pencil />Rolni tahrirlash</Button>{open && <RoleEditor roleId={role.id} onSaved={onSaved} onClose={() => setOpen(false)} />}</div>
}
/** Add to the roles toolbar; creation shares the same server catalog as editing. */
export function AdminRoleCreateButton({ onSaved }: { onSaved?: SavedCallback }) {
  const { scope, session, demo } = useSession()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [scope])
  if (!hasCapability(session, 'role.capability.read') || !hasCapability(session, 'role.capability.manage')) return null
  return <><Button disabled={demo} onClick={() => setOpen(true)}><Plus />Rol yaratish</Button>{open && <RoleEditor key={scope} onSaved={onSaved} onClose={() => setOpen(false)} />}</>
}
function RoleEditor({ roleId, onSaved, onClose }: { roleId?: string; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const catalog = useQuery({ queryKey: ['admin-identity', scope, 'role-editor', roleId ?? 'new'], queryFn: async ({ signal }) => {
    const [capabilities, roles, assignments] = await Promise.all([api!.capabilities(signal), api!.roles(signal), api!.assignments(signal)])
    return { capabilities, roles, assignments }
  }, enabled: !!api, retry: false })
  const role = roleId ? catalog.data?.roles.find(role => role.id === roleId) : undefined
  return <EditorDialog title={roleId ? 'Rolni tahrirlash' : 'Yangi rol'} description="Nomni kiriting va ushbu rolga kerakli ruxsatlarni tanlang." onClose={onClose}>
    <ReadStatus pending={catalog.isPending} error={catalog.error} retry={() => void catalog.refetch()}>
      {catalog.data && (!roleId || role) ? <RoleForm data={catalog.data} role={role} onSaved={onSaved} onClose={onClose} /> : <p className="text-sm text-muted-foreground">Rol topilmadi. Ro‘yxatni yangilang.</p>}
    </ReadStatus>
  </EditorDialog>
}
function RoleForm({ data, role, onSaved, onClose }: { data: { capabilities: Awaited<ReturnType<AdminIdentityApi['capabilities']>>; roles: IdentityRole[]; assignments: IdentityAssignment[] }; role?: IdentityRole; onSaved?: SavedCallback; onClose: () => void }) {
  const { session } = useSession()
  const id = useId()
  const write = useIdentityWrite(`role:${role?.id ?? 'new'}`, onSaved)
  const [code, setCode] = useState(role?.id ?? ''), [label, setLabel] = useState(role?.label ?? '')
  const [selected, setSelected] = useState<string[]>(role?.capability_codes ?? []), [search, setSearch] = useState('')
  const choices = data.capabilities.filter(choice => `${choice.label} ${choice.code}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const removesOwnAccess = Boolean(session && role && !ownRoleAccessPreserved(session, role.id, selected, data.assignments))
  function submit(event: FormEvent) {
    event.preventDefault()
    if (removesOwnAccess) { write.setError(new Error('O‘z boshqaruv ruxsatlaringizni saqlab qoling.')); return }
    void write.run((api, signal) => api.saveRole({ id: code, label, capability_codes: selected }, data.capabilities, data.roles, !role, signal), onClose)
  }
  return <form onSubmit={submit} className="space-y-4">
    {role?.system ? <p className="text-sm text-muted-foreground">Tizim roli himoyalangan.</p> : <>
      {!role && <div className="space-y-2"><Label htmlFor={`${id}-code`}>Rol kodi</Label><Input id={`${id}-code`} value={code} onChange={event => setCode(event.target.value)} required pattern="[a-zA-Z0-9_-]+" autoComplete="off" placeholder="ombor_nazoratchisi" disabled={write.pending} /><p className="text-xs text-muted-foreground">Lotin harflari, raqam, chiziqcha va pastki chiziq.</p></div>}
      <div className="space-y-2"><Label htmlFor={`${id}-label`}>Rol nomi</Label><Input id={`${id}-label`} value={label} onChange={event => setLabel(event.target.value)} required disabled={write.pending} /></div>
      <ChoiceChecklist title="Ruxsatlar" choices={choices.map(choice => ({ value: choice.code, label: choice.label }))} selected={selected} onChange={setSelected} disabled={write.pending} search={search} onSearch={setSearch} />
      {!data.capabilities.length && <p className="text-sm text-muted-foreground">Ruxsatlar ro‘yxati bo‘sh.</p>}
      {removesOwnAccess && <WriteError error={new Error('O‘z boshqaruv ruxsatlaringizni saqlab qoling.')} />}
    </>}
    <WriteError error={write.error} />
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Bekor qilish</Button><Button type="submit" disabled={write.pending || role?.system || !code.trim() || !label.trim() || !selected.length || !data.capabilities.length || removesOwnAccess}><SubmitLabel pending={write.pending} /></Button></DialogFooter>
  </form>
}

function ProfileEditor({ identity, onSaved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const detail = useQuery({ queryKey: ['admin-identity', scope, 'profile', identity.role, identity.ref], queryFn: ({ signal }) => api!.detail(identity, signal), enabled: !!api, retry: false })
  return <EditorDialog title="Foydalanuvchini tahrirlash" description={identity.name} onClose={onClose}>
    <ReadStatus pending={detail.isPending} error={detail.error} retry={() => void detail.refetch()}>{detail.data && <ProfileForm detail={detail.data} onSaved={onSaved} onClose={onClose} />}</ReadStatus>
  </EditorDialog>
}
function ProfileForm({ detail, onSaved, onClose }: { detail: IdentityDetail; onSaved?: SavedCallback; onClose: () => void }) {
  const id = useId(), write = useIdentityWrite(`${detail.role}:${detail.ref}:profile`, onSaved)
  const [current, setCurrent] = useState(detail)
  const [name, setName] = useState(detail.name), [phone, setPhone] = useState(detail.phone), [level, setLevel] = useState(detail.level)
  function saveWorker(event: FormEvent, field: 'name' | 'phone' | 'level', value: string) {
    event.preventDefault()
    void write.run((api, signal) => api.updateWorker(current, field, value, signal), setCurrent)
  }
  function save(event: FormEvent) {
    event.preventDefault()
    void write.run((api, signal) => current.kind === 'material' ? api.updateMaterialPhone(current, phone, signal) : api.updateSystemUser(current, name, phone, signal), onClose)
  }
  return <div className="space-y-4">
    {current.kind === 'worker' ? <>
      <form onSubmit={event => saveWorker(event, 'name', name)} className="space-y-2"><Label htmlFor={`${id}-name`}>Ism</Label><div className="flex gap-2"><Input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} required disabled={write.pending} /><Button disabled={write.pending || !name.trim() || name.trim() === current.name}><SubmitLabel pending={write.pending} /></Button></div></form>
      <form onSubmit={event => saveWorker(event, 'phone', phone)} className="space-y-2"><Label htmlFor={`${id}-phone`}>Telefon raqami</Label><div className="flex gap-2"><Input id={`${id}-phone`} type="tel" autoComplete="off" value={phone} onChange={event => setPhone(event.target.value)} required disabled={write.pending} /><Button disabled={write.pending || !phone.trim() || phone.trim() === current.phone}><SubmitLabel pending={write.pending} /></Button></div></form>
      <form onSubmit={event => saveWorker(event, 'level', level)} className="space-y-2"><Label htmlFor={`${id}-level`}>Ishchi darajasi</Label><div className="flex gap-2"><Select value={level} onValueChange={setLevel} disabled={write.pending}><SelectTrigger id={`${id}-level`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{workerLevels.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent></Select><Button disabled={write.pending || level === current.level}><SubmitLabel pending={write.pending} /></Button></div></form>
    </> : <form onSubmit={save} className="space-y-4">
      {current.kind === 'system' && <div className="space-y-2"><Label htmlFor={`${id}-name`}>Ism</Label><Input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} required disabled={write.pending} /></div>}
      <div className="space-y-2"><Label htmlFor={`${id}-phone`}>Telefon raqami</Label><Input id={`${id}-phone`} type="tel" autoComplete="off" value={phone} onChange={event => setPhone(event.target.value)} required disabled={write.pending} /></div>
      <WriteError error={write.error} /><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Bekor qilish</Button><Button disabled={write.pending || !phone.trim() || current.kind === 'system' && !name.trim()}><SubmitLabel pending={write.pending} /></Button></DialogFooter>
    </form>}
    {current.kind === 'worker' && <><WriteError error={write.error} /><DialogFooter><Button variant="outline" onClick={onClose}>Yopish</Button></DialogFooter></>}
  </div>
}

function AssignmentEditor({ identity, onSaved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const data = useQuery({ queryKey: ['admin-identity', scope, 'assignment-editor', identity.role, identity.ref], queryFn: async ({ signal }) => {
    const [roles, assignments] = await Promise.all([api!.roles(signal), api!.assignments(signal)])
    return { roles: roles.filter(role => canAssignIdentityRole(role, identity)), assignment: assignmentForIdentity(assignments, identity) }
  }, enabled: !!api, retry: false })
  return <EditorDialog title="Rol va ruxsat doirasi" description={`${identity.name} uchun vazifa, apparatlar va mahsulot guruhlarini tanlang.`} onClose={onClose}>
    <ReadStatus pending={data.isPending} error={data.error} retry={() => void data.refetch()}>{data.data && <AssignmentForm identity={identity} data={data.data} onSaved={onSaved} onClose={onClose} />}</ReadStatus>
  </EditorDialog>
}
function AssignmentForm({ identity, data, onSaved, onClose }: { identity: AdminIdentity; data: { roles: IdentityRole[]; assignment?: IdentityAssignment }; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope, session } = useIdentityApi()
  const id = useId(), write = useIdentityWrite(`${identity.role}:${identity.ref}:assignment`, onSaved)
  const [roleId, setRoleId] = useState(data.assignment?.role_id ?? data.roles.find(role => role.id === identity.role)?.id ?? '')
  const [apparatus, setApparatus] = useState(data.assignment?.assigned_apparatus ?? []), [groups, setGroups] = useState(data.assignment?.assigned_item_groups ?? [])
  const [search, setSearch] = useState(''), [groupSearch, setGroupSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const machines = useQuery({ queryKey: ['admin-identity', scope, 'apparatus', q], queryFn: ({ signal }) => api!.apparatus(q, signal), enabled: !!api && hasCapability(session, 'admin.access'), retry: false })
  const groupCatalog = useQuery({ queryKey: ['admin-identity', scope, 'item-groups'], queryFn: ({ signal }) => api!.itemGroups(signal), enabled: !!api && canReadIdentityItemGroups(session), retry: false })
  const role = data.roles.find(role => role.id === roleId)
  const requiresApparatus = role?.capability_codes.includes('apparatus.queue.read'), requiresGroups = identity.role === 'material_taminotchi' && roleId === 'material_taminotchi'
  const unknownRole = Boolean(roleId && !role)
  function submit(event: FormEvent) {
    event.preventDefault()
    void write.run((api, signal) => api.saveAssignment(identity, { role_id: roleId, assigned_apparatus: apparatus, assigned_item_groups: groups }, data.roles, signal), onClose)
  }
  return <form onSubmit={submit} className="space-y-4">
    <div className="space-y-2"><Label htmlFor={`${id}-role`}>Rol</Label><Select value={roleId} onValueChange={setRoleId} disabled={write.pending}><SelectTrigger id={`${id}-role`} className="w-full"><SelectValue placeholder="Rolni tanlang" /></SelectTrigger><SelectContent>{data.roles.map(role => <SelectItem key={role.id} value={role.id}>{role.label}</SelectItem>)}</SelectContent></Select>
      {!data.roles.length && <p className="text-sm text-muted-foreground">Mos rollar topilmadi.</p>}{unknownRole && <p className="text-sm text-destructive">Biriktirilgan rol topilmadi. Mavjud rolni tanlang.</p>}
    </div>
    <ReadStatus pending={machines.isPending && machines.fetchStatus !== 'idle'} error={machines.error} retry={() => void machines.refetch()}><ChoiceChecklist title="Apparatlar" choices={machines.data?.items ?? []} selected={apparatus} onChange={setApparatus} disabled={write.pending || !machines.data} search={search} onSearch={setSearch} bounded={machines.data?.bounded} /></ReadStatus>
    {requiresApparatus && !apparatus.length && <p className="text-xs text-destructive">Ushbu rolga kamida bitta apparat kerak.</p>}
    {canReadIdentityItemGroups(session) ? <ReadStatus pending={groupCatalog.isPending} error={groupCatalog.error} retry={() => void groupCatalog.refetch()}><ChoiceChecklist title="Mahsulot guruhlari" choices={(groupCatalog.data?.items ?? []).filter(choice => choice.label.toLocaleLowerCase().includes(groupSearch.toLocaleLowerCase()))} selected={groups} onChange={setGroups} disabled={write.pending || !groupCatalog.data} search={groupSearch} onSearch={setGroupSearch} /></ReadStatus> : <div className="space-y-2"><p className="text-sm text-muted-foreground">Mahsulot guruhlarini tanlash uchun ruxsat yetarli emas.</p>{groups.map(group => <Badge key={group} variant="secondary">{group}</Badge>)}</div>}
    {requiresGroups && !groups.length && <p className="text-xs text-destructive">Kamida bitta mahsulot guruhi kerak.</p>}
    <WriteError error={write.error} /><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Bekor qilish</Button><Button disabled={write.pending || !role || unknownRole || requiresApparatus && !apparatus.length || requiresGroups && !groups.length}><SubmitLabel pending={write.pending} /></Button></DialogFooter>
  </form>
}

function MaterialGroupsEditor({ identity, onSaved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const data = useQuery({ queryKey: ['admin-identity', scope, 'material-groups', identity.ref], queryFn: async ({ signal }) => {
    const [detail, groups] = await Promise.all([api!.detail(identity, signal), api!.itemGroups(signal)])
    return { detail, groups }
  }, enabled: !!api, retry: false })
  return <EditorDialog title="Mahsulot guruhlarini biriktirish" description="Bu tanlov material ta’minotchisi rolini va mahsulot guruhlarini saqlaydi." onClose={onClose}>
    <ReadStatus pending={data.isPending} error={data.error} retry={() => void data.refetch()}>{data.data && <MaterialGroupsForm identity={identity} data={data.data} onSaved={onSaved} onClose={onClose} />}</ReadStatus>
  </EditorDialog>
}
function MaterialGroupsForm({ identity, data, onSaved, onClose }: { identity: AdminIdentity; data: { detail: IdentityDetail; groups: ScopeCatalog }; onSaved?: SavedCallback; onClose: () => void }) {
  const [selected, setSelected] = useState(data.detail.assignedItemGroups), [search, setSearch] = useState('')
  const write = useIdentityWrite(`${identity.role}:${identity.ref}:groups`, onSaved)
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void write.run((api, signal) => api.updateMaterialGroups(identity, selected, signal), onClose) }}>
    <ChoiceChecklist title="Mahsulot guruhlari" choices={data.groups.items.filter(choice => choice.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} selected={selected} onChange={setSelected} disabled={write.pending} search={search} onSearch={setSearch} />
    <WriteError error={write.error} /><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Bekor qilish</Button><Button disabled={write.pending || !selected.length}><SubmitLabel pending={write.pending} /></Button></DialogFooter>
  </form>
}

function WarehouseEditor({ identity, onSaved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const data = useQuery({ queryKey: ['admin-identity', scope, 'identity-warehouses', identity.role, identity.ref], queryFn: async ({ signal }) => {
    const [detail, assignments] = await Promise.all([api!.detail(identity, signal), api!.warehouseAssignments(identity, signal)])
    return { detail, assignments }
  }, enabled: !!api, retry: false })
  return <EditorDialog title="Omborlarni biriktirish" description={`${identity.name} mas’ul bo‘lgan omborlar.`} onClose={onClose}>
    <ReadStatus pending={data.isPending} error={data.error} retry={() => void data.refetch()}>{data.data && <WarehouseForm identity={data.data.detail} assignments={data.data.assignments} onSaved={onSaved} onClose={onClose} />}</ReadStatus>
  </EditorDialog>
}
function WarehouseForm({ identity, assignments, onSaved, onClose }: { identity: IdentityDetail; assignments: WarehouseIdentityAssignment[]; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const id = useId(), write = useIdentityWrite(`${identity.role}:${identity.ref}:warehouses`, onSaved)
  const [value, setValue] = useState(''), [search, setSearch] = useState('')
  const [removing, setRemoving] = useState<WarehouseIdentityAssignment | null>(null)
  const q = useDeferredValue(search.trim())
  const choices = useQuery({ queryKey: ['admin-identity', scope, 'warehouse-choices', q], queryFn: ({ signal }) => api!.warehouses(q, signal), enabled: !!api && warehouseAssigneeAllowed(identity), retry: false })
  const options = choices.data?.items ?? [], duplicate = assignments.some(assignment => warehouseAssignmentKey(assignment) === `warehouse:${value}`)
  const labelFor = (assignment: WarehouseIdentityAssignment) => assignment.assignment_kind === 'warehouse' ? assignment.warehouse_name || assignment.warehouse : options.find(choice => choice.value === assignment.apparatus_id)?.label || assignment.apparatus_id
  function add(event: FormEvent) {
    event.preventDefault()
    if (!options.some(choice => choice.value === value) || duplicate) return
    void write.run((api, signal) => api.assignWarehouse(identity, 'warehouse', value, signal), () => setValue(''))
  }
  return <div className="space-y-4">
    <div className="space-y-2">
      {!assignments.length && <p className="text-sm text-muted-foreground">Ombor biriktirilmagan.</p>}
      {assignments.map(assignment => <div key={warehouseAssignmentKey(assignment)} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{labelFor(assignment)}</p><p className="text-xs text-muted-foreground">{assignment.assignment_kind === 'apparatus' ? 'Apparat ombori' : 'Ombor'}</p></div><Button variant="ghost" size="icon" aria-label={`${labelFor(assignment)} ulanishini olib tashlash`} disabled={write.pending} onClick={() => { setRemoving(assignment); write.setError(null) }}><Trash2 className="text-destructive" /></Button></div>)}
    </div>
    {removing && <Alert><AlertDescription className="space-y-3"><p>{labelFor(removing)} omboriga ulanishni olib tashlashni tasdiqlang.</p><div className="flex gap-2"><Button variant="outline" disabled={write.pending} onClick={() => setRemoving(null)}>Bekor qilish</Button><Button variant="destructive" disabled={write.pending} onClick={() => void write.run((api, signal) => api.unassignWarehouse(identity, removing, true, signal), () => setRemoving(null))}><SubmitLabel pending={write.pending} label="Ulanishni olib tashlash" /></Button></div></AlertDescription></Alert>}
    {warehouseAssigneeAllowed(identity) ? <form onSubmit={add} className="space-y-3 border-t pt-4">
      <Input aria-label="Ombor qidirish" placeholder="Qidirish…" value={search} onChange={event => { setSearch(event.target.value); setValue('') }} disabled={write.pending} />
      <ReadStatus pending={choices.isPending} error={choices.error} retry={() => void choices.refetch()}><Label htmlFor={`${id}-value`}>Ombor</Label><Select value={value} onValueChange={setValue} disabled={write.pending || !options.length}><SelectTrigger id={`${id}-value`} className="w-full"><SelectValue placeholder="Ro‘yxatdan tanlang" /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>{!options.length && <p className="text-sm text-muted-foreground">Mos tanlov topilmadi.</p>}<BoundedNotice catalog={choices.data} /></ReadStatus>
      {duplicate && <p className="text-xs text-muted-foreground">Bu ulanish avval biriktirilgan.</p>}
      <Button disabled={write.pending || !value || !options.some(choice => choice.value === value) || duplicate || Boolean(choices.error)}><SubmitLabel pending={write.pending} label="Biriktirish" /></Button>
    </form> : identity.kind === 'worker' && <p className="text-sm text-muted-foreground">Ombor biriktirish uchun ishchi Brigader darajasida bo‘lishi kerak.</p>}
    <WriteError error={write.error} /><DialogFooter><Button variant="outline" onClick={onClose}>Yopish</Button></DialogFooter>
  </div>
}

function CodeRegenerationDialog({ identity, onSaved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const id = useId(), write = useIdentityWrite(`${identity.role}:${identity.ref}:code`, onSaved)
  const [code, setCode] = useState('')
  const detail = useQuery({ queryKey: ['admin-identity', scope, 'code-lock', identity.role, identity.ref], queryFn: ({ signal }) => api!.detail(identity, signal), enabled: !!api, retry: false })
  return <EditorDialog title={code ? 'Yangi kirish kodi' : 'Kirish kodini yangilash'} description={code ? 'Kodni foydalanuvchiga xavfsiz yetkazing.' : `${identity.name} uchun yangi kod yaratiladi. Avvalgi kod ishlamay qoladi.`} onClose={onClose} pending={write.pending}>
    {code ? <div className="space-y-2"><Label htmlFor={`${id}-code`}>Yangi kod</Label><Input id={`${id}-code`} autoComplete="off" readOnly value={code} className="font-mono" /></div> : <ReadStatus pending={detail.isPending} error={detail.error} retry={() => void detail.refetch()}>{detail.data?.codeLocked && <p className="text-sm text-muted-foreground">Kod yangilash vaqtincha cheklangan. {detail.data.codeRetryAfterSec > 0 ? `${Math.ceil(detail.data.codeRetryAfterSec / 60)} daqiqadan keyin qayta urinib ko‘ring.` : 'Birozdan keyin qayta urinib ko‘ring.'}</p>}</ReadStatus>}
    <WriteError error={write.error} /><DialogFooter><Button variant="outline" onClick={onClose}>{code ? 'Yopish' : 'Bekor qilish'}</Button>{!code && <Button disabled={write.pending || !detail.data || Boolean(detail.error) || detail.data.codeLocked} onClick={() => void write.run((api, signal) => api.regenerateCode(identity, true, signal), result => setCode(result.code))}><SubmitLabel pending={write.pending} label="Tasdiqlayman, yangi kod yaratish" /></Button>}</DialogFooter>
  </EditorDialog>
}
function WorkerRemovalDialog({ identity, onSaved, onRemoved, onClose }: { identity: AdminIdentity; onSaved?: SavedCallback; onRemoved?: SavedCallback; onClose: () => void }) {
  const { api, scope } = useIdentityApi()
  const id = useId(), write = useIdentityWrite(`${identity.role}:${identity.ref}:remove`, onSaved)
  const [confirmedConnections, setConfirmedConnections] = useState(false), [changedCheck, setChangedCheck] = useState<WorkerRemovalCheck | null>(null)
  const result = useQuery({ queryKey: ['admin-identity', scope, 'delete-check', identity.ref], queryFn: ({ signal }) => api!.workerRemovalCheck(identity, signal), enabled: !!api, retry: false, staleTime: 0 })
  const check = changedCheck ?? (write.error instanceof WorkerRemovalConflict ? write.error.check : result.data)
  useEffect(() => {
    if (write.error instanceof WorkerRemovalConflict) { setChangedCheck(write.error.check); setConfirmedConnections(false) }
  }, [write.error])
  useEffect(() => { setConfirmedConnections(false) }, [result.data])
  const dependencies = check?.blocked ? check.active_work : check?.connections ?? []
  async function refresh() {
    setChangedCheck(null); setConfirmedConnections(false); write.setError(null)
    await result.refetch()
  }
  return <EditorDialog title={check?.blocked ? 'Ishchining faol ishi mavjud' : 'Ishchini faolsizlantirish'} description={check?.blocked ? 'Faol ishlar yakunlangandan so‘ng ishchini faolsizlantirish mumkin.' : `${identity.name} tizimga kira olmaydi. Bog‘langan guruh va rol ulanishlari olib tashlanadi.`} onClose={onClose} pending={write.pending}>
    <ReadStatus pending={result.isPending} error={result.error} retry={() => void refresh()}>
      {dependencies.length > 0 && <ul className="max-h-60 space-y-2 overflow-y-auto rounded-lg border p-3">{dependencies.map((dependency, index) => <li key={`${dependency.kind}:${index}`} className="text-sm"><span className="font-medium">{dependency.label || dependency.kind}</span>{dependency.status && <span className="ml-2 text-muted-foreground">{dependency.status}</span>}</li>)}</ul>}
      {check?.requires_confirmation && !check.blocked && <Label htmlFor={`${id}-confirm`} className="flex items-start gap-3"><Checkbox id={`${id}-confirm`} checked={confirmedConnections} disabled={write.pending} onCheckedChange={checked => setConfirmedConnections(checked === true)} /><span>Ko‘rsatilgan ulanishlarni olib tashlashni tasdiqlayman.</span></Label>}
      {check?.blocked && <Button variant="outline" disabled={write.pending || result.isFetching} onClick={() => void refresh()}>Qayta tekshirish</Button>}
    </ReadStatus>
    <WriteError error={write.error} /><DialogFooter><Button variant="outline" onClick={onClose}>Bekor qilish</Button>{check && !check.blocked && <Button variant="destructive" disabled={write.pending || result.isFetching || Boolean(result.error) || check.requires_confirmation && !confirmedConnections} onClick={() => void write.run((api, signal) => api.removeWorker(identity, check, true, confirmedConnections, signal), () => { onRemoved?.(); onClose() })}><SubmitLabel pending={write.pending} label="Faolsizlantirishni tasdiqlash" /></Button>}</DialogFooter>
  </EditorDialog>
}
