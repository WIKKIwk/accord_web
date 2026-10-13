import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { Row } from '@/lib/api-types'
import { useSession } from '@/lib/session'
import { display, dateLabel, numberLabel } from '@/lib/presentation'
import { canViewPage } from '@/lib/permissions'
import { WorkerProfileApi, canReadWorkerHistory, canReadWorkerProfile, canReadWorkerRoles, workerProfileCounts, workerProfileError, workerProfileIdentity, workerStateLabel } from '@/lib/worker-profile'
import type { WorkerApparatusCatalog, WorkerProfile, WorkerProfileBatch, WorkerProfileEvent, WorkerProfileSession } from '@/lib/worker-profile'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Selection = { kind: 'session' | 'batch' | 'event'; id: string }
type ProfileProps = { row: Row; onSaved?: () => void }
/** Mount for native workers or users whose principal_role is aparatchi. The returned profile never contains login credentials. */
export function WorkerProfileControls({ row, onSaved }: ProfileProps) {
  const { scope } = useSession(), id = workerProfileIdentity(row)
  return id ? <WorkerProfileView key={`${scope}:${id}`} id={id} onSaved={onSaved} /> : null
}
function WorkerProfileView({ id, onSaved }: { id: string; onSaved?: () => void }) {
  const { client, session, demo, scope } = useSession()
  const allowed = canReadWorkerProfile(session)
  const api = useMemo(() => client && session && !demo && allowed ? new WorkerProfileApi(client, session) : null, [client, session, demo, allowed])
  const [historyLimit, setHistoryLimit] = useState(50), [selection, setSelection] = useState<Selection | null>(null)
  const profile = useQuery({ queryKey: ['worker-profile', scope, id], queryFn: ({ signal }) => api!.profile(id, signal), enabled: !!api, retry: false, refetchOnWindowFocus: false })
  const apparatus = useQuery({ queryKey: ['worker-profile-apparatus', scope], queryFn: ({ signal }) => api!.apparatus(signal), enabled: !!api && !!profile.data, retry: false, refetchOnWindowFocus: false })
  const rolesAllowed = canReadWorkerRoles(session), historyAllowed = canReadWorkerHistory(session, id)
  const role = useQuery({ queryKey: ['worker-profile-role', scope, id], queryFn: ({ signal }) => api!.assignment(id, signal), enabled: !!api && !!profile.data && rolesAllowed, retry: false, refetchOnWindowFocus: false })
  const history = useQuery({ queryKey: ['worker-profile-history', scope, id, historyLimit], queryFn: ({ signal }) => api!.history(id, historyLimit, signal), enabled: !!api && !!profile.data && historyLimit > 50 && historyAllowed, retry: false, refetchOnWindowFocus: false })
  const mounted = useRef(true), refreshGeneration = useRef(0), currentIdentity = useRef({ scope, id, client })
  currentIdentity.current = { scope, id, client }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshGeneration.current += 1 } }, [])
  const loading = profile.isFetching || apparatus.isFetching || role.isFetching || history.isFetching
  async function refresh() {
    const identity = currentIdentity.current, generation = ++refreshGeneration.current
    const result = await profile.refetch()
    if (!mounted.current || generation !== refreshGeneration.current || identity.scope !== currentIdentity.current.scope || identity.id !== currentIdentity.current.id || identity.client !== currentIdentity.current.client) return
    if (result.error) return
    if (apparatus.data || apparatus.error) void apparatus.refetch()
    if (rolesAllowed) void role.refetch()
    if (historyLimit > 50 && historyAllowed) void history.refetch()
    onSaved?.()
  }
  if (demo || !allowed) return <Alert><AlertDescription>{demo ? 'Ishchi faoliyatini ko‘rish uchun ERP serveriga ulaning.' : 'Ishchi profilini ko‘rish uchun ruxsat yetarli emas.'}</AlertDescription></Alert>
  return <section className="space-y-4" aria-label="Ishchi faoliyati">
    <div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold">Ishchi faoliyati</h3><p className="text-xs text-muted-foreground">Ochiq ishlar va so‘nggi qaydlar</p></div><Button type="button" variant="outline" size="sm" disabled={loading || !api} onClick={() => void refresh()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Yangilash</Button></div>
    {profile.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Ishchi profili yuklanmoqda…</p> : profile.error || !profile.data ? <ErrorNotice error={profile.error} onRetry={() => void profile.refetch()} /> : <>
      {apparatus.error && <ErrorNotice error={apparatus.error} label="Uskuna nomlari yuklanmadi." onRetry={() => void apparatus.refetch()} />}
      <WorkerProfileSummary profile={profile.data} />
      <Card><CardHeader className="pb-3"><CardTitle className="text-sm">Rol va biriktirishlar</CardTitle></CardHeader><CardContent className="space-y-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2"><Info label="Ishchi" value={profile.data.worker.name} /><Info label="Malaka darajasi" value={display(profile.data.worker.level)} /><Info label="Telefon" value={profile.data.worker.phone} /><Info label="Ishchi ID" value={profile.data.worker.id} /></dl>
        {rolesAllowed ? role.isPending ? <p className="text-muted-foreground">Rol yuklanmoqda…</p> : role.error ? <ErrorNotice error={role.error} onRetry={() => void role.refetch()} /> : role.data ? <div className="space-y-2"><p><span className="text-muted-foreground">Biriktirilgan rol: </span>{role.data.role?.label ?? role.data.role_id}</p>{role.data.role && <p className="text-xs text-muted-foreground">{role.data.role.capability_count} ta ruxsat</p>}{role.data.assigned_item_groups.length > 0 && <p><span className="text-muted-foreground">Material guruhlari: </span>{role.data.assigned_item_groups.join(', ')}</p>}</div> : <p className="text-muted-foreground">Maxsus rol biriktirilmagan.</p> : <p className="text-muted-foreground">Rol tafsilotlarini ko‘rish uchun ruxsat yetarli emas.</p>}
        <div className="space-y-2"><p className="font-medium">Biriktirilgan uskunalar</p>{profile.data.assigned_apparatus.length ? <div className="flex flex-wrap gap-2">{profile.data.assigned_apparatus.map(id => <Badge key={id} variant="outline">{apparatusName(id, apparatus.data, profile.data!)}</Badge>)}</div> : <p className="text-muted-foreground">Uskuna biriktirilmagan.</p>}</div>
        <div className="space-y-2"><p className="font-medium">Ishchi guruhlari</p>{profile.data.assigned_groups.length ? <ul className="space-y-3">{profile.data.assigned_groups.map(group => <li key={`${group.apparatus_id}:${group.group_code}`} className="rounded-md border p-3"><p className="font-medium">{group.group_code} · {apparatusName(group.apparatus_id, apparatus.data, profile.data!)}</p><p className="mt-1 text-xs text-muted-foreground">{group.shift} · {group.start_time}–{group.end_time} · haftasiga {group.work_days_per_week} kun{group.start_day ? ` · ${dayName(group.start_day)}` : ''}</p><p className="mt-1 text-xs text-muted-foreground">Ish vaqti hisobi: {group.accounting_enabled ? 'yoqilgan' : 'o‘chirilgan'}</p>{group.workers.length > 0 && <p className="mt-2 text-xs">{group.workers.map(worker => worker.name).join(', ')}</p>}</li>)}</ul> : <p className="text-muted-foreground">Guruh biriktirilmagan.</p>}</div>
      </CardContent></Card>
      <Tabs defaultValue="sessions" className="min-w-0"><TabsList className="w-full"><TabsTrigger value="sessions">Ochiq ishlar</TabsTrigger><TabsTrigger value="batches">Partiyalar</TabsTrigger><TabsTrigger value="events">Hodisalar</TabsTrigger></TabsList>
        <TabsContent value="sessions" className="mt-2"><ProfileRecords empty="Ochiq ishlar yo‘q." count={profile.data.active_sessions.length} cap={50}><TableHeader><TableRow><TableHead>Buyurtma va uskuna</TableHead><TableHead>Holati</TableHead><TableHead>Yangilangan</TableHead><TableHead className="text-right">Tafsilot</TableHead></TableRow></TableHeader><TableBody>{profile.data.active_sessions.map(record => <TableRow key={record.session_id}><TableCell className="whitespace-normal"><p>{orderName(record.order_id)}</p><p className="text-xs text-muted-foreground">{apparatusName(record.apparatus, apparatus.data, profile.data!)}</p></TableCell><TableCell>{workerStateLabel(record.status)}</TableCell><TableCell className="text-xs">{dateLabel(record.updated_at_unix)}</TableCell><TableCell className="text-right"><RecordButton label={`${orderName(record.order_id)} ish tafsiloti`} onClick={() => setSelection({ kind: 'session', id: record.session_id })} /></TableCell></TableRow>)}</TableBody></ProfileRecords></TabsContent>
        <TabsContent value="batches" className="mt-2 space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">So‘nggi qaydlar; davr bo‘yicha to‘liq hisobot emas.</p>{historyAllowed && <Select value={String(historyLimit)} onValueChange={value => { setSelection(null); setHistoryLimit(Number(value)) }}><SelectTrigger className="w-40" aria-label="Partiyalar tarixi hajmi"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="50">Oxirgi 50 ta</SelectItem><SelectItem value="100">Oxirgi 100 ta</SelectItem><SelectItem value="200">Oxirgi 200 ta</SelectItem></SelectContent></Select>}</div>
          {historyLimit > 50 && historyAllowed && (history.isFetching ? <p role="status" className="text-sm text-muted-foreground">Partiyalar tarixi yuklanmoqda…</p> : history.error ? <ErrorNotice error={history.error} onRetry={() => void history.refetch()} /> : null)}
          <BatchRecords batches={historyLimit > 50 && history.isSuccess ? history.data.batches : profile.data.recent_batches} cap={historyLimit > 50 && history.isSuccess ? historyLimit : 50} profile={profile.data} catalog={apparatus.data} onSelect={batch => setSelection({ kind: 'batch', id: batch.batch_id })} />
          {!historyAllowed && <p className="text-xs text-muted-foreground">Bu ishchining kengaytirilgan tarixini ko‘rish uchun ruxsat yetarli emas.</p>}
        </TabsContent>
        <TabsContent value="events" className="mt-2"><ProfileRecords empty="So‘nggi hodisalar yo‘q." count={profile.data.recent_logs.length} cap={100}><TableHeader><TableRow><TableHead>Buyurtma va uskuna</TableHead><TableHead>Hodisa</TableHead><TableHead>Vaqt</TableHead><TableHead className="text-right">Tafsilot</TableHead></TableRow></TableHeader><TableBody>{profile.data.recent_logs.map(record => <TableRow key={record.event_id}><TableCell className="whitespace-normal"><p>{orderName(record.order_id)}</p><p className="text-xs text-muted-foreground">{apparatusName(record.apparatus, apparatus.data, profile.data!)}</p></TableCell><TableCell className="whitespace-normal">{workerStateLabel(record.action)}{record.completed_with_issue && <p className="mt-1 text-xs text-destructive">Muammo bilan tugallangan</p>}</TableCell><TableCell className="text-xs">{dateLabel(record.created_at_unix)}</TableCell><TableCell className="text-right"><RecordButton label={`${orderName(record.order_id)} hodisa tafsiloti`} onClick={() => setSelection({ kind: 'event', id: record.event_id })} /></TableCell></TableRow>)}</TableBody></ProfileRecords></TabsContent>
      </Tabs>
      <Dialog open={!!selection} onOpenChange={open => { if (!open) setSelection(null) }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{selection?.kind === 'batch' ? 'Partiya tafsiloti' : selection?.kind === 'event' ? 'Hodisa tafsiloti' : 'Ish tafsiloti'}</DialogTitle><DialogDescription>{profile.data.worker.name} · ERP qaydi</DialogDescription></DialogHeader>{selection && <RecordDetail selection={selection} profile={profile.data} batches={historyLimit > 50 && history.isSuccess ? history.data.batches : profile.data.recent_batches} catalog={apparatus.data} canViewOrders={canViewPage(session, 'orders')} canViewWip={canViewPage(session, 'wip')} />}</DialogContent></Dialog>
    </>}
  </section>
}
export function WorkerProfileSummary({ profile }: { profile: WorkerProfile }) {
  const counts = workerProfileCounts(profile)
  return <Card><CardHeader className="pb-3"><CardTitle className="text-sm">Yuklangan qaydlar</CardTitle><CardDescription>Profil ko‘pi bilan 50 ochiq ish, 50 partiya va 100 hodisani ko‘rsatadi.</CardDescription></CardHeader><CardContent><dl className="grid grid-cols-3 gap-3"><Info label="Ochiq ishlar" value={`${counts.open} ta`} /><Info label="So‘nggi partiyalar" value={`${counts.batches} ta`} /><Info label="So‘nggi hodisalar" value={`${counts.events} ta`} /></dl><div className="mt-4 flex flex-wrap gap-2">{(['active', 'paused', 'frozen', 'roll_detached'] as const).map(status => <Badge key={status} variant="outline">{workerStateLabel(status)}: {counts[status]}</Badge>)}</div></CardContent></Card>
}
function ErrorNotice({ error, label, onRetry }: { error: unknown; label?: string; onRetry: () => void }) { return <Alert variant="destructive"><AlertDescription className="space-y-2"><p>{label} {workerProfileError(error)}</p><Button type="button" size="sm" variant="outline" onClick={onRetry}>Qayta yuklash</Button></AlertDescription></Alert> }
function Info({ label, value }: { label: string; value: string | number | null }) { return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{value === null || value === '' ? '—' : value}</dd></div> }
function ProfileRecords({ children, empty, count, cap }: { children: React.ReactNode; empty: string; count: number; cap: number }) { return count ? <div className="space-y-2"><div className="overflow-hidden rounded-md border"><Table>{children}</Table></div><p className="text-xs text-muted-foreground">{count} ta qayd{count >= cap ? ` · ${cap} ta yozuv chegarasi; oldingi qaydlar bu ro‘yxatda yo‘q.` : '.'}</p></div> : <p className="rounded-md border p-4 text-sm text-muted-foreground">{empty}</p> }
function RecordButton({ label, onClick }: { label: string; onClick: () => void }) { return <Button type="button" variant="ghost" size="sm" aria-label={label} onClick={onClick}>Ko‘rish</Button> }
function orderName(id: string) { return /^zakaz-\d+$/.test(id) ? `№${id.slice('zakaz-'.length)}` : id }
function dayName(day: string) { return ({ monday: 'Dushanba', tuesday: 'Seshanba', wednesday: 'Chorshanba', thursday: 'Payshanba', friday: 'Juma', saturday: 'Shanba', sunday: 'Yakshanba' } as Record<string, string>)[day] ?? day }
function apparatusName(id: string, catalog: WorkerApparatusCatalog | undefined, profile: WorkerProfile): string { const snapshot = profile.assigned_groups.find(group => group.apparatus_id === id)?.apparatus; return catalog?.labels[id] || (snapshot && !snapshot.startsWith('apparatus:') ? snapshot : 'Uskuna nomi mavjud emas') }
function BatchRecords({ batches, cap, profile, catalog, onSelect }: { batches: WorkerProfileBatch[]; cap: number; profile: WorkerProfile; catalog?: WorkerApparatusCatalog; onSelect: (batch: WorkerProfileBatch) => void }) {
  return <ProfileRecords empty="So‘nggi partiyalar yo‘q." count={batches.length} cap={cap}><TableHeader><TableRow><TableHead>Buyurtma va uskuna</TableHead><TableHead>Holati</TableHead><TableHead className="text-right">Qayd miqdori</TableHead><TableHead className="text-right">Tafsilot</TableHead></TableRow></TableHeader><TableBody>{batches.map(batch => <TableRow key={batch.batch_id}><TableCell className="whitespace-normal"><p>{orderName(batch.order_id)}</p><p className="text-xs text-muted-foreground">{apparatusName(batch.apparatus, catalog, profile)}</p></TableCell><TableCell className="whitespace-normal"><p>{workerStateLabel(batch.status)}</p><p className="text-xs text-muted-foreground">{workerStateLabel(batch.wip_status)}</p></TableCell><TableCell className="text-right tabular-nums">{numberLabel(batch.produced_qty)} {batch.uom}</TableCell><TableCell className="text-right"><RecordButton label={`${batch.batch_id} partiya tafsiloti`} onClick={() => onSelect(batch)} /></TableCell></TableRow>)}</TableBody></ProfileRecords>
}
export function WorkerRecordDetail({ record, kind, apparatusLabel }: { record: WorkerProfileSession | WorkerProfileBatch | WorkerProfileEvent; kind: Selection['kind']; apparatusLabel: string }) {
  const common = [['Buyurtma', orderName(record.order_id)], ['Uskuna', apparatusLabel]]
  const fields = kind === 'session' ? sessionFields(record as WorkerProfileSession) : kind === 'batch' ? batchFields(record as WorkerProfileBatch) : eventFields(record as WorkerProfileEvent)
  return <dl className="grid gap-3 sm:grid-cols-2">{[...common, ...fields].map(([label, value]) => <Info key={label} label={label} value={value} />)}</dl>
}
function sessionFields(record: WorkerProfileSession): string[][] { return [['Holati', workerStateLabel(record.status)], ['Boshlangan', dateLabel(record.started_at_unix)], ['Yangilangan', dateLabel(record.updated_at_unix)], ['Ijrochi', record.worker_display_name], ['Ish ID', record.session_id], ['Bosqich ID', record.stage_node_id]] }
function batchFields(record: WorkerProfileBatch): string[][] {
  const fields = [['Partiya ID', record.batch_id], ['Hisobot holati', workerStateLabel(record.status)], ['WIP holati', workerStateLabel(record.wip_status)], ['Qayd miqdori', `${numberLabel(record.produced_qty)} ${record.uom}`], ['Mahsulot', record.label_item_name], ['Ijrochi', record.executor_name || record.worker_display_name], ['Boshlangan', dateLabel(record.started_at_unix)], ['Qayd vaqti', dateLabel(record.completed_at_unix)], ['Joylashuv', record.current_location], ['Oldingi partiya', record.parent_batch_id], ['Izoh', record.description], ['Holat izohi', record.status_detail.message]]
  for (const [field, label, unit] of [['finished_goods_kg', 'Tayyor mahsulot og‘irligi', 'kg'], ['finished_goods_meter', 'Tayyor mahsulot uzunligi', 'm'], ['bobina_kg', 'Bobina og‘irligi', 'kg'], ['return_ink_kg', 'Qaytgan bo‘yoq', 'kg'], ['total_waste', 'Jami chiqindi qaydi', ''], ['diameter', 'Diametr qaydi', ''], ['rezka_bosma_waste', 'Kesishdagi bosma chiqindisi', ''], ['rezka_lamination_waste', 'Kesishdagi laminatsiya chiqindisi', ''], ['rezka_edge_waste', 'Kesishdagi chet chiqindisi', '']] as const) if (record[field] !== null) fields.push([label, `${numberLabel(record[field])} ${unit}`.trim()])
  return fields
}
function eventFields(record: WorkerProfileEvent): string[][] { return [['Hodisa', workerStateLabel(record.action)], ['Avvalgi holat', workerStateLabel(record.from_state)], ['Keyingi holat', workerStateLabel(record.to_state)], ['Vaqt', dateLabel(record.created_at_unix)], ['Ijrochi', record.actor_display_name], ['Muammo bilan tugallangan', record.completed_with_issue ? 'Ha' : 'Yo‘q'], ['Muammo izohi', record.issue_note], ['Hodisa ID', record.event_id]] }
function RecordDetail({ selection, profile, batches, catalog, canViewOrders, canViewWip }: { selection: Selection; profile: WorkerProfile; batches: WorkerProfileBatch[]; catalog?: WorkerApparatusCatalog; canViewOrders: boolean; canViewWip: boolean }) {
  const record = selection.kind === 'session' ? profile.active_sessions.find(record => record.session_id === selection.id) : selection.kind === 'batch' ? batches.find(record => record.batch_id === selection.id) : profile.recent_logs.find(record => record.event_id === selection.id)
  if (!record) return <p className="text-sm text-muted-foreground">Qayd yangilangan ro‘yxatda topilmadi. Oynani yoping va qayta tanlang.</p>
  return <div className="space-y-4"><WorkerRecordDetail record={record} kind={selection.kind} apparatusLabel={apparatusName(record.apparatus, catalog, profile)} /><div className="flex flex-wrap gap-2">{canViewOrders && <Button type="button" variant="outline" size="sm" asChild><Link to={`/app/orders?selected=${encodeURIComponent(record.order_id)}`}>Buyurtmani ko‘rish<ExternalLink /></Link></Button>}{selection.kind === 'batch' && canViewWip && <Button type="button" variant="outline" size="sm" asChild><Link to={`/app/wip?selected=${encodeURIComponent(selection.id)}`}>WIP partiyasini ko‘rish<ExternalLink /></Link></Button>}</div></div>
}
