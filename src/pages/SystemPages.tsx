import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertCircle, CheckCircle2, Cpu, Database, HardDrive, Loader2, RefreshCw, Save, Server } from 'lucide-react'
import type { ApiClient, SettingsInput } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { MutationScope } from '@/lib/mutation-scope'
import type { MutationLease } from '@/lib/mutation-scope'
import { useSession } from '@/lib/session'
import { hasCapability } from '@/lib/permissions'
import { display, numberLabel } from '@/lib/presentation'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const settingsKeys = ['default_target_warehouse', 'default_uom', 'admin_name', 'admin_phone', 'werka_name', 'werka_phone'] as const

const demoSettings: SettingsInput = {
  default_target_warehouse: 'Tayyor mahsulot ombori', default_uom: 'kg',
  admin_name: 'Administrator', admin_phone: '+998 90 000 00 01',
  werka_name: 'Ombor mas’uli', werka_phone: '+998 90 000 00 02',
}

const demoMonitor: Row = {
  server: { status: 'running', uptime_seconds: 278640 },
  database: { configured: true, reachable: true, status: 'online', ping_ms: 3 },
  runtime: { cpu_percent: 18, memory_percent: 38, memory_used_mb: 389, memory_total_mb: 1024, disk_percent: 24, disk_used_mb: 12288, disk_total_mb: 51200, disk_available_mb: 38912 },
  backups: {
    healthy: true, snapshot_count: 3, snapshots: [
      { id: 'demo-backup-1', artifact_name: 'accord-2026-10-12.backup', status: 'ready', source: 'automatic', created_at_unix: 1791775800, size_bytes: 158334976, verified: true },
      { id: 'demo-backup-2', artifact_name: 'accord-2026-10-11.backup', status: 'ready', source: 'manual', created_at_unix: 1791689400, size_bytes: 155189248, verified: true },
      { id: 'demo-backup-3', artifact_name: 'accord-2026-10-10.backup', status: 'ready', source: 'automatic', created_at_unix: 1791603000, size_bytes: 152043520, verified: true },
    ],
  },
}

function safeSettings(value: Row): SettingsInput {
  if (!settingsKeys.every(key => typeof value[key] === 'string')) throw new Error('Sozlamalar to‘liq kelmadi. Qayta yangilang.')
  return Object.fromEntries(settingsKeys.map(key => [key, value[key]])) as unknown as SettingsInput
}

export function settingsUpdate(initial: SettingsInput, values: SettingsInput): SettingsInput {
  return {
    default_target_warehouse: values.default_target_warehouse.trim(),
    default_uom: values.default_uom.trim(),
    werka_name: values.werka_name.trim(), werka_phone: values.werka_phone.trim(),
    admin_name: initial.admin_name, admin_phone: initial.admin_phone,
  }
}

export function settingsValidation(input: SettingsInput): string {
  if (!input.werka_phone.trim()) return ''
  const clean = input.werka_phone.replace(/[ ()-]/g, '').trim()
  const digits = clean.replace(/\+/g, '')
  // PostgresAuthStore uses auth::normalize_phone after removing these separators.
  return /^\d+$/.test(digits) && digits.length >= 9 && digits.length <= 12
    ? '' : 'Ombor mas’ulining telefonida 9–12 ta raqam bo‘lishi kerak.'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ma’lumotni olish imkoni bo‘lmadi. Qayta urinib ko‘ring.'
}

function record(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : {}
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function uptimeLabel(value: unknown): string {
  const seconds = numeric(value)
  if (seconds === null || seconds < 0) return '—'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${numberLabel(days)} kun ${hours % 24} soat`
  if (hours > 0) return `${hours} soat ${minutes % 60} daqiqa`
  return `${minutes} daqiqa`
}

function dateLabel(value: unknown): string {
  const seconds = numeric(value)
  if (seconds === null || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) : '—'
}

export function backupStatus(value: unknown): string {
  const labels: Record<string, string> = {
    ready: 'Tayyor', failed: 'Xatolik', verifying: 'Tekshirilmoqda',
    running: 'Tayyorlanmoqda', queued: 'Navbatda',
  }
  return labels[String(value)] ?? 'Noma’lum'
}

export function backupSource(value: unknown): string {
  const labels: Record<string, string> = {
    automatic: 'Avtomatik', manual: 'Qo‘lda', legacy: 'Oldingi nusxa',
    imported: 'Import qilingan', pre_restore: 'Tiklashdan oldin',
  }
  return labels[String(value)] ?? 'Noma’lum'
}

export function verifiedBackupCount(backups: Row): number {
  const count = numeric(backups.snapshot_count)
  if (count !== null && Number.isInteger(count) && count >= 0) return count
  return Array.isArray(backups.snapshots)
    ? backups.snapshots.map(record).filter(snapshot => snapshot.status === 'ready' && snapshot.verified === true).length
    : 0
}

export function backupInProgress(job: Row): boolean {
  return typeof job.id === 'string' && job.id.length > 0 && ['queued', 'running', 'verifying'].includes(String(job.status))
}

export function runtimePercent(runtime: Row, resource: 'cpu' | 'memory' | 'disk'): number | null {
  if (resource !== 'cpu' && (numeric(runtime[`${resource}_total_mb`]) ?? 0) <= 0) return null
  const value = numeric(runtime[`${resource}_percent`])
  return value !== null && value >= 0 && value <= 100 ? value : null
}

function capacityLabel(runtime: Row, resource: 'memory' | 'disk'): string {
  return (numeric(runtime[`${resource}_total_mb`]) ?? 0) > 0
    ? `${numberLabel(runtime[`${resource}_used_mb`])} / ${numberLabel(runtime[`${resource}_total_mb`])} MB`
    : 'Ma’lumot mavjud emas'
}

function LoadingCards() {
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Ma’lumot yuklanmoqda">
    {[0, 1, 2, 3].map(index => <Card key={index}><CardHeader><Skeleton className="h-4 w-24" /></CardHeader><CardContent className="space-y-3"><Skeleton className="h-8 w-32" /><Skeleton className="h-4 w-full" /></CardContent></Card>)}
  </div>
}

export function SettingsPage() {
  const { client, demo, scope } = useSession()
  const queryKey = ['settings', scope]
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (demo) return demoSettings
      if (!client) throw new Error('ERP serveriga ulaning.')
      return safeSettings(await client.settings(signal))
    },
    staleTime: 60_000, refetchOnWindowFocus: false,
  })
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Sozlamalar</h1><p className="text-sm text-muted-foreground">Ishlab chiqarish, ombor va mas’ul foydalanuvchilar sozlamalari.</p></div>
      <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw />Yangilash</Button>
    </div>
    {query.isError && <Alert variant="destructive"><AlertCircle /><AlertTitle>Sozlamalar olinmadi</AlertTitle><AlertDescription>{errorMessage(query.error)}</AlertDescription></Alert>}
    {query.isPending ? <LoadingCards /> : query.data ? <SettingsForm key={scope} initial={query.data} /> : null}
  </>
}

function SettingsForm({ initial }: { initial: SettingsInput }) {
  const { client, demo, scope, session, endpoint, connection, reconnect } = useSession()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<SettingsInput>(initial)
  const [validation, setValidation] = useState('')
  const [saved, setSaved] = useState(false)
  const [mutations] = useState(() => new MutationScope())
  const currentScope = useRef(scope)
  currentScope.current = scope
  useEffect(() => { setValues(initial) }, [initial])
  useEffect(() => () => { mutations.cancelAll() }, [mutations, scope])
  type SaveRequest = { input: SettingsInput; scope: string; client: ApiClient | null; demo: boolean; lease: MutationLease }
  function isCurrent(request: SaveRequest): boolean {
    return request.scope === currentScope.current && mutations.isCurrent(request.lease)
  }
  const mutation = useMutation({
    mutationFn: async (request: SaveRequest) => {
      if (!isCurrent(request)) throw new DOMException('So‘rov bekor qilindi.', 'AbortError')
      if (request.demo || !request.client) throw new Error('Ko‘rish rejimida o‘zgarishlar saqlanmaydi.')
      return request.client.saveSettings(request.input, request.lease.controller.signal)
    },
    onSuccess: (_data, request) => {
      if (!isCurrent(request)) return
      setSaved(true)
      void queryClient.invalidateQueries({ queryKey: ['settings', request.scope], exact: true })
    },
    onSettled: (_data, _error, request) => mutations.finish(request.lease),
  })
  const dirty = settingsKeys.some(key => values[key] !== initial[key])

  function change(key: keyof SettingsInput, value: string) {
    setValues(current => ({ ...current, [key]: value }))
    setValidation('')
    setSaved(false)
    mutation.reset()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (demo || !client || mutation.isPending || !dirty || !hasCapability(session, 'admin.settings.manage')) return
    const trimmed = settingsUpdate(initial, values)
    const invalid = settingsValidation(trimmed)
    if (invalid) {
      setValidation(invalid)
      return
    }
    setValidation('')
    setSaved(false)
    mutation.mutate({ input: trimmed, scope, client, demo, lease: mutations.begin() })
  }

  function field(key: keyof SettingsInput, label: string, type = 'text', readOnly = false) {
    return <div className="space-y-2"><Label htmlFor={`setting-${key}`}>{label}</Label><Input id={`setting-${key}`} name={key} type={type} value={values[key]} readOnly={readOnly || !hasCapability(session, 'admin.settings.manage')} autoComplete="off" disabled={mutation.isPending} onChange={event => change(key, event.target.value)} />{key === 'default_uom' && <p className="text-xs text-muted-foreground">Bo‘sh qoldirilsa, Kg ishlatiladi.</p>}</div>
  }

  return <form onSubmit={submit} className="space-y-5">
    {demo && <Alert><AlertCircle /><AlertTitle>Ko‘rish rejimi</AlertTitle><AlertDescription>Sozlamalar namuna sifatida ko‘rsatilmoqda. Bu rejimda o‘zgarishlar saqlanmaydi.</AlertDescription></Alert>}
    {(validation || mutation.isError) && <Alert variant="destructive"><AlertCircle /><AlertTitle>Saqlash bajarilmadi</AlertTitle><AlertDescription>{validation || errorMessage(mutation.error)}</AlertDescription></Alert>}
    {saved && <Alert><CheckCircle2 /><AlertTitle>Sozlamalar saqlandi</AlertTitle><AlertDescription>O‘zgarishlar ERP serverida saqlandi.</AlertDescription></Alert>}
    <Tabs defaultValue="general">
      <TabsList><TabsTrigger value="general">Umumiy</TabsTrigger><TabsTrigger value="people">Mas’ullar</TabsTrigger><TabsTrigger value="connection">Ulanish</TabsTrigger></TabsList>
      <TabsContent value="general" className="pt-4"><Card><CardHeader><CardTitle>Ish jarayoni</CardTitle><CardDescription>Mahsulot qabuli uchun boshlang‘ich qiymatlar.</CardDescription></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">
        {field('default_target_warehouse', 'Asosiy qabul ombori')}
        {field('default_uom', 'O‘lchov birligi')}
      </CardContent></Card></TabsContent>
      <TabsContent value="people" className="space-y-4 pt-4">
        <Card><CardHeader><CardTitle>Administrator</CardTitle><CardDescription>Asosiy hisob ma’lumotlari.</CardDescription></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">{field('admin_name', 'Ism', 'text', true)}{field('admin_phone', 'Telefon', 'tel', true)}</CardContent></Card>
        <Card><CardHeader><CardTitle>Ombor mas’uli</CardTitle><CardDescription>Ombor ishlarini boshqaradigan foydalanuvchi.</CardDescription></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">{field('werka_name', 'Ism')}{field('werka_phone', 'Telefon', 'tel')}</CardContent></Card>
      </TabsContent>
      <TabsContent value="connection" className="pt-4"><Card><CardHeader><CardTitle>ERP ulanishi</CardTitle><CardDescription>Joriy server va hisob.</CardDescription></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="settings-endpoint">Server manzili</Label><Input id="settings-endpoint" value={demo ? 'Ko‘rish rejimi' : endpoint} readOnly /></div>
        <div className="space-y-2"><Label htmlFor="settings-user">Foydalanuvchi</Label><Input id="settings-user" value={session?.profile.display_name ?? ''} readOnly /></div>
        <div className="flex items-center gap-3"><Badge variant={connection === 'offline' ? 'destructive' : 'secondary'}>{demo ? 'Namuna' : connection === 'online' ? 'Ulangan' : connection === 'checking' ? 'Tekshirilmoqda' : 'Ulanish uzilgan'}</Badge><Button type="button" variant="outline" disabled={demo || connection === 'checking'} onClick={() => void reconnect()}><RefreshCw />Ulanishni tekshirish</Button></div>
      </CardContent></Card></TabsContent>
    </Tabs>
    <div className="flex flex-wrap items-center justify-end gap-3">
      <Button type="button" variant="outline" disabled={!dirty || mutation.isPending} onClick={() => { setValues(initial); setValidation(''); setSaved(false); mutation.reset() }}>Bekor qilish</Button>
      <Button type="submit" disabled={demo || !dirty || mutation.isPending || !hasCapability(session, 'admin.settings.manage')}>{mutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}{mutation.isPending ? 'Saqlanmoqda' : 'Saqlash'}</Button>
    </div>
  </form>
}

export function ServerPage() {
  const { client, demo, scope } = useSession()
  const query = useQuery({
    queryKey: ['server-monitor', scope],
    queryFn: async ({ signal }) => {
      if (demo) return demoMonitor
      if (!client) throw new Error('ERP serveriga ulaning.')
      return client.monitor(signal)
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const server = record(query.data?.server)
  const database = record(query.data?.database)
  const runtime = record(query.data?.runtime)
  const backups = record(query.data?.backups)
  const snapshots = Array.isArray(backups.snapshots) ? backups.snapshots.map(record) : []
  const activeJob = record(backups.active_job)
  const databaseKnown = typeof database.reachable === 'boolean'
  const running = server.status === 'running'

  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Server holati</h1><p className="text-sm text-muted-foreground">ERP xizmatining ishlashi va zaxira nusxalar holati.</p></div>
      <div className="flex flex-wrap items-center gap-3">{query.dataUpdatedAt > 0 && <span className="text-xs text-muted-foreground">Yangilangan: {new Intl.DateTimeFormat('uz-UZ', { timeStyle: 'short' }).format(query.dataUpdatedAt)}</span>}<Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw />Yangilash</Button></div>
    </div>
    {query.isError && <Alert variant="destructive"><AlertCircle /><AlertTitle>Server holati olinmadi</AlertTitle><AlertDescription>{errorMessage(query.error)}{query.data && ' Oxirgi olingan ma’lumotlar ko‘rsatilmoqda.'}</AlertDescription></Alert>}
    {query.isPending ? <LoadingCards /> : query.data && <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card><CardHeader><CardDescription className="flex items-center gap-2"><Server />ERP xizmati</CardDescription><CardTitle>{running ? 'Ishlamoqda' : display(server.status)}</CardTitle></CardHeader><CardContent><Badge variant={running ? 'secondary' : 'outline'}>{running ? 'Faol' : 'Tekshirish kerak'}</Badge></CardContent></Card>
        <Card><CardHeader><CardDescription className="flex items-center gap-2"><Activity />Uzluksiz ishlash vaqti</CardDescription><CardTitle>{uptimeLabel(server.uptime_seconds)}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">Oxirgi ishga tushirilganidan beri</p></CardContent></Card>
        <Card><CardHeader><CardDescription className="flex items-center gap-2"><Database />Ma’lumotlar bazasi</CardDescription><CardTitle>{!databaseKnown ? '—' : database.reachable ? 'Ulangan' : 'Ulanish yo‘q'}</CardTitle></CardHeader><CardContent><Badge variant={databaseKnown && !database.reachable ? 'destructive' : 'secondary'}>{database.configured === false ? 'Sozlanmagan' : databaseKnown && database.reachable ? 'Faol' : 'Tekshirish kerak'}</Badge></CardContent></Card>
        <Card><CardHeader><CardDescription className="flex items-center gap-2"><Activity />Javob vaqti</CardDescription><CardTitle>{numeric(database.ping_ms) !== null && database.reachable ? `${numberLabel(database.ping_ms)} ms` : '—'}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">Ma’lumotlar bazasi bilan ulanish</p></CardContent></Card>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <RuntimeCard title="Protsessor" icon="cpu" value={runtimePercent(runtime, 'cpu')} description="Yuklama ko‘rsatkichi" />
        <RuntimeCard title="Tezkor xotira" icon="memory" value={runtimePercent(runtime, 'memory')} description={capacityLabel(runtime, 'memory')} />
        <RuntimeCard title="Disk" icon="disk" value={runtimePercent(runtime, 'disk')} description={capacityLabel(runtime, 'disk')} />
      </div>
      <Card>
        <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><CardTitle>Zaxira nusxalar</CardTitle><CardDescription>{verifiedBackupCount(backups)} ta tayyor, tekshirilgan nusxa</CardDescription></div><Badge variant={backups.healthy === false ? 'destructive' : 'outline'}>{backups.healthy === true ? 'Holati yaxshi' : backups.healthy === false ? 'Tekshirish kerak' : 'Holati noma’lum'}</Badge></div></CardHeader>
        <CardContent className="space-y-4">
          {backupInProgress(activeJob) && <Alert><Activity /><AlertTitle>Zaxira nusxa jarayoni</AlertTitle><AlertDescription>{backupStatus(activeJob.status)}</AlertDescription></Alert>}
          {backups.healthy === false && <Alert variant="destructive"><AlertCircle /><AlertTitle>Zaxira nusxalar holatini tekshiring</AlertTitle><AlertDescription>Server zaxira nusxalar bilan bog‘liq muammo haqida xabar berdi.</AlertDescription></Alert>}
          <Table><TableHeader><TableRow><TableHead>Nusxa</TableHead><TableHead>Yaratilgan</TableHead><TableHead>Manba</TableHead><TableHead className="text-right">Hajmi</TableHead><TableHead>Holati</TableHead><TableHead>Tekshiruv</TableHead></TableRow></TableHeader><TableBody>
            {snapshots.length === 0 ? <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Zaxira nusxalar hali mavjud emas.</TableCell></TableRow> : snapshots.map((snapshot, index) => <TableRow key={typeof snapshot.id === 'string' ? snapshot.id : index}>
              <TableCell className="font-medium">{display(snapshot.artifact_name || snapshot.id)}</TableCell><TableCell className="whitespace-nowrap">{dateLabel(snapshot.created_at_unix)}</TableCell><TableCell>{backupSource(snapshot.source)}</TableCell><TableCell className="text-right whitespace-nowrap">{numeric(snapshot.size_bytes) !== null ? `${numberLabel(Number(snapshot.size_bytes) / 1048576)} MB` : '—'}</TableCell><TableCell><Badge variant={snapshot.status === 'failed' ? 'destructive' : 'secondary'}>{backupStatus(snapshot.status)}</Badge></TableCell><TableCell>{snapshot.verified === true ? 'Tasdiqlangan' : snapshot.verified === false ? 'Tasdiqlanmagan' : '—'}</TableCell>
            </TableRow>)}
          </TableBody></Table>
        </CardContent>
        <CardFooter><p className="text-xs text-muted-foreground">Diskda bo‘sh joy: {(numeric(runtime.disk_total_mb) ?? 0) > 0 ? `${numberLabel(runtime.disk_available_mb)} MB` : '—'}</p></CardFooter>
      </Card>
    </>}
  </>
}

function RuntimeCard({ title, icon, value, description }: { title: string; icon: 'cpu' | 'memory' | 'disk'; value: unknown; description: string }) {
  const percent = numeric(value)
  const Icon = icon === 'cpu' ? Cpu : icon === 'disk' ? HardDrive : Server
  return <Card><CardHeader><CardDescription className="flex items-center gap-2"><Icon />{title}</CardDescription><CardTitle>{percent === null ? '—' : `${numberLabel(percent)}%`}</CardTitle></CardHeader><CardContent className="space-y-3">{percent !== null && <Progress value={percent} aria-label={`${title} ko‘rsatkichi`} />}<p className="text-xs text-muted-foreground">{description}</p></CardContent></Card>
}
