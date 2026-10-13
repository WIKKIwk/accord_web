import type { Page, ProductionSnapshot, Query, ResourceKind, Row, SavedMap, Session } from './api-types'

// Synthetic, local data for the explicitly selected Ko‘rish rejimi.
// This module never contacts an ERP server and never supplies live query results.
const demoTime = Date.parse('2026-10-12T10:30:00Z') / 1000
const printId = 'apparatus:default:asset-001'
const laminateId = 'apparatus:default:asset-002'
const cutId = 'apparatus:default:asset-003'
const packageId = 'apparatus:default:asset-004'

export const demoSession: Session = {
  token: 'local-preview-only',
  profile: { role: 'admin', display_name: 'Administrator', ref: 'demo-admin' },
  capabilities: [
    'admin.access', 'admin.activity.read', 'admin.settings.read',
    'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage',
    'catalog.item.read', 'catalog.item.create', 'catalog.item.bulk_move',
    'catalog.item_group.read', 'catalog.item_group.manage',
    'party.supplier.read', 'party.supplier.manage', 'party.customer.read',
    'party.customer.manage', 'role.capability.read', 'role.capability.manage',
    'raw_material.assign', 'raw_material.rule.manage',
    'inventory.movement.manage', 'factory.location.manage', 'rezka.split.manage',
  ],
  assigned_apparatus: [],
  assigned_apparatus_labels: [],
  assigned_item_groups: [],
  assigned_warehouses: [],
}

interface DemoOrder {
  id: string
  number: string
  product: string
  title: string
  customer: string
  kg: number
  meters: number
  width: number
  rolls: number
  status: string
  stage: 'print' | 'laminate' | 'cut' | 'package'
}

const orderSeeds: DemoOrder[] = [
  { id: 'demo-order-1048', number: 'AO-1048', product: 'QAD-001', title: 'Qahva uchun laminat qadoq', customer: 'Navro‘z Foods', kg: 1250, meters: 18200, width: 740, rolls: 12, status: 'in_progress', stage: 'print' },
  { id: 'demo-order-1047', number: 'AO-1047', product: 'QAD-002', title: 'Makaron qadoqlash plyonkasi', customer: 'Baraka mahsulotlari', kg: 860, meters: 14600, width: 680, rolls: 8, status: 'in_progress', stage: 'laminate' },
  { id: 'demo-order-1046', number: 'AO-1046', product: 'QAD-003', title: 'Choy uchun uch qatlamli qadoq', customer: 'Samarqand choy', kg: 540, meters: 9800, width: 620, rolls: 6, status: 'paused', stage: 'cut' },
  { id: 'demo-order-1045', number: 'AO-1045', product: 'QAD-004', title: 'Sut mahsulotlari yorlig‘i', customer: 'Sof sut', kg: 920, meters: 21000, width: 560, rolls: 10, status: 'pending', stage: 'print' },
  { id: 'demo-order-1044', number: 'AO-1044', product: 'QAD-005', title: 'Muzqaymoq o‘rami', customer: 'Salqin ta’m', kg: 480, meters: 12400, width: 520, rolls: 5, status: 'in_progress', stage: 'cut' },
  { id: 'demo-order-1043', number: 'AO-1043', product: 'QAD-006', title: 'Non mahsulotlari paketi', customer: 'Oltin boshoq', kg: 700, meters: 16700, width: 800, rolls: 7, status: 'pending', stage: 'laminate' },
  { id: 'demo-order-1042', number: 'AO-1042', product: 'QAD-007', title: 'Yong‘oq uchun paket', customer: 'Meva bog‘i', kg: 360, meters: 8100, width: 640, rolls: 4, status: 'print_preflight', stage: 'print' },
  { id: 'demo-order-1041', number: 'AO-1041', product: 'QAD-008', title: 'Pechenye uchun bosma plyonka', customer: 'Shirin dasturxon', kg: 1120, meters: 24500, width: 720, rolls: 11, status: 'in_progress', stage: 'package' },
  { id: 'demo-order-1040', number: 'AO-1040', product: 'QAD-009', title: 'Guruch uchun paket', customer: 'Zarafshon oziq-ovqat', kg: 630, meters: 13500, width: 700, rolls: 6, status: 'production_completed', stage: 'package' },
  { id: 'demo-order-1039', number: 'AO-1039', product: 'QAD-010', title: 'Ziravorlar uchun kichik qadoq', customer: 'Rayhon ziravorlari', kg: 280, meters: 7400, width: 460, rolls: 3, status: 'closed', stage: 'package' },
]

const stages = [
  { code: 'print', title: 'Bosma', apparatus: printId },
  { code: 'laminate', title: 'Laminatsiya', apparatus: laminateId },
  { code: 'cut', title: 'Kesish', apparatus: cutId },
  { code: 'package', title: 'Qadoqlash', apparatus: packageId },
]

function savedMap(order: DemoOrder): SavedMap {
  const nodes = stages.map((stage) => ({
    id: `${order.id}-${stage.code}`, kind: 'apparatus', title: stage.title,
    apparatus_id: stage.apparatus, role_code: 'aparatchi',
    item_code: order.product, qty_formula: 'base_length',
  }))
  return {
    map: {
      id: order.id, code: order.number, order_number: order.number,
      product_code: order.product, title: order.title, customer_name: order.customer,
      image_id: '', order_kg: order.kg, base_length: order.meters,
      width_mm: order.width, print_val_size_mm: order.width, roll_count: order.rolls,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id, branch: '' })),
    },
    program: {
      map_id: order.id, product_code: order.product,
      operations: nodes.map((node, index) => ({ order: index + 1, node_id: node.id, op_code: 'apparatus', args: { apparatus_id: node.apparatus_id } })),
    },
  }
}

const allMaps = orderSeeds.map(savedMap)
const openSeeds = orderSeeds.filter((order) => !['production_completed', 'closed'].includes(order.status))
const orderStatuses = Object.fromEntries(orderSeeds.map((order) => [order.id, {
  lifecycle_status: ['production_completed', 'closed'].includes(order.status) ? order.status : ['pending', 'print_preflight'].includes(order.status) ? 'released' : 'in_progress',
  order_status: order.status === 'pending' ? 'not_started' : ['production_completed', 'closed'].includes(order.status) ? 'completed' : order.status,
  work_status: order.status === 'pending' ? 'not_started' : ['production_completed', 'closed'].includes(order.status) ? 'completed' : order.status,
  flow_status: order.status === 'pending' ? 'not_started' : order.status === 'closed' ? 'completed' : 'in_progress',
  stock_status: order.status === 'closed' ? 'accepted' : 'pending', completed_with_issue_count: 0,
}]))

const stageStates = Object.fromEntries(orderSeeds.map((order) => {
  const activeIndex = stages.findIndex((stage) => stage.code === order.stage)
  return [order.id, Object.fromEntries(stages.map((stage, index) => [
    `${order.id}-${stage.code}`,
    ['production_completed', 'closed'].includes(order.status) || index < activeIndex
      ? 'completed'
      : index === activeIndex ? order.status : 'pending',
  ]))]
}))

export const demoProductionSnapshot: ProductionSnapshot = {
  ok: true, rev: 1, epoch: 'local-preview-2026-10-12', scope: 'admin',
  maps: allMaps.filter((saved) => openSeeds.some((order) => order.id === saved.map.id)),
  order_statuses: orderStatuses,
  order_customers: Object.fromEntries(orderSeeds.map((order) => [order.id, order.customer])),
  sequences: Object.fromEntries(stages.map((stage) => [stage.apparatus, openSeeds.filter((order) => order.stage === stage.code).map((order) => order.id)])),
  queue_states: Object.fromEntries(stages.map((stage) => [stage.apparatus, Object.fromEntries(openSeeds.map((order) => [order.id, stageStates[order.id]![`${order.id}-${stage.code}`]!]))])),
  stage_states: stageStates,
  queue_action_controls: {},
  order_controls: Object.fromEntries(openSeeds.map((order) => [order.id, { state: 'active' }])),
}

const mapRows: Row[] = allMaps.map((saved) => ({
  ...saved.map, map: saved.map, program: saved.program,
  status: orderStatuses[String(saved.map.id)]!.order_status,
  server_status: orderStatuses[String(saved.map.id)],
  order_control: { state: 'active' },
  ...orderStatuses[String(saved.map.id)],
}))

const apparatus: Row[] = [
  { id: printId, name: 'Flexo 01', operation: 'print', technology: 'flexographic', family: 'printing', kind: 'flexo', color_stations: 8, min_web_width_mm: 400, max_web_width_mm: 1200, lifecycle_state: 'active', source: 'canonical', sort_order: 10 },
  { id: laminateId, name: 'Laminator 01', operation: 'laminate', technology: 'solventless', family: 'lamination', kind: 'laminator', min_web_width_mm: 400, max_web_width_mm: 1000, lifecycle_state: 'active', source: 'canonical', sort_order: 20 },
  { id: cutId, name: 'Rezka 01', operation: 'cut', technology: 'slitting', family: 'cutting', kind: 'slitter', min_web_width_mm: 200, max_web_width_mm: 1200, lifecycle_state: 'active', source: 'canonical', sort_order: 30 },
  { id: packageId, name: 'Paket 01', operation: 'package', technology: 'bag-making', family: 'packaging', kind: 'bag-maker', min_web_width_mm: 200, max_web_width_mm: 800, lifecycle_state: 'active', source: 'canonical', sort_order: 40 },
  { id: 'apparatus:default:asset-005', name: 'Flexo 02', operation: 'print', technology: 'flexographic', family: 'printing', kind: 'flexo', color_stations: 6, min_web_width_mm: 300, max_web_width_mm: 900, lifecycle_state: 'active', source: 'canonical', sort_order: 50 },
  { id: 'apparatus:default:asset-006', name: 'Rezka 02', operation: 'cut', technology: 'slitting', family: 'cutting', kind: 'slitter', min_web_width_mm: 200, max_web_width_mm: 900, lifecycle_state: 'active', source: 'canonical', sort_order: 60 },
].map((row) => ({
  apparatus_id: row.id,
  display: { display_name: row.name, description: '' },
  execution_profile: { operation: row.operation, technology: row.technology, color_station_count: 'color_stations' in row ? row.color_stations : undefined, min_web_width_mm: row.min_web_width_mm, max_web_width_mm: row.max_web_width_mm },
  lifecycle: { state: row.lifecycle_state },
  source: row.source,
  sort_order: row.sort_order,
}))

const warehouses: Row[] = [
  { warehouse: 'Xomashyo ombori', company: 'Accord — namuna', is_group: false, parent_warehouse: '', product_count: 6, reserved_count: 3, assignment_count: 2, assigned_display_names: ['Jasur Karimov', 'Dilshod Rahimov'] },
  { warehouse: 'Tayyor mahsulot ombori', company: 'Accord — namuna', is_group: false, parent_warehouse: '', product_count: 4, reserved_count: 0, assignment_count: 1, assigned_display_names: ['Aziza Olimova'] },
  { warehouse: 'Yarim tayyor mahsulotlar', company: 'Accord — namuna', is_group: false, parent_warehouse: '', product_count: 8, reserved_count: 2, assignment_count: 1, assigned_display_names: ['Dilshod Rahimov'] },
  { warehouse: 'Qoliplar ombori', company: 'Accord — namuna', is_group: false, parent_warehouse: '', product_count: 12, reserved_count: 0, assignment_count: 1, assigned_display_names: ['Murod Sodiqov'] },
]

const materials: Row[] = [
  { id: 'demo-material-bopp', material: 'BOPP', name: 'BOPP', micron: '20', density: 0.91 },
  { id: 'demo-material-pet', material: 'PET', name: 'PET', micron: '12', density: 1.4 },
  { id: 'demo-material-pe', material: 'PE', name: 'PE', micron: '50', density: 0.92 },
  { id: 'demo-material-cpp', material: 'CPP', name: 'CPP', micron: '30', density: 0.9 },
  { id: 'demo-material-metpet', material: 'MET PET', name: 'MET PET', micron: '12', density: 1.4 },
  { id: 'demo-material-bopp25', material: 'BOPP', name: 'BOPP', micron: '25', density: 0.91 },
]

const rawStock: Row[] = materials.map((material, index) => ({
  id: `demo-raw-${index + 1}`, warehouse: 'Xomashyo ombori',
  item_code: `XOM-00${index + 1}`, item_name: `${material.material} ${material.micron} mkm`,
  barcode: `NAMUNA-RULON-00${index + 1}`, qty: [840, 620, 1250, 780, 410, 960][index],
  width_mm: [740, 680, 800, 620, 640, 720][index], micron: Number(material.micron),
  length_m: [18000, 21000, 15000, 14000, 9000, 16000][index], uom: 'kg',
  status: index < 3 ? 'reserved' : 'available',
  reserved_order_id: index < 3 ? orderSeeds[index]!.id : '',
  source_receipt_id: `demo-receipt-${index + 1}`,
}))

const stock: Row[] = [
  ...rawStock.map((row) => ({
    code: row.item_code, name: row.item_name, uom: row.uom, warehouse: row.warehouse,
    order_id: row.reserved_order_id, item_group: 'Xomashyo', on_hand_qty: row.qty,
    package_count: 1,
  })),
  ...orderSeeds.slice(6).map((order) => ({
    code: order.product, name: order.title, uom: 'kg', warehouse: 'Tayyor mahsulot ombori',
    order_id: order.id, item_group: 'Tayyor mahsulot', on_hand_qty: order.kg,
    package_count: order.rolls,
  })),
]

const items: Row[] = [
  ...orderSeeds.map((order, index) => ({
    code: order.product, name: order.title, uom: 'kg', item_group: 'Tayyor mahsulot',
    is_finished_goods: true, customer_names: [order.customer],
    customers: [{ ref: `demo-customer-${index + 1}`, name: order.customer, phone: '' }],
    created_at_unix: demoTime - 86400 * 14, updated_at_unix: demoTime - 3600,
  })),
  ...rawStock.map((row) => ({ code: row.item_code, name: row.item_name, uom: 'kg', item_group: 'Xomashyo', is_finished_goods: false, customers: [], customer_names: [] })),
]

const workers: Row[] = [
  { id: 'demo-worker-1', name: 'Jasur Karimov', phone: '', level: 'Master', principal_role: 'aparatchi', role_label: 'Bosma operatori', apparatus_id: printId, apparatus_display: 'Flexo 01' },
  { id: 'demo-worker-2', name: 'Dilshod Rahimov', phone: '', level: '1 - darajali', principal_role: 'aparatchi', role_label: 'Laminatsiya operatori', apparatus_id: laminateId, apparatus_display: 'Laminator 01' },
  { id: 'demo-worker-3', name: 'Aziza Olimova', phone: '', level: 'Brigader', principal_role: 'werka', role_label: 'Ombor mas’uli', apparatus_id: '', apparatus_display: '' },
  { id: 'demo-worker-4', name: 'Murod Sodiqov', phone: '', level: 'Master', principal_role: 'qolipchi', role_label: 'Qolipchi', apparatus_id: '', apparatus_display: '' },
  { id: 'demo-worker-5', name: 'Sherzod Akbarov', phone: '', level: '2 - darajali', principal_role: 'aparatchi', role_label: 'Kesish operatori', apparatus_id: cutId, apparatus_display: 'Rezka 01' },
  { id: 'demo-worker-6', name: 'Nargiza Ergasheva', phone: '', level: '3 - darajali', principal_role: 'aparatchi', role_label: 'Qadoqlash operatori', apparatus_id: packageId, apparatus_display: 'Paket 01' },
]

const wip: Row[] = openSeeds.map((order, index) => ({
  batch_id: `demo-wip-${index + 1}`, revision: 1, session_id: `demo-session-${index + 1}`,
  apparatus: stages.find((stage) => stage.code === order.stage)!.apparatus,
  order_id: order.id, action: 'roll_complete', status: 'completed',
  produced_qty: [3400, 2850, 1900, 4200, 2100, 3100, 1800, 4600][index], uom: 'm',
  label_item_code: order.product, label_item_name: order.title,
  executor_name: workers[index % workers.length]!.name, qr_payload: `DEMO-WIP-${index + 1}`,
  wip_status: index % 3 === 0 ? 'waiting' : index % 3 === 1 ? 'in_use' : 'processed',
  status_detail: { work_status: 'completed', wip_status: index % 3 === 0 ? 'waiting' : index % 3 === 1 ? 'in_use' : 'processed', flow_status: index % 3 === 0 ? 'waiting_next_stage' : index % 3 === 1 ? 'in_progress' : 'completed' },
  current_apparatus: stages.find((stage) => stage.code === order.stage)!.apparatus,
  current_location: 'Yarim tayyor mahsulotlar',
  next_apparatus: stages[Math.min(stages.findIndex((stage) => stage.code === order.stage) + 1, 3)]!.apparatus,
  started_at_unix: demoTime - 7200 - index * 1200, completed_at_unix: demoTime - 1800 - index * 900,
}))

const pending: Row[] = orderSeeds.filter((order) => order.status === 'pending').map((order, index) => ({
  id: `demo-pending-${index + 1}`, manager_name: 'Administrator',
  customer: order.customer, product: order.title, order_number: order.number,
  status: 'pending', kg: order.kg,
  template: {
    id: `demo-template-${index + 1}`, order_number: order.number, customer: order.customer, product: order.title,
    status: 'pending', kg: order.kg, frame_product_size_mm: 240,
    frame_count: 3, edge_allowance_mm: 10, waste_percent: 3,
    layers: [{ material: 'PET', micron: '12' }, { material: 'PE', micron: '50' }],
  },
  created_at_unix: demoTime - 3600 * (index + 1),
}))

const datasets: Record<ResourceKind, Row[]> = {
  orders: mapRows.filter((row) => !['production_completed', 'closed'].includes(String((row.server_status as Row).lifecycle_status))),
  maps: mapRows.filter((row) => !['production_completed', 'closed'].includes(String((row.server_status as Row).lifecycle_status))),
  pending,
  completed: orderSeeds.filter((order) => order.status === 'production_completed').map((order) => ({
    apparatus: packageId, order_id: order.id, completed_at_unix: demoTime - 4200,
    status: 'completed', issue_note: '',
  })),
  closed: orderSeeds.filter((order) => order.status === 'closed').map((order) => ({
    order_id: order.id, order_number: order.number, title: order.title,
    product_code: order.product, completed_at_unix: demoTime - 86400,
    closed_by_display_name: 'Administrator', logs: [], progress_batches: [],
  })),
  completion: orderSeeds.filter((order) => ['cut', 'package'].includes(order.stage) && order.status === 'in_progress').map((order, index) => ({
    event_id: `demo-completion-${index + 1}`, order_id: order.id, order_number: order.number,
    order_title: order.title, product_code: order.product,
    apparatus: stages.find((stage) => stage.code === order.stage)!.apparatus,
    apparatus_name: stages.find((stage) => stage.code === order.stage)!.title,
    worker_role: 'aparatchi', worker_ref: workers[index + 4]?.id,
    worker_display_name: workers[index + 4]?.name,
    description: 'Ishlab chiqarish bosqichini yakunlash so‘rovi',
    zero_metric_codes: [], notice_kind: 'completion_request', decision_required: true,
    created_at_unix: demoTime - 300 * (index + 1),
  })),
  wip,
  'opening-wip': [
    { batch_id: 'demo-opening-1', order_id: 'demo-order-1046', label_item_code: 'QAD-003', label_item_name: 'Choy uchun uch qatlamli qadoq', quantity: 1900, uom: 'm', wip_status: 'waiting', current_location: 'Yarim tayyor mahsulotlar', note: 'Ko‘rish rejimidagi boshlang‘ich qoldiq', created_at_unix: demoTime - 86400 },
    { batch_id: 'demo-opening-2', order_id: 'demo-order-1043', label_item_code: 'QAD-006', label_item_name: 'Non mahsulotlari paketi', quantity: 3100, uom: 'm', wip_status: 'waiting', current_location: 'Yarim tayyor mahsulotlar', note: 'Ko‘rish rejimidagi boshlang‘ich qoldiq', created_at_unix: demoTime - 86400 },
  ],
  items,
  'item-groups': [
    { name: 'Tayyor mahsulot', item_group_name: 'Tayyor mahsulot', parent_item_group: '', is_group: true },
    { name: 'Qadoqlash plyonkasi', item_group_name: 'Qadoqlash plyonkasi', parent_item_group: 'Tayyor mahsulot', is_group: false },
    { name: 'Paketlar', item_group_name: 'Paketlar', parent_item_group: 'Tayyor mahsulot', is_group: false },
    { name: 'Xomashyo', item_group_name: 'Xomashyo', parent_item_group: '', is_group: true },
    { name: 'Polimer plyonkalar', item_group_name: 'Polimer plyonkalar', parent_item_group: 'Xomashyo', is_group: false },
    { name: 'Qoliplar', item_group_name: 'Qoliplar', parent_item_group: '', is_group: false },
  ],
  apparatus,
  workers,
  suppliers: [
    { ref: 'demo-supplier-1', name: 'Polimer ta’minot', phone: '', blocked: false, removed: false, assigned_item_codes: ['XOM-001', 'XOM-002'], assigned_item_count: 2 },
    { ref: 'demo-supplier-2', name: 'Plyonka servis', phone: '', blocked: false, removed: false, assigned_item_codes: ['XOM-003', 'XOM-004'], assigned_item_count: 2 },
    { ref: 'demo-supplier-3', name: 'Material markazi', phone: '', blocked: false, removed: false, assigned_item_codes: ['XOM-005', 'XOM-006'], assigned_item_count: 2 },
  ],
  customers: orderSeeds.map((order, index) => ({
    ref: `demo-customer-${index + 1}`, name: order.customer, phone: '',
    blocked: false, removed: false,
    assigned_items: items.filter((item) => Array.isArray(item.customer_names) && item.customer_names.includes(order.customer)),
  })),
  warehouses,
  stock,
  'raw-materials': rawStock,
  users: [
    { id: 'demo-admin', entity_ref: 'demo-admin', name: 'Administrator', phone: '', source: 'admin', principal_role: 'admin', blocked: false, status: 'active', role_label: 'Administrator' },
    ...workers.map((worker) => ({ ...worker, entity_ref: worker.id, source: 'worker', blocked: false, status: 'active' })),
  ],
  roles: [
    { id: 'admin', label: 'Administrator', base_role: 'admin', system: true, capability_codes: demoSession.capabilities },
    { id: 'aparatchi', label: 'Uskuna operatori', base_role: 'aparatchi', system: true, capability_codes: ['apparatus.queue.read', 'apparatus.queue.manage'] },
    { id: 'werka', label: 'Ombor mas’uli', base_role: 'werka', system: true, capability_codes: ['catalog.item.read', 'inventory.movement.manage'] },
    { id: 'qolipchi', label: 'Qolipchi', base_role: 'qolipchi', system: true, capability_codes: ['qolip.manage'] },
    { id: 'material_taminotchi', label: 'Xomashyo ta’minotchisi', base_role: 'material_taminotchi', system: true, capability_codes: ['raw_material.assign'] },
  ],
  activity: [
    { id: 'demo-dispatch-1', created_label: '12.10.2026 15:10', created_at_unix: demoTime - 1200, supplier_name: 'Polimer ta’minot', item_name: 'BOPP 20 mkm', sent_qty: 840, accepted_qty: 840, uom: 'kg', status: 'accepted' },
    { id: 'demo-dispatch-2', created_label: '12.10.2026 15:00', created_at_unix: demoTime - 1800, supplier_name: 'Polimer ta’minot', item_name: 'PET 12 mkm', sent_qty: 620, accepted_qty: 620, uom: 'kg', status: 'accepted' },
    { id: 'demo-dispatch-3', created_label: '12.10.2026 14:50', created_at_unix: demoTime - 2400, supplier_name: 'Plyonka servis', item_name: 'PE 50 mkm', sent_qty: 1250, accepted_qty: 1250, uom: 'kg', status: 'accepted' },
    { id: 'demo-dispatch-4', created_label: '12.10.2026 14:30', created_at_unix: demoTime - 3600, supplier_name: 'Plyonka servis', item_name: 'CPP 30 mkm', sent_qty: 780, accepted_qty: 780, uom: 'kg', status: 'accepted' },
    { id: 'demo-dispatch-5', created_label: '12.10.2026 14:20', created_at_unix: demoTime - 4200, supplier_name: 'Material markazi', item_name: 'MET PET 12 mkm', sent_qty: 410, accepted_qty: 0, uom: 'kg', status: 'pending' },
  ],
  materials: materials.filter((material) => material.id !== 'demo-material-bopp25').map((material) => ({
    id: material.id, name: material.name, active: true, density_g_cm3: material.density,
    variants: (material.material === 'BOPP' ? [20, 25] : [Number(material.micron)]).map((micron) => ({ micron, coefficient: 1, actual_gsm: micron * Number(material.density) })),
  })),
  templates: pending.map((row) => ({ ...(row.template as Row), name: row.product, created_at_unix: row.created_at_unix })),
  locations: [
    { id: 'demo-location-1', name: 'Bosma sexi', kind: 'state', active: true, factory_location_id: 'demo-factory-location-1', apparatus: [{ id: printId, name: 'Flexo 01' }, { id: 'apparatus:default:asset-005', name: 'Flexo 02' }] },
    { id: 'demo-location-2', name: 'Laminatsiya sexi', kind: 'state', active: true, factory_location_id: 'demo-factory-location-2', apparatus: [{ id: laminateId, name: 'Laminator 01' }] },
    { id: 'demo-location-3', name: 'Kesish sexi', kind: 'state', active: true, factory_location_id: 'demo-factory-location-3', apparatus: [{ id: cutId, name: 'Rezka 01' }, { id: 'apparatus:default:asset-006', name: 'Rezka 02' }] },
    { id: 'demo-location-4', name: 'Qadoqlash sexi', kind: 'state', active: true, factory_location_id: 'demo-factory-location-4', apparatus: [{ id: packageId, name: 'Paket 01' }] },
    { id: 'demo-location-5', name: 'Xomashyo ombori', kind: 'warehouse', active: true, warehouse_id: 'Xomashyo ombori', apparatus: [] },
    { id: 'demo-location-6', name: 'Tayyor mahsulot ombori', kind: 'warehouse', active: true, warehouse_id: 'Tayyor mahsulot ombori', apparatus: [] },
  ],
  assets: rawStock.map((row, index) => ({
    kind: 'raw_material', asset_ref: row.id, item_code: row.item_code,
    item_name: row.item_name, identifier: row.barcode, qty: row.qty, uom: row.uom,
    status: row.status, custody_warehouse_id: 'Xomashyo ombori', custody_warehouse: row.warehouse,
    physical_location: { id: 'demo-location-5', kind: 'warehouse', name: 'Xomashyo ombori' },
    placement_version: index + 1,
  })),
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

export function getDemoPage(kind: ResourceKind, query: Query = {}): Page {
  let items = datasets[kind]
  const search = String(query.search ?? query.q ?? '').trim().toLocaleLowerCase('uz')
  if (search) items = items.filter((row) => JSON.stringify(row).toLocaleLowerCase('uz').includes(search))
  for (const field of ['warehouse', 'status', 'order_id', 'item_group', 'source', 'principal_role', 'apparatus', 'next_apparatus', 'current_location']) {
    const value = query[field]
    if (value !== undefined && value !== '' && value !== 'all') items = items.filter((row) => String(field === 'status' && kind === 'wip' ? row.wip_status : row[field]) === String(value))
  }
  if (query.group) items = items.filter((row) => row.item_group === query.group)
  if (query.role && query.role !== 'all') items = items.filter((row) => row.principal_role === query.role || row.level === query.role)
  const skip = positiveNumber(query.skip ?? query.offset, 0)
  const limit = Math.max(1, positiveNumber(query.take ?? query.limit, 50))
  return { items: structuredClone(items.slice(skip, skip + limit)), hasMore: skip + limit < items.length }
}
