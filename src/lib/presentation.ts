import type { ResourceKind, Row } from './api-types'
import { valueAt } from './api'

export type Column = { key: string; label: string; numeric?: boolean; status?: boolean; date?: boolean; trueLabel?: string; falseLabel?: string }
export type Field = { key: string; label: string; type?: 'number' | 'tel' | 'checkbox' | 'select'; required?: boolean; options?: { value: string; label: string }[]; initial?: string }
export type ResourceView = { columns: Column[]; singular: string; fields?: Field[] }
const name: Column = { key: 'name', label: 'Nomi' }
const phone: Column = { key: 'phone', label: 'Telefon' }
const namedFields: Field[] = [{ key: 'name', label: 'Nomi', required: true }, { key: 'phone', label: 'Telefon', type: 'tel' }]
export const views: Record<ResourceKind, ResourceView> = {
  orders: { singular: 'Buyurtma', columns: [{ key: 'order_number', label: 'Buyurtma' }, { key: 'title', label: 'Mahsulot' }, { key: 'customer_name', label: 'Mijoz' }, { key: 'order_kg', label: 'Reja, kg', numeric: true }, { key: 'status', label: 'Holati', status: true }] },
  maps: { singular: 'Ish xaritasi', columns: [{ key: 'title', label: 'Xarita' }, { key: 'product_code', label: 'Mahsulot kodi' }, { key: 'order_number', label: 'Buyurtma' }, { key: 'nodes.length', label: 'Xarita tugunlari', numeric: true }] },
  pending: { singular: 'Kutilayotgan buyurtma', columns: [{ key: 'template.order_number', label: 'Buyurtma' }, { key: 'template.product', label: 'Mahsulot' }, { key: 'template.customer', label: 'Mijoz' }, { key: 'template.kg', label: 'Miqdor, kg', numeric: true }, { key: 'manager_name', label: 'Mas’ul' }] },
  completed: { singular: 'Tugallangan ish', columns: [{ key: 'order_id', label: 'Buyurtma' }, { key: 'apparatus', label: 'Uskuna' }, { key: 'status', label: 'Natija', status: true }, { key: 'completed_at_unix', label: 'Yakunlangan', date: true }, { key: 'issue_note', label: 'Izoh' }] },
  closed: { singular: 'Yopilgan buyurtma', columns: [{ key: 'order_number', label: 'Buyurtma' }, { key: 'title', label: 'Mahsulot' }, { key: 'product_code', label: 'Mahsulot kodi' }, { key: 'closed_by_display_name', label: 'Yopgan foydalanuvchi' }, { key: 'completed_at_unix', label: 'Yakunlangan', date: true }] },
  completion: { singular: 'Yakunlash so‘rovi', columns: [{ key: 'order_number', label: 'Buyurtma' }, { key: 'order_title', label: 'Mahsulot' }, { key: 'apparatus', label: 'Uskuna' }, { key: 'worker_display_name', label: 'Xodim' }, { key: 'description', label: 'Izoh' }, { key: 'decision_required', label: 'Qaror', status: true, trueLabel: 'Qaror kutilmoqda', falseLabel: 'Axborot uchun' }, { key: 'created_at_unix', label: 'Yuborilgan', date: true }] },
  wip: { singular: 'WIP partiyasi', columns: [{ key: 'batch_id', label: 'Partiya' }, { key: 'order_id', label: 'Buyurtma' }, { key: 'label_item_name', label: 'Mahsulot' }, { key: 'current_location', label: 'Joylashuv' }, { key: 'produced_qty', label: 'Miqdor', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'wip_status', label: 'Holati', status: true }] },
  'opening-wip': { singular: 'Boshlang‘ich WIP', columns: [{ key: 'batch_id', label: 'Partiya' }, { key: 'order_id', label: 'Buyurtma' }, { key: 'label_item_name', label: 'Mahsulot' }, { key: 'current_location', label: 'Joylashuv' }, { key: 'quantity', label: 'Miqdor', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'wip_status', label: 'Holati', status: true }] },
  items: { singular: 'Mahsulot', columns: [name, { key: 'code', label: 'Kod' }, { key: 'item_group', label: 'Guruh' }, { key: 'uom', label: 'Birlik' }], fields: [{ key: 'code', label: 'Mahsulot kodi', required: true }, { key: 'name', label: 'Nomi', required: true }, { key: 'uom', label: 'O‘lchov birligi', required: true, initial: 'kg' }, { key: 'item_group', label: 'Material guruhi' }, { key: 'customer_ref', label: 'Mijoz identifikatori' }] },
  'item-groups': { singular: 'Material guruhi', columns: [{ key: 'item_group_name', label: 'Guruh' }, { key: 'name', label: 'Identifikator' }, { key: 'parent_item_group', label: 'Asosiy guruh' }, { key: 'is_group', label: 'Turi', trueLabel: 'Guruh', falseLabel: 'Yakuniy guruh' }] },
  apparatus: { singular: 'Uskuna', columns: [{ key: 'display.display_name', label: 'Uskuna' }, { key: 'apparatus_id', label: 'Kod' }, { key: 'execution_profile.operation', label: 'Operatsiya' }, { key: 'execution_profile.technology', label: 'Texnologiya' }, { key: 'lifecycle.state', label: 'Holati', status: true }] },
  workers: { singular: 'Xodim', columns: [name, phone, { key: 'level', label: 'Malaka darajasi' }], fields: [...namedFields, { key: 'level', label: 'Malaka darajasi', required: true, type: 'select', initial: 'Master', options: [{ value: 'Brigader', label: 'Brigadir' }, { value: 'Master', label: 'Usta' }, ...[1, 2, 3].map(n => ({ value: `${n} - darajali`, label: `${n}-daraja` }))] }] },
  suppliers: { singular: 'Ta’minotchi', columns: [name, phone, { key: 'ref', label: 'Identifikator' }, { key: 'assigned_item_count', label: 'Materiallar', numeric: true }], fields: namedFields },
  customers: { singular: 'Mijoz', columns: [name, phone, { key: 'ref', label: 'Identifikator' }], fields: namedFields },
  warehouses: { singular: 'Ombor', columns: [{ key: 'warehouse', label: 'Ombor' }, { key: 'company', label: 'Korxona' }, { key: 'parent_warehouse', label: 'Asosiy ombor' }, { key: 'is_group', label: 'Turi', trueLabel: 'Guruh', falseLabel: 'Ombor' }], fields: [{ key: 'warehouse', label: 'Ombor nomi', required: true }, { key: 'company', label: 'Korxona' }, { key: 'parent_warehouse', label: 'Asosiy ombor' }, { key: 'is_group', label: 'Ombor guruhi', type: 'checkbox' }] },
  stock: { singular: 'Ombor qoldig‘i', columns: [{ key: 'name', label: 'Mahsulot' }, { key: 'code', label: 'Kod' }, { key: 'on_hand_qty', label: 'Qoldiq', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'package_count', label: 'O‘ramlar', numeric: true }, { key: 'order_id', label: 'Buyurtma' }] },
  'raw-materials': { singular: 'Xomashyo ruloni', columns: [{ key: 'barcode', label: 'Shtrixkod' }, { key: 'item_name', label: 'Material' }, { key: 'warehouse', label: 'Ombor' }, { key: 'qty', label: 'Miqdor', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'width_mm', label: 'Kenglik, mm', numeric: true }, { key: 'micron', label: 'Mikron', numeric: true }, { key: 'status', label: 'Holati', status: true }, { key: 'reserved_order_id', label: 'Band buyurtma' }] },
  users: { singular: 'Foydalanuvchi', columns: [{ key: 'name', label: 'Ism' }, phone, { key: 'role_label', label: 'Vazifa' }, { key: 'principal_role', label: 'Rol' }, { key: 'status', label: 'Holati', status: true }], fields: [{ key: 'name', label: 'Ism', required: true }, { key: 'phone', label: 'Telefon', type: 'tel', required: true }, { key: 'role', label: 'Rol', type: 'select', required: true, initial: 'qolipchi', options: [{ value: 'qolipchi', label: 'Qolipchi' }, { value: 'boyoqchi', label: 'Bo‘yoqchi' }, { value: 'tayyorlov_masteri', label: 'Tayyorlov masteri' }, { value: 'homashyo_rezkachi', label: 'Xomashyo rezkachisi' }] }] },
  roles: { singular: 'Rol', columns: [{ key: 'label', label: 'Rol nomi' }, { key: 'id', label: 'Kod' }, { key: 'base_role', label: 'Asosiy rol' }, { key: 'capability_codes.length', label: 'Ruxsatlar', numeric: true }, { key: 'system', label: 'Turi', trueLabel: 'Tizim roli', falseLabel: 'Maxsus rol' }] },
  activity: { singular: 'Yuborish yozuvi', columns: [{ key: 'created_label', label: 'Vaqt' }, { key: 'supplier_name', label: 'Ta’minotchi' }, { key: 'item_name', label: 'Mahsulot' }, { key: 'sent_qty', label: 'Yuborilgan', numeric: true }, { key: 'accepted_qty', label: 'Qabul qilingan', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'status', label: 'Holati', status: true }] },
  materials: { singular: 'Kalkulyatsiya materiali', columns: [name, { key: 'density_g_cm3', label: 'Zichlik, g/cm³', numeric: true }, { key: 'variants.length', label: 'Mikron variantlari', numeric: true }, { key: 'active', label: 'Holati', status: true }] },
  templates: { singular: 'Buyurtma shabloni', columns: [name, { key: 'order_number', label: 'Buyurtma' }, { key: 'product', label: 'Mahsulot' }, { key: 'customer', label: 'Mijoz' }, { key: 'kg', label: 'Miqdor, kg', numeric: true }] },
  locations: { singular: 'Zavod joylashuvi', columns: [name, { key: 'id', label: 'Kod' }, { key: 'kind', label: 'Turi' }, { key: 'apparatus.length', label: 'Uskunalar', numeric: true }, { key: 'active', label: 'Holati', status: true }] },
  assets: { singular: 'Inventar', columns: [{ key: 'item_name', label: 'Mahsulot' }, { key: 'identifier', label: 'Identifikator' }, { key: 'kind', label: 'Turi' }, { key: 'custody_warehouse', label: 'Ombor' }, { key: 'physical_location.name', label: 'Joylashuv' }, { key: 'qty', label: 'Miqdor', numeric: true }, { key: 'uom', label: 'Birlik' }, { key: 'status', label: 'Holati', status: true }] },
}

export const vocabulary: Record<string, string> = {
  active: 'Faol', open: 'Ochiq', in_progress: 'Jarayonda', running: 'Jarayonda', processing: 'Jarayonda', pending: 'Kutilmoqda', queued: 'Navbatda', completed: 'Tugallangan', closed: 'Yopilgan', paused: 'To‘xtatilgan', blocked: 'Bloklangan', retired: 'Ishdan chiqarilgan', approved: 'Tasdiqlangan', waiting: 'Kutilmoqda',
  admin: 'Administrator', aparatchi: 'Apparatchi', werka: 'Omborchi', supplier: 'Ta’minotchi', customer: 'Mijoz', worker: 'Ishchi', qolipchi: 'Qolipchi', boyoqchi: 'Bo‘yoqchi', tayyorlov_masteri: 'Tayyorlov masteri', homashyo_rezkachi: 'Xomashyo rezkachisi',
  print: 'Bosma', laminate: 'Laminatsiya', cut: 'Kesish', package: 'Qadoqlash', glue: 'Yelimlash', rotogravure: 'Rotogravyura', flexographic: 'Fleksografiya', adhesive_lamination: 'Yelimli laminatsiya', extrusion_lamination: 'Ekstruzion laminatsiya', slitting: 'Rulon kesish', bag_making: 'Paket tayyorlash', cold_glue: 'Sovuq yelimlash', Master: 'Usta', Brigader: 'Brigadir',
  available: 'Mavjud', reserved: 'Band', in_use: 'Ishlatilmoqda', processed: 'Qayta ishlangan', received: 'Qabul qilingan', transferred: 'Ko‘chirilgan', consumed: 'Ishlatilgan', rejected: 'Rad etilgan', cancelled: 'Bekor qilingan', frozen: 'Muzlatilgan', print_preflight: 'Bosmaga tayyorlash', production_completed: 'Ishlab chiqarish tugagan', completed_with_issue: 'Muammo bilan tugallangan', released: 'Ishlab chiqarishga ochilgan', material_taminotchi: 'Material ta’minotchisi', raw_material: 'Xomashyo', wip: 'Yarim tayyor mahsulot', finished_goods: 'Tayyor mahsulot', warehouse: 'Ombor', factory_location: 'Zavod joyi', apparatus: 'Uskuna',
  not_started: 'Boshlanmagan', ready: 'Ishga tayyor', waiting_next_stage: 'Keyingi bosqich kutilmoqda', partially_completed: 'Qisman tugallangan', print_preflight_passed: 'Bosma tekshiruvidan o‘tgan', state: 'Zavod joyi', transit: 'Yo‘lda', accepted: 'Qabul qilingan', draft: 'Qoralama',
}
export function display(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Faol' : 'Nofaol'
  if (Array.isArray(value)) return `${value.length} ta`
  if (typeof value === 'object') return '—'
  return vocabulary[String(value)] ?? String(value)
}
export function numberLabel(value: unknown): string {
  if (value == null || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 3 }).format(n) : '—'
}
export function dateLabel(value: unknown): string {
  if (value == null || value === '') return '—'
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
export function cellLabel(column: Column, row: Row): string {
  const value = valueAt(row, column.key)
  if (column.date) return dateLabel(value)
  if (column.numeric) return numberLabel(value)
  if (typeof value === 'boolean') return value ? column.trueLabel ?? display(value) : column.falseLabel ?? display(value)
  return display(value)
}
export function statusFilterLabel(column: Column, state: string): string {
  if (state === 'true' || state === 'false') {
    const value = state === 'true'
    return value ? column.trueLabel ?? display(value) : column.falseLabel ?? display(value)
  }
  return display(state)
}
export function completionDecisionRequired(row: Row): boolean {
  return row.decision_required === true && typeof row.event_id === 'string' && row.event_id.trim().length > 0
}
export function rowIdentity(row: Row): string { return String(row.id ?? row.code ?? row.ref ?? row.warehouse ?? row.apparatus_id ?? row.batch_id ?? row.event_id ?? row.asset_ref ?? row.barcode ?? row.order_id ?? '') }
