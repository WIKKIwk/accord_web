import { refreshFixtureCanonical } from './erp-canonical.mjs';

/** Synthetic data only. Nothing here is copied from an account or database. */
export const fixtureLogin = { phone: '+998900000001', code: 'QA-CODE' };
export const fixtureToken = 'fixture-admin-session';
export const fixtureSecondLogin = { phone: '+998900000002', code: 'QA-SECOND' };
export const fixtureSecondToken = 'fixture-admin-session-2';
export const fixtureCapabilities = [
  'admin.access', 'production.map.manage', 'apparatus.queue.read', 'apparatus.queue.manage',
  'catalog.item.read', 'catalog.item.create', 'catalog.item.bulk_move', 'catalog.item_group.read', 'catalog.item_group.manage',
  'party.supplier.read', 'party.supplier.manage', 'party.supplier.item.assign', 'party.supplier.code.manage',
  'party.customer.read', 'party.customer.manage', 'party.customer.item.assign', 'party.customer.code.manage',
  'role.capability.read', 'role.capability.manage', 'admin.activity.read', 'admin.settings.read', 'admin.settings.manage',
  'raw_material.assign', 'raw_material.rule.manage', 'inventory.movement.manage', 'factory.location.manage', 'rezka.split.manage',
];
export const apparatusIds = { print: 'apparatus:qa:print-1', laminate: 'apparatus:qa:laminate-1', cut: 'apparatus:qa:cut-1', spare: 'apparatus:qa:print-2', laminateSpare: 'apparatus:qa:laminate-2' };
const timestamp = 1791892800;

function apparatus(id, name, operation, technology, object, order) {
  return { apparatus_id: id, source_revision: 1, display: { display_name: name, description: 'Synthetic QA apparatus', catalog_order: order },
    source_aasx_sha256: '', capabilities: { [operation]: 1 },
    equipment_class_id: `equipment-class:${operation}`, physical_asset_id: `physical-asset:qa:${id.split(':').at(-1)}`,
    hierarchy: { enterprise_id: 'enterprise:qa', site_id: 'site:qa', area_id: 'area:production', work_center_id: `work-center:${operation}`, work_unit_id: `work-unit:${id.split(':').at(-1)}` },
    lifecycle: { state: 'active', retirement_reason: null }, source: 'canonical', sort_order: order,
    training: { enabled: false, queue_enabled: false, material_tracking_enabled: false },
    execution_profile: { operation, technology, color_station_count: operation === 'print' ? 8 : null, min_web_width_mm: 150, max_web_width_mm: 1200, virtual_tasks: 'disabled', capability_compatible_reroute: true },
    placement: object ? { factory_map_object_id: object } : null };
}
function order(number, product, stages) {
  const id = `zakaz-qa-${number}`;
  const template = { id: `qa-calculation-${number}`, code: `qa-${number}`, order_number: `qa-${number}`, source_map_id: id,
    name: product, product, item_code: 'QA-FILM-1', customer_ref: 'QA-CUSTOMER-1', customer: 'QA Mijoz', status: 'Rulon',
    kg: 120, frame_product_size_mm: 250, frame_count: 2, edge_allowance_mm: 15, width_mm: 515, waste_percent: 5,
    roll_count: 5, print_val_size_mm: 500, layers: [{ material_id: 'qa-pet', material: 'PET', micron: '12' }],
    production_options: { print_method: 'flexo', cold_glue: false }, image_id: '' };
  const map = { id, code: template.code, order_number: template.order_number, product_code: template.item_code, title: product,
    customer_name: template.customer, order_kg: 120, base_length: 10500, width_mm: 515, print_val_size_mm: 500, roll_count: 5,
    nodes: [
      { id: 'start', kind: 'start', title: 'Boshlanish', formula: null, role_code: '', item_code: '', x: 420, y: 32 },
      { id: 'order', kind: 'task', title: product, formula: null, role_code: 'zakaz', item_code: '', x: 420, y: 164 },
      { id: 'print', kind: 'apparatus', title: 'QA Flexo 1', apparatus_id: apparatusIds.print, formula: null, role_code: 'aparatchi', item_code: '', x: 420, y: 296 },
      { id: 'laminate', kind: 'apparatus', title: 'QA Laminator', apparatus_id: apparatusIds.laminate, formula: null, role_code: 'aparatchi', item_code: '', x: 420, y: 428 },
      { id: 'cut', kind: 'apparatus', title: 'QA Rezka', apparatus_id: apparatusIds.cut, formula: null, role_code: 'aparatchi', item_code: '', rezka_kadr_count: 2, rezka_frame_groups: [1, 1], x: 420, y: 560 },
      { id: 'end', kind: 'end', title: product, formula: null, role_code: '', item_code: 'QA-FILM-1', x: 420, y: 692 },
    ], edges: [{ from: 'start', to: 'order' }, { from: 'order', to: 'print' }, { from: 'print', to: 'laminate' }, { from: 'laminate', to: 'cut' }, { from: 'cut', to: 'end' }] };
  return { map, template, calculationRevision: 1, stages: { print: 'pending', laminate: 'pending', cut: 'pending', ...stages }, control: 'active' };
}

export function createSeed(epoch = 'qa-local-epoch-1') {
  const source = order(1001, 'QA Kutayotgan plyonka');
  const routeTemplate = { ...structuredClone(source.template), id: 'qa-route-template', name: 'QA Flexo xaritasi', kg: 0, code: 'QA-TEMPLATE-1', order_number: '' };
  const pendingTemplate = { ...structuredClone(source.template), id: 'qa-pending-template-2001', code: '2001', order_number: '2001', source_map_id: '' };
  const historicalMap = { ...structuredClone(source.map), id: 'zakaz-4001', code: '4001', order_number: '4001', title: 'QA Vaqt tarixi' };
  const timeLogs = id => [[0, 'start', 'pending', 'in_progress'], [100, 'pause', 'in_progress', 'paused'], [150, 'resume', 'paused', 'in_progress'], [250, 'complete', 'in_progress', 'pending'], [300, 'start', 'pending', 'in_progress'], [400, 'complete', 'in_progress', 'completed']].map(([offset, action, from, to], index) => ({ event_id: `qa-time:${id}:${index}`, order_id: id, apparatus: apparatusIds.print, stage_node_id: 'print', action, from_state: from, to_state: to, actor_display_name: 'QA Operator', created_at_unix: timestamp + offset }));
  const state = {
    epoch, rev: 1, nextId: 4, codeCounter: 0, sessions: new Set(), sequenceOverrides: {}, rawAssignments: [], rawHistory: [],
    templates: [routeTemplate], pendingOrders: [{ id: 'zakaz-2001', template: pendingTemplate, completion: null, manager_name: 'QA Administrator' }],
    openingWip: [], openingCommands: {}, downtime: [], reservations: [], planningCommands: [],
    inventoryTransfers: [], inventoryCommands: {}, canonicalCommands: [],
    assignmentPolicies: {}, assignmentSessions: [], assignmentHolds: [], assignmentCommands: {},
    factoryLocations: [
      { id: 'qa-factory-print', name: 'QA Bosma sexi', active: true, apparatus_ids: [apparatusIds.print], created_at_unix: timestamp, updated_at_unix: timestamp },
      { id: 'qa-factory-cut', name: 'QA Rezka sexi', active: true, apparatus_ids: [apparatusIds.cut], created_at_unix: timestamp, updated_at_unix: timestamp },
    ],
    historicalMaps: { 'zakaz-4001': historicalMap }, closedOrders: [{ order_id: 'zakaz-4001', order_number: '4001', title: 'QA Vaqt tarixi', completed_at_unix: timestamp + 500, logs: timeLogs('zakaz-4001'), progress_batches: [] }], timeLogs: timeLogs('zakaz-qa-1003'),
    planning: Object.fromEntries(Object.values(apparatusIds).map(id => [id, { capacity: { capacity_slots: 1, setup_minutes: 5, cleanup_minutes: 5, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' } }, discipline: 'strict_sequence' }])),
    materials: [
      { id: 'qa-pet', name: 'PET', active: true, density_g_cm3: 1.4, sort_order: 0, variants: [{ micron: 12, coefficient: 1.008, actual_gsm: 16.8 }] },
      { id: 'qa-pe', name: 'PE', active: true, density_g_cm3: 0.92, sort_order: 1, variants: [{ micron: 50, coefficient: 2.76, actual_gsm: 46 }] },
    ],
    apparatus: [
      apparatus(apparatusIds.print, 'QA Flexo 1', 'print', 'flexographic', 'node:1:instance:0', 10),
      apparatus(apparatusIds.laminate, 'QA Laminator', 'laminate', 'adhesive_lamination', 'node:6:instance:6', 20),
      apparatus(apparatusIds.cut, 'QA Rezka', 'cut', 'slitting', 'node:18:instance:0', 30),
      apparatus(apparatusIds.spare, 'QA Flexo 2', 'print', 'flexographic', '', 40),
      apparatus(apparatusIds.laminateSpare, 'QA Laminator 2', 'laminate', 'adhesive_lamination', '', 50),
    ],
    orders: [order(1001, 'QA Kutayotgan plyonka'), order(1002, 'QA Ishdagi plyonka', { print: 'in_progress' }), order(1003, 'QA Pauzadagi plyonka', { print: 'completed', laminate: 'paused' })],
    items: [
      { code: 'QA-FILM-1', name: 'QA Tayyor plyonka', uom: 'kg', item_group: 'Tayyor mahsulot', is_finished_goods: true, created_at_unix: timestamp, updated_at_unix: timestamp },
      { code: 'QA-PET-12', name: 'QA PET 12 mkm', uom: 'kg', item_group: 'Xomashyo', is_finished_goods: false, created_at_unix: timestamp, updated_at_unix: timestamp },
      { code: 'QA-PE-50', name: 'QA PE 50 mkm', uom: 'kg', item_group: 'Xomashyo', is_finished_goods: false, created_at_unix: timestamp, updated_at_unix: timestamp },
    ],
    groups: [
      { name: 'QA Materiallar', item_group_name: 'QA Materiallar', parent_item_group: '', is_group: true },
      { name: 'Xomashyo', item_group_name: 'Xomashyo', parent_item_group: 'QA Materiallar', is_group: false },
      { name: 'Tayyor mahsulot', item_group_name: 'Tayyor mahsulot', parent_item_group: 'QA Materiallar', is_group: true },
      { name: 'QA Tayyor paketlar', item_group_name: 'QA Tayyor paketlar', parent_item_group: 'Tayyor mahsulot', is_group: false },
      { name: 'QA Yangi guruh', item_group_name: 'QA Yangi guruh', parent_item_group: 'QA Materiallar', is_group: false },
    ],
    customers: [{ ref: 'QA-CUSTOMER-1', name: 'QA Mijoz', phone: '+998900000011', assigned_item_codes: ['QA-FILM-1'], assigned_item_groups: [], blocked: false, removed: false }],
    suppliers: [{ ref: 'QA-SUPPLIER-1', name: 'QA Ta’minotchi', phone: '+998900000012', assigned_item_codes: ['QA-PET-12'], blocked: false, removed: false }],
    warehouses: [
      { warehouse: 'QA Xomashyo', company: 'QA Synthetic', is_group: false, parent_warehouse: '', product_count: 2, reserved_count: 1 },
      { warehouse: 'QA Tayyor mahsulot', company: 'QA Synthetic', is_group: false, parent_warehouse: '', product_count: 1, reserved_count: 0 },
      { warehouse: 'QA Bo‘sh ombor', company: 'QA Synthetic', is_group: false, parent_warehouse: '', product_count: 0, reserved_count: 0 },
    ],
    workers: [
      { id: 'qa-worker-1', name: 'QA Brigadir', phone: '+998900000021', level: 'Brigader', blocked: false, code_locked: false, code_retry_after_sec: 0 },
      { id: 'qa-worker-2', name: 'QA Operator', phone: '+998900000022', level: 'Master', blocked: false, code_locked: false, code_retry_after_sec: 0 },
    ],
    systemUsers: [{ id: 'qa-qolipchi-1', role: 'qolipchi', name: 'QA Qolipchi', phone: '+998900000023', code_locked: false, code_retry_after_sec: 0 }],
    materialUsers: [{ ref: 'QA-MATERIAL-1', name: 'QA Material mas’uli', phone: '+998900000024', assigned_item_groups: ['Xomashyo'], code_locked: false, code_retry_after_sec: 0 }],
    roles: [
      { id: 'admin', label: 'QA Administrator', base_role: 'admin', system: true, capability_codes: [...fixtureCapabilities] },
      { id: 'aparatchi', label: 'Operator', base_role: 'aparatchi', system: true, capability_codes: ['apparatus.queue.read', 'apparatus.queue.manage'] },
      { id: 'qolipchi', label: 'Qolipchi', base_role: 'qolipchi', system: true, capability_codes: ['qolip.manage'] },
      { id: 'material_taminotchi', label: 'Material mas’uli', base_role: 'material_taminotchi', system: true, capability_codes: ['raw_material.assign'] },
      { id: 'qa-observer', label: 'QA Kuzatuvchi', base_role: null, system: false, capability_codes: ['catalog.item.read'] },
    ],
    roleAssignments: [{ principal_role: 'aparatchi', principal_ref: 'qa-worker-1', role_id: 'aparatchi', assigned_apparatus: [apparatusIds.print], assigned_item_groups: [] }],
    warehouseAssignments: [{ assignment_kind: 'warehouse', warehouse: 'QA Xomashyo', warehouse_name: 'QA Xomashyo', principal_role: 'aparatchi', principal_ref: 'qa-worker-1', display_name: 'QA Brigadir' }],
    dependencies: { 'qa-worker-1': { active_work: [], connections: [{ kind: 'warehouse', label: 'QA Xomashyo', apparatus: '', order_id: '', status: 'assigned' }] } },
    locations: [
      { id: 'qa-location-print', name: 'QA Bosma sexi', kind: 'state', active: true, factory_location_id: 'qa-factory-print', apparatus: [{ id: apparatusIds.print, name: 'QA Flexo 1' }] },
      { id: 'qa-location-cut', name: 'QA Rezka sexi', kind: 'state', active: true, factory_location_id: 'qa-factory-cut', apparatus: [{ id: apparatusIds.cut, name: 'QA Rezka' }] },
      { id: 'qa-location-stock', name: 'QA Xomashyo', kind: 'warehouse', active: true, warehouse_id: 'QA Xomashyo', apparatus: [] },
      { id: 'qa-location-finished', name: 'QA Tayyor mahsulot', kind: 'warehouse', active: true, warehouse_id: 'QA Tayyor mahsulot', apparatus: [] },
      { id: 'qa-location-empty', name: 'QA Bo‘sh ombor', kind: 'warehouse', active: true, warehouse_id: 'QA Bo‘sh ombor', apparatus: [] },
    ],
    assets: [
      { kind: 'raw_material', asset_ref: 'qa-roll-1', item_code: 'QA-PET-12', item_name: 'QA PET 12 mkm', identifier: 'QA-ROLL-1', qty: 80, uom: 'kg', status: 'available', custody_warehouse_id: 'QA Xomashyo', custody_warehouse: 'QA Xomashyo', physical_location: { id: 'qa-location-print', name: 'QA Bosma sexi', kind: 'state' }, placement_version: 1 },
      { kind: 'raw_material', asset_ref: 'qa-roll-2', item_code: 'QA-PE-50', item_name: 'QA PE 50 mkm', identifier: 'QA-ROLL-2', qty: 95, uom: 'kg', status: 'available', custody_warehouse_id: 'QA Xomashyo', custody_warehouse: 'QA Xomashyo', physical_location: { id: 'qa-location-stock', name: 'QA Xomashyo', kind: 'warehouse' }, placement_version: 1 },
    ],
    wip: [{ batch_id: 'qa-wip-1', revision: 1, order_id: 'zakaz-qa-1003', apparatus: apparatusIds.print, source_stage_node_id: 'print', qr_payload: 'QA-WIP:qa-wip-1', label_item_code: 'QA-FILM-1', label_item_name: 'QA Plyonka', produced_qty: 1250, uom: 'm', status: 'completed', wip_status: 'waiting', current_location: 'QA Bosma sexi', current_apparatus: apparatusIds.print, next_apparatus: apparatusIds.laminate,
      action: 'complete', session_id: 'qa-finished-worker-session', worker_role: 'aparatchi', worker_ref: 'qa-worker-1', worker_display_name: 'QA Brigadir', executor_name: 'QA Brigadir', started_at_unix: timestamp - 300, completed_at_unix: timestamp - 100 }],
    settings: { default_target_warehouse: 'QA Tayyor mahsulot', default_uom: 'kg', admin_name: 'QA Administrator', admin_phone: fixtureLogin.phone, werka_name: 'QA Omborchi', werka_phone: '+998900000031', werka_code_locked: false, werka_code_retry_after_sec: 0 },
  };
  for (const row of state.apparatus) {
    state.planning[row.apparatus_id] ??= { discipline: 'strict_sequence', capacity: { capacity_slots: 1, setup_minutes: 5, cleanup_minutes: 5, efficiency_percent: 100, finite_capacity: true, availability: { mode: 'always' } } };
    refreshFixtureCanonical(row, state.planning[row.apparatus_id]);
  }
  for (const map of [...state.orders.map(row => row.map), ...Object.values(state.historicalMaps)]) for (const edge of map.edges) edge.branch ??= '';
  return state;
}
