import { createHash } from 'node:crypto';

const base = '/v1/mobile/admin', inventory = `${base}/inventory`;
const clone = value => structuredClone(value);
const str = value => typeof value === 'string' ? value.trim() : '';
const lower = value => str(value).toLowerCase();
const response = body => ({ status: 200, body });
const error = (status, code) => ({ status, body: { error: code } });
const now = state => 1791892800 + state.rev;
const selectedKey = row => `${row.asset_kind || row.kind}:${lower(row.asset_ref)}`;
const available = row => row && row.qty > 0 && row.status === 'available' && !row.transfer_id;
const ref = location => ({ id: location.id, kind: location.kind, name: location.name });

export function inventoryFixtureRoute({ method, path, query, body, state, config, requires, profile, bump, equal }) {
  const isInventory = path.startsWith(`${inventory}/`), isFactory = path === `${base}/factory-locations` || path.startsWith(`${base}/factory-locations/`);
  if (!isInventory && !isFactory) return undefined;
  if (!requires(isFactory ? 'factory.location.manage' : 'inventory.movement.manage')) return error(403, 'forbidden');
  const isAdmin = requires('admin.access'), assigned = config.assignedWarehouses || [];
  const canWarehouse = name => isAdmin || assigned.some(value => lower(value) === lower(name));
  const internal = (source, destination) => [source, destination].every(name => assigned.some(value => lower(value) === lower(name)));
  const asset = row => state.assets.find(candidate => selectedKey(candidate) === selectedKey(row));
  const warehouse = id => state.locations.find(row => row.kind === 'warehouse' && lower(row.warehouse_id) === lower(id));
  const page = rows => rows.slice(Math.max(0, Number(query.offset) || 0), Math.max(0, Number(query.offset) || 0) + Math.min(500, Number(query.limit) || 100));
  const key = str(body?.idempotency_key), keyValid = () => key && key.length <= 200;
  const existing = () => state.inventoryCommands[key];
  const validateAssets = selectors => {
    if (!Array.isArray(selectors) || !selectors.length || new Set(selectors.map(selectedKey)).size !== selectors.length) return error(400, 'inventory_transfer_assets_required');
    const rows = selectors.map(asset);
    if (rows.some(row => !row)) return error(404, 'inventory_asset_not_found');
    if (rows.some(row => !canWarehouse(row.custody_warehouse))) return error(403, 'forbidden');
    if (rows.some(row => !available(row))) return error(409, 'inventory_asset_unavailable');
    return rows;
  };
  const completeTransfer = transfer => {
    const destination = warehouse(transfer.destination_warehouse_id);
    for (const line of transfer.lines) {
      const row = asset(line); row.custody_warehouse_id = transfer.destination_warehouse_id; row.custody_warehouse = transfer.destination_warehouse;
      row.physical_location = ref(destination); row.transfer_id = ''; row.status = 'available'; row.placement_version++;
    }
    transfer.status = 'received'; transfer.received_by_name = profile.display_name; transfer.received_at_unix = now(state);
  };
  const releaseTransfer = transfer => { for (const line of transfer.lines) { const row = asset(line); row.transfer_id = ''; row.status = 'available'; } };
  const factoryDto = row => ({ id: row.id, name: row.name, active: row.active, created_at_unix: row.created_at_unix, updated_at_unix: row.updated_at_unix,
    apparatus: row.apparatus_ids.map(id => { const apparatus = state.apparatus.find(row => row.apparatus_id === id); return { id, name: apparatus.display.display_name, source_revision: apparatus.source_revision, equipment_class_id: apparatus.equipment_class_id || `qa-class-${apparatus.execution_profile.operation}`, physical_asset_id: apparatus.physical_asset_id || `qa-asset-${id.split(':').at(-1)}`, active: apparatus.lifecycle.state === 'active' }; }) });
  const syncFactory = row => {
    let location = state.locations.find(location => location.factory_location_id === row.id);
    if (!location) { location = { id: `state:${row.id}`, kind: 'state', factory_location_id: row.id }; state.locations.push(location); }
    Object.assign(location, { name: row.name, active: row.active, apparatus: factoryDto(row).apparatus });
    for (const asset of state.assets) if (asset.physical_location.id === location.id) asset.physical_location.name = location.name;
  };

  if (path === `${inventory}/locations` && method === 'GET') return response(clone(state.locations));
  if (path === `${inventory}/assets` && method === 'GET') {
    const rows = state.assets.filter(row => canWarehouse(row.custody_warehouse) && (!query.asset_kind || row.kind === query.asset_kind) && (!query.warehouse_id || lower(row.custody_warehouse_id) === lower(query.warehouse_id)) && (!query.query || lower(JSON.stringify(row)).includes(lower(query.query))) && (query.current_user_states_only !== 'true' || row.physical_location.kind === 'state'));
    return response(clone(page(rows)));
  }
  if (path === `${inventory}/relocations` && method === 'POST') {
    if (!keyValid()) return error(400, 'inventory_idempotency_key_required');
    const previous = existing(), identity = { asset_kind: body.asset_kind, asset_ref: lower(body.asset_ref), physical_location_id: body.physical_location_id };
    if (previous) return previous.kind === 'relocate' && equal(previous.identity, identity) ? response(clone(asset(body))) : error(409, 'inventory_idempotency_conflict');
    const rows = validateAssets([body]); if (!Array.isArray(rows)) return rows;
    const location = state.locations.find(row => row.id === body.physical_location_id);
    if (!location) return error(404, 'inventory_location_not_found');
    if (!location.active) return error(409, 'inventory_location_inactive');
    if (location.kind !== 'state' && (location.kind !== 'warehouse' || lower(location.warehouse_id) !== lower(rows[0].custody_warehouse_id))) return error(409, 'inventory_cross_warehouse_requires_transfer');
    rows[0].physical_location = ref(location); rows[0].placement_version++; state.inventoryCommands[key] = { kind: 'relocate', identity }; bump(); return response(clone(rows[0]));
  }
  if (path === `${inventory}/returns/batch` && method === 'POST') {
    if (!keyValid()) return error(400, 'inventory_idempotency_key_required');
    const selectors = Array.isArray(body.assets) ? body.assets.map(row => ({ asset_kind: row.asset_kind, asset_ref: lower(row.asset_ref) })) : [];
    const previous = existing();
    if (previous) return previous.kind === 'return' && equal(previous.identity, selectors) ? response(clone(selectors.map(asset))) : error(409, 'inventory_idempotency_conflict');
    const rows = validateAssets(selectors); if (!Array.isArray(rows)) return rows;
    const destinations = rows.map(row => warehouse(row.custody_warehouse_id));
    if (rows.some(row => row.physical_location.kind !== 'state')) return error(409, 'inventory_asset_not_in_source_warehouse');
    if (destinations.some(row => !row?.active)) return error(409, 'inventory_location_inactive');
    rows.forEach((row, index) => { row.physical_location = ref(destinations[index]); row.placement_version++; });
    state.inventoryCommands[key] = { kind: 'return', identity: selectors }; bump(); return response(clone(rows));
  }
  if (path === `${inventory}/transfers`) {
    if (method === 'GET') return response(clone(page(state.inventoryTransfers.filter(row => (!query.status || row.status === query.status) && (query.direction === 'incoming' ? canWarehouse(row.destination_warehouse) : query.direction === 'outgoing' ? canWarehouse(row.source_warehouse) : canWarehouse(row.source_warehouse) || canWarehouse(row.destination_warehouse))).reverse())));
    if (method !== 'POST') return error(405, 'method_not_allowed');
    if (!keyValid()) return error(400, 'inventory_idempotency_key_required');
    const selectors = Array.isArray(body.assets) ? body.assets.map(row => ({ asset_kind: row.asset_kind, asset_ref: lower(row.asset_ref) })) : [];
    const identity = { source: lower(body.source_warehouse_id), destination: lower(body.destination_warehouse_id), selectors };
    const previous = existing();
    if (previous) return previous.kind === 'transfer' && equal(previous.identity, identity) ? response(clone(state.inventoryTransfers.find(row => row.id === previous.transferId))) : error(409, 'inventory_idempotency_conflict');
    const source = warehouse(body.source_warehouse_id), destination = warehouse(body.destination_warehouse_id);
    if (!source || !destination) return error(404, 'inventory_warehouse_not_found');
    if (source.id === destination.id) return error(400, 'inventory_transfer_same_warehouse');
    if (!source.active || !destination.active) return error(409, 'inventory_location_inactive');
    const rows = validateAssets(selectors); if (!Array.isArray(rows)) return rows;
    if (rows.some(row => lower(row.custody_warehouse_id) !== lower(source.warehouse_id) || row.physical_location.kind !== 'warehouse' || row.physical_location.id !== source.id)) return error(409, 'inventory_asset_not_in_source_warehouse');
    const transfer = { id: `qa-transfer-${state.nextId++}`, source_warehouse_id: source.warehouse_id, source_warehouse: source.name, destination_warehouse_id: destination.warehouse_id, destination_warehouse: destination.name, status: 'requested', note: str(body.note), requested_by_name: profile.display_name, approved_by_name: '', dispatched_by_name: '', received_by_name: '', rejected_by_name: '', cancelled_by_name: '', created_at_unix: now(state), approved_at_unix: null, dispatched_at_unix: null, received_at_unix: null, rejected_at_unix: null, cancelled_at_unix: null,
      lines: rows.map(row => ({ asset_kind: row.kind, asset_ref: row.asset_ref, item_code: row.item_code, item_name: row.item_name, identifier: row.identifier, qty: row.qty, uom: row.uom, source_physical_location_id: row.physical_location.id })) };
    for (const row of rows) { row.transfer_id = transfer.id; row.status = 'transfer_reserved'; }
    if (internal(source.name, destination.name)) completeTransfer(transfer);
    state.inventoryTransfers.push(transfer); state.inventoryCommands[key] = { kind: 'transfer', identity, transferId: transfer.id }; bump(); return response(clone(transfer));
  }
  const action = path.match(/^\/v1\/mobile\/admin\/inventory\/transfers\/([^/]+)\/(approve|reject|dispatch|receive|cancel)$/);
  if (action && method === 'POST') {
    if (!keyValid()) return error(400, 'inventory_idempotency_key_required');
    const [, id, operation] = action, transfer = state.inventoryTransfers.find(row => row.id === id);
    if (!transfer) return error(404, 'inventory_transfer_not_found');
    if (!canWarehouse(['approve', 'reject', 'receive'].includes(operation) ? transfer.destination_warehouse : transfer.source_warehouse)) return error(403, 'forbidden');
    const previous = existing(), identity = { id, operation };
    if (previous) return previous.kind === 'transfer-action' && equal(previous.identity, identity) ? response(clone(transfer)) : error(409, 'inventory_idempotency_conflict');
    const target = { approve: 'approved', reject: 'rejected', dispatch: 'in_transit', receive: 'received', cancel: 'cancelled' }[operation];
    if (transfer.status !== target) {
      if (!({ approve: ['requested'], reject: ['requested'], dispatch: ['approved'], receive: ['in_transit'], cancel: ['requested', 'approved'] }[operation].includes(transfer.status))) return error(409, 'inventory_transfer_transition_invalid');
      if (transfer.lines.some(line => asset(line)?.transfer_id !== transfer.id)) return error(409, 'inventory_asset_unavailable');
      transfer.status = target;
      const field = { approve: 'approved', reject: 'rejected', dispatch: 'dispatched', receive: 'received', cancel: 'cancelled' }[operation];
      transfer[`${field}_by_name`] = profile.display_name; transfer[`${field}_at_unix`] = now(state);
      if (operation === 'receive' || ['approve', 'dispatch'].includes(operation) && internal(transfer.source_warehouse, transfer.destination_warehouse)) completeTransfer(transfer);
      else if (['cancel', 'reject'].includes(operation)) releaseTransfer(transfer);
      else if (operation === 'dispatch') for (const line of transfer.lines) asset(line).status = 'in_transit';
      bump();
    }
    state.inventoryCommands[key] = { kind: 'transfer-action', identity }; return response(clone(transfer));
  }
  if (path === `${base}/factory-locations`) {
    if (method === 'GET') return response(state.factoryLocations.map(factoryDto));
    if (method !== 'POST') return error(405, 'method_not_allowed');
    if (!str(body?.name) || !Array.isArray(body.apparatus_ids)) return error(400, 'invalid_factory_location');
    if (state.factoryLocations.some(row => lower(row.name) === lower(body.name))) return error(409, 'state name already exists');
    if (new Set(body.apparatus_ids).size !== body.apparatus_ids.length || body.apparatus_ids.some(id => !state.apparatus.some(row => row.apparatus_id === id && row.lifecycle.state === 'active'))) return error(400, 'apparatus id is invalid');
    const suffix = createHash('sha256').update(`synthetic:${state.nextId++}:${str(body.name)}`).digest('hex').slice(0, 32);
    const row = { id: `state_${suffix}`, name: str(body.name), active: true, apparatus_ids: [...body.apparatus_ids], created_at_unix: now(state), updated_at_unix: now(state) };
    state.factoryLocations.push(row); syncFactory(row); bump(); return response(factoryDto(row));
  }
  const factory = path.match(/^\/v1\/mobile\/admin\/factory-locations\/([^/]+)(\/apparatus)?$/);
  if (factory) {
    if (method !== 'PUT') return error(405, 'method_not_allowed');
    const row = state.factoryLocations.find(row => row.id === factory[1]);
    if (!row) return error(404, 'factory_location_not_found');
    if (factory[2]) {
      if (!Array.isArray(body?.apparatus_ids) || new Set(body.apparatus_ids).size !== body.apparatus_ids.length || body.apparatus_ids.some(id => !state.apparatus.some(row => row.apparatus_id === id && row.lifecycle.state === 'active'))) return error(400, 'apparatus id is invalid');
      row.apparatus_ids = [...body.apparatus_ids];
    } else {
      if (!body || !Object.keys(body).length || body.name !== undefined && !str(body.name) || body.active !== undefined && typeof body.active !== 'boolean') return error(400, 'invalid_factory_location');
      if (body.name !== undefined && state.factoryLocations.some(other => other !== row && lower(other.name) === lower(body.name))) return error(409, 'state name already exists');
      if (body.name !== undefined) row.name = str(body.name); if (body.active !== undefined) row.active = body.active;
    }
    row.updated_at_unix = now(state); syncFactory(row); bump(); return response(factoryDto(row));
  }
  return error([`${inventory}/locations`, `${inventory}/assets`, `${inventory}/relocations`, `${inventory}/returns/batch`].includes(path) ? 405 : 404, [`${inventory}/locations`, `${inventory}/assets`, `${inventory}/relocations`, `${inventory}/returns/batch`].includes(path) ? 'method_not_allowed' : 'fixture_route_not_implemented');
}
