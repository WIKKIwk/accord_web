import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, KeyRound, Loader2, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Checkbox } from './ui/checkbox'
import { Badge } from './ui/badge'
import { Alert, AlertDescription } from './ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { CatalogPicker } from './catalog-picker'
import { ApiClient, text } from '@/lib/api'
import type { Row } from '@/lib/api-types'
import { assignedItems, catalogAllowed, catalogMutation, groupParentChoices } from '@/lib/catalog-admin'
import type { CatalogAction, CatalogKind } from '@/lib/catalog-admin'
import { getDemoPage } from '@/lib/demo'
import { canViewPage, hasCapability } from '@/lib/permissions'
import { useSession } from '@/lib/session'
import { MutationScope } from '@/lib/mutation-scope'
import type { MutationLease } from '@/lib/mutation-scope'

const titles: Record<CatalogAction, string> = { edit: 'Tahrirlash', move: 'Guruhni o‘zgartirish', remove: 'O‘chirish', restore: 'Tiklash', block: 'Bloklash', unblock: 'Blokdan chiqarish', assign: 'Mahsulot biriktirish', unassign: 'Biriktirishni olib tashlash', regenerate: 'Kirish kodini yangilash' }

export function CatalogAdminControls({ kind, row, onSaved, onRemoved }: { kind: CatalogKind; row: Row; onSaved: () => void; onRemoved: () => void }) {
  const { client, demo, scope, session } = useSession()
  const queryClient = useQueryClient()
  const [action, setAction] = useState<CatalogAction | null>(null)
  const [input, setInput] = useState<Row>({})
  const [generatedCode, setGeneratedCode] = useState('')
  const [validation, setValidation] = useState('')
  const [mutations] = useState(() => new MutationScope())
  const currentScope = useRef(scope)
  currentScope.current = scope
  const inFlight = useRef(false)
  useEffect(() => () => mutations.cancelAll(), [scope, mutations])
  const party = kind === 'customers' || kind === 'suppliers'
  const groups = useQuery({
    queryKey: ['catalog-admin-groups', scope],
    queryFn: ({ signal }) => demo ? getDemoPage('item-groups', { limit: 500 }) : client!.listSnapshot('item-groups', {}, signal),
    enabled: (kind === 'items' || kind === 'item-groups') && action === 'move' && canViewPage(session, 'item-groups'),
  })
  const warehouses = useQuery({
    queryKey: ['warehouses-picker', scope],
    queryFn: ({ signal }) => demo ? getDemoPage('warehouses', { limit: 500 }) : client!.list('warehouses', { limit: 500 }, signal),
    enabled: kind === 'warehouses' && action === 'edit',
  })
  type Request = { action: CatalogAction; body: Row; row: Row; scope: string; client: ApiClient; lease: MutationLease }
  const mutation = useMutation({
    mutationFn: async (request: Request) => {
      const result = await catalogMutation(request.client, kind, request.row, request.action, request.body, request.lease.controller.signal)
      if (request.action === 'regenerate') {
        if (request.scope === currentScope.current && mutations.isCurrent(request.lease)) setGeneratedCode(text(result.generated_code, ''))
        delete result.generated_code
      }
      return result
    },
    onSuccess: (_result, request) => {
      if (request.scope !== currentScope.current || !mutations.isCurrent(request.lease)) return
      setAction(null)
      toast.success('O‘zgarish saqlandi.')
      void queryClient.invalidateQueries({ queryKey: ['resource', scope] })
      void queryClient.invalidateQueries({ queryKey: ['detail', scope] })
      void queryClient.invalidateQueries({ queryKey: ['catalog-picker-infinite', scope] })
      void queryClient.invalidateQueries({ queryKey: ['catalog-admin-groups', scope] })
      void queryClient.invalidateQueries({ queryKey: ['warehouses-picker', scope] })
      if (request.action === 'remove' || (kind === 'items' && request.action === 'edit' && request.body.code !== request.row.code)) onRemoved()
      else onSaved()
    },
    onSettled: (_data, _error, request) => { mutations.finish(request.lease); inFlight.current = false },
  })
  function open(next: CatalogAction, values: Row = {}) {
    if (mutation.isPending) return
    setInput({ ...row, ...values })
    setValidation('')
    mutation.reset()
    setAction(next)
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!action || !client || demo || inFlight.current || !catalogAllowed(session, kind, action)) return
    if (action === 'assign' && !text(input.item_code, '').trim()) { setValidation('Mahsulotni tanlang.'); return }
    if (action === 'move' && kind === 'items' && !text(input.item_group, '').trim()) { setValidation('Guruhni tanlang.'); return }
    inFlight.current = true
    mutation.mutate({ action, body: input, row: { ...row }, scope, client, lease: mutations.begin() })
  }
  const allowed = (next: CatalogAction) => catalogAllowed(session, kind, next)
  const disabled = demo || mutation.isPending
  const groupChoices = kind === 'item-groups' ? groupParentChoices(groups.data?.items ?? [], text(row.name, '')) : groups.data?.items.filter(group => !group.is_group) ?? []
  const items = assignedItems(row)
  const field = (key: string, label: string, required = false, type = 'text') => <div className="space-y-2"><Label htmlFor={`catalog-${kind}-${key}`}>{label}</Label><Input id={`catalog-${kind}-${key}`} value={text(input[key], '')} type={type} required={required} disabled={mutation.isPending} onChange={event => setInput(old => ({ ...old, [key]: event.target.value }))} /></div>
  return <div className="space-y-4 border-t pt-4">
    <div className="flex flex-wrap gap-2">
      {allowed('edit') && kind !== 'item-groups' && <Button variant="outline" disabled={disabled} onClick={() => open('edit')}><Pencil />{party ? 'Telefonni tahrirlash' : 'Tahrirlash'}</Button>}
      {(kind === 'items' || kind === 'item-groups') && allowed('move') && <Button variant="outline" disabled={disabled || !canViewPage(session, 'item-groups')} onClick={() => open('move', { parent: row.parent_item_group ?? '' })}>{kind === 'item-groups' ? 'Asosiy guruhni o‘zgartirish' : 'Guruhga ko‘chirish'}</Button>}
      {kind === 'suppliers' && allowed('block') && row.removed !== true && <Button variant="outline" disabled={disabled} onClick={() => open(row.blocked === true ? 'unblock' : 'block')}><Ban />{row.blocked === true ? 'Blokdan chiqarish' : 'Bloklash'}</Button>}
      {kind === 'suppliers' && allowed('restore') && row.removed === true && <Button variant="outline" disabled={disabled} onClick={() => open('restore')}><RotateCcw />Tiklash</Button>}
      {party && allowed('regenerate') && <Button variant="outline" disabled={disabled || row.code_locked === true || Number(row.code_retry_after_sec) > 0} onClick={() => open('regenerate')}><KeyRound />Kirish kodini yangilash</Button>}
      {kind !== 'item-groups' && row.removed !== true && allowed('remove') && <Button variant="outline" className="text-destructive" disabled={disabled} onClick={() => open('remove')}><Trash2 />O‘chirish</Button>}
    </div>
    {party && Number(row.code_retry_after_sec) > 0 && <p className="text-xs text-muted-foreground">Kodni yangilash uchun {Math.ceil(Number(row.code_retry_after_sec))} soniyadan so‘ng ma’lumotni yangilang.</p>}
    {party && <div className="space-y-3">
      <div className="flex items-center justify-between"><p className="text-sm font-medium">Biriktirilgan mahsulotlar <Badge variant="secondary">{items.length}</Badge></p>{allowed('assign') && <Button size="sm" variant="outline" disabled={disabled || !hasCapability(session, 'catalog.item.read')} onClick={() => open('assign', { item_code: '', item_name: '' })}><Plus />Biriktirish</Button>}</div>
      {items.length ? <ul className="divide-y rounded-lg border">{items.map(item => <li key={text(item.code, '')} className="flex items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{text(item.name)}</p><p className="text-xs text-muted-foreground">{text(item.code)} · {text(item.uom)}</p></div>{allowed('unassign') && <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={`${text(item.name)} biriktirishini olib tashlash`} disabled={disabled} onClick={() => open('unassign', { item_code: item.code, item_name: item.name })}><X /></Button>}</li>)}</ul> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Mahsulotlar hali biriktirilmagan.</p>}
    </div>}
    <Dialog open={Boolean(action)} onOpenChange={openValue => { if (!openValue && !mutation.isPending) { setAction(null); mutation.reset() } }}>
      <DialogContent><DialogHeader><DialogTitle>{action ? titles[action] : ''}</DialogTitle><DialogDescription>{text(row.name ?? row.warehouse ?? row.item_group_name)}{action === 'regenerate' ? ' uchun avvalgi kod bekor qilinadi. Yangi kod faqat shu oynada ko‘rsatiladi.' : action === 'remove' ? kind === 'warehouses' ? ' ombori faqat bo‘sh bo‘lsa o‘chiriladi. Ichidagi mahsulotlar o‘chirilmaydi.' : ' yozuvini o‘chirishni tasdiqlang.' : action === 'unassign' ? `: ${text(input.item_name ?? input.item_code)} biriktirishini olib tashlashni tasdiqlang.` : ' uchun o‘zgarishlarni tasdiqlang.'}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {action === 'edit' && kind === 'items' && <>{field('code', 'Mahsulot kodi', true)}{field('name', 'Nomi', true)}</>}
          {action === 'edit' && party && field('phone', 'Telefon', false, 'tel')}
          {action === 'edit' && kind === 'warehouses' && <>
            {field('company', 'Korxona')}
            <div className="space-y-2"><Label htmlFor="catalog-parent-warehouse">Asosiy ombor</Label><Select value={text(input.parent_warehouse, '') || '__root__'} onValueChange={value => setInput(old => ({ ...old, parent_warehouse: value === '__root__' ? '' : value }))} disabled={mutation.isPending || warehouses.isPending}><SelectTrigger id="catalog-parent-warehouse"><SelectValue placeholder="Asosiy omborni tanlang" /></SelectTrigger><SelectContent><SelectItem value="__root__">Asosiy daraja</SelectItem>{warehouses.data?.items.filter(warehouse => warehouse.is_group && warehouse.warehouse !== row.warehouse).map(warehouse => <SelectItem key={text(warehouse.warehouse)} value={text(warehouse.warehouse)}>{text(warehouse.warehouse)}</SelectItem>)}</SelectContent></Select></div>
            <div className="flex items-center gap-2"><Checkbox id="catalog-is-group" checked={input.is_group === true} disabled={mutation.isPending} onCheckedChange={value => setInput(old => ({ ...old, is_group: value === true }))} /><Label htmlFor="catalog-is-group">Ombor guruhi</Label></div>
            {warehouses.error && <Alert variant="destructive"><AlertDescription>{warehouses.error.message}<Button type="button" variant="outline" onClick={() => void warehouses.refetch()}>Qayta urinish</Button></AlertDescription></Alert>}
          </>}
          {action === 'move' && <div className="space-y-2"><Label htmlFor="catalog-group">{kind === 'item-groups' ? 'Asosiy guruh' : 'Mahsulot guruhi'}</Label><Select value={text(input[kind === 'item-groups' ? 'parent' : 'item_group'], '') || '__root__'} disabled={mutation.isPending || groups.isPending} onValueChange={value => setInput(old => ({ ...old, [kind === 'item-groups' ? 'parent' : 'item_group']: value === '__root__' ? '' : value }))}><SelectTrigger id="catalog-group"><SelectValue placeholder="Guruhni tanlang" /></SelectTrigger><SelectContent>{kind === 'item-groups' && <SelectItem value="__root__">Asosiy daraja</SelectItem>}{groupChoices.map(group => <SelectItem key={text(group.name)} value={text(group.name)}>{text(group.item_group_name ?? group.name)}</SelectItem>)}</SelectContent></Select>{groups.error && <Alert variant="destructive"><AlertDescription>{groups.error.message}<Button type="button" variant="outline" onClick={() => void groups.refetch()}>Qayta urinish</Button></AlertDescription></Alert>}</div>}
          {action === 'assign' && <CatalogPicker id="catalog-assigned-item" kind="items" label="Mahsulot" value={text(input.item_code, '')} selectedLabel={text(input.item_name, '')} calculateProducts={kind === 'customers'} onSelect={item => setInput(old => ({ ...old, item_code: item.code, item_name: item.name }))} />}
          {(validation || mutation.error) && <Alert variant="destructive"><AlertDescription>{validation || mutation.error?.message}</AlertDescription></Alert>}
          <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setAction(null)}>Bekor qilish</Button><Button type="submit" variant={action === 'remove' ? 'destructive' : 'default'} disabled={mutation.isPending || demo || (action === 'move' && (groups.isPending || groups.isError)) || (kind === 'warehouses' && action === 'edit' && (warehouses.isPending || warehouses.isError))}>{mutation.isPending && <Loader2 className="animate-spin" />}{action === 'edit' || action === 'move' ? 'Saqlash' : 'Tasdiqlash'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(generatedCode)} onOpenChange={openValue => { if (!openValue) { setGeneratedCode(''); mutation.reset() } }}><DialogContent><DialogHeader><DialogTitle>Yangi kirish kodi</DialogTitle><DialogDescription>Kodni hisob egasiga xavfsiz tarzda yetkazing. Oyna yopilgach kod bu yerda saqlanmaydi.</DialogDescription></DialogHeader><Input aria-label="Yangi kirish kodi" readOnly autoComplete="off" value={generatedCode} /><DialogFooter><Button onClick={() => { setGeneratedCode(''); mutation.reset() }}>Yopish</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

