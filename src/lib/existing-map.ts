import { ApiError, isRecord } from "./api";
import type { ApiClient } from "./api";
import type { CalculateOrderTemplate, ProductionSnapshot, Row } from "./api-types";
import { normalizeMapBranch, productionMapFromRow } from "./production-map";
import type { ProductionMapDefinition, ProductionMapEdge, ProductionMapNode } from "./production-map";

const path = "/v1/mobile/admin/production-maps";
const string = (value: unknown) => typeof value === "string" ? value : "";
const pending = (value: unknown) => string(value).trim().toLowerCase() === "pending";
const activeSaves = new WeakMap<ApiClient, Set<string>>();

export interface ExistingMapSaved {
  map: ProductionMapDefinition;
  program: Row;
}

export interface ExistingMapState {
  saved: ExistingMapSaved;
  snapshot: ProductionSnapshot;
}

export interface ExistingMapLoad extends ExistingMapState {
  template?: CalculateOrderTemplate;
  /** Lossless calculation snapshot, when that separate edit endpoint is eligible. */
  calculationSource?: Row;
  templateNotice?: string;
}

function invalid(message = "Serverdan saqlangan xarita to‘liq kelmadi."): never {
  throw new ApiError(502, "invalid_response", message);
}

export function parseExistingMapSaved(value: unknown, id: string): ExistingMapSaved {
  if (!isRecord(value) || !isRecord(value.map) || !isRecord(value.program)) invalid();
  const map = value.map;
  if (map.id !== id || typeof map.product_code !== "string" || typeof map.title !== "string"
    || !Array.isArray(map.nodes) || !Array.isArray(map.edges)
    || value.program.map_id !== id || !Array.isArray(value.program.operations)) invalid();
  for (const node of map.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.kind !== "string"
      || typeof node.title !== "string" || (node.x !== undefined && !Number.isFinite(node.x))
      || (node.y !== undefined && !Number.isFinite(node.y))) invalid();
  }
  for (const edge of map.edges) {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string"
      || (edge.branch !== undefined && typeof edge.branch !== "string")) invalid();
  }
  try {
    return { map: productionMapFromRow(map), program: structuredClone(value.program) };
  } catch { return invalid(); }
}

/** Compare native DTO defaults and server normalization without dropping future fields. */
export function existingMapSignature(map: ProductionMapDefinition): string {
  const next: Row = structuredClone(map);
  for (const field of ["id", "product_code", "title", "code", "order_number", "customer_name", "image_id"]) {
    next[field] = string(next[field]);
  }
  next.id = string(next.id).trim().toLowerCase();
  for (const field of ["product_code", "title", "code", "order_number"]) next[field] = string(next[field]).trim();
  // The native detail GET supplies this legacy default; snapshots may omit it.
  if (!next.code) next.code = next.order_number;
  for (const field of ["roll_count", "width_mm", "print_val_size_mm", "order_kg", "base_length"]) next[field] ??= null;
  next.nodes = map.nodes.map(node => {
    const value: Row = structuredClone(node);
    for (const field of ["id", "title", "apparatus_id", "role_code", "item_code", "qty_formula", "from_location", "to_location", "alternative_group_id", "alternative_group_label", "alternative_assigned_title", "alternative_assigned_apparatus_id"]) value[field] = string(value[field]).trim();
    value.id = string(value.id).toLowerCase();
    value.formula = node.formula ? { ...node.formula, target: node.formula.target.trim(), expression: node.formula.expression.trim() } : null;
    value.rezka_kadr_count ??= null;
    value.rezka_frame_groups ??= [];
    value.rezka_label_length ??= null;
    value.x ??= 0;
    value.y ??= 0;
    return value;
  });
  next.edges = map.edges.map(edge => ({ ...edge, from: edge.from.trim().toLowerCase(), to: edge.to.trim().toLowerCase(), branch: normalizeMapBranch(edge.branch || "") }));
  return stableJson(next);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => isRecord(entry)
    ? Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) : entry);
}

export function effectiveMapApparatusId(node: ProductionMapNode): string {
  return (node.alternative_assigned_apparatus_id || node.apparatus_id || "").trim();
}

/** Native queue states, stage history and alternative groups have the same edit locks. */
export function existingMapLockedNodeIds(map: ProductionMapDefinition, snapshot: ProductionSnapshot): Set<string> {
  const started = new Set<string>();
  const stageStates = snapshot.stage_states[map.id] || {};
  for (const [apparatus, states] of Object.entries(snapshot.queue_states)) {
    const state = states[map.id];
    const stages = map.nodes.filter(node => node.kind === "apparatus" && effectiveMapApparatusId(node) === apparatus);
    // Canonical stage_states preserve pending downstream stages while global
    // freeze overlays every apparatus's queue/control transport as frozen.
    if (string(state).trim().toLowerCase() === "frozen" && stages.length
      && stages.every(node => pending(stageStates[node.id]))) continue;
    // An absent entry is pending. An explicitly unrecognized state is unsafe.
    if (state !== undefined && !pending(state)) started.add(apparatus);
  }
  for (const node of map.nodes) {
    if (node.kind === "apparatus" && stageStates[node.id] !== undefined && !pending(stageStates[node.id])) {
      started.add(effectiveMapApparatusId(node));
    }
  }
  const locked = new Set(map.nodes.filter(node => node.kind === "apparatus" && started.has(effectiveMapApparatusId(node))).map(node => node.id));
  const groups = new Set(map.nodes.filter(node => locked.has(node.id)).map(node => node.alternative_group_id?.trim()).filter(Boolean));
  for (const node of map.nodes) if (node.alternative_group_id && groups.has(node.alternative_group_id.trim())) locked.add(node.id);
  return locked;
}

export function existingMapIncomingEdgeIsLocked(edge: ProductionMapEdge, locked: ReadonlySet<string>): boolean {
  return locked.has(edge.to.trim());
}

export function existingMapLockViolation(before: ProductionMapDefinition, after: ProductionMapDefinition, locked: ReadonlySet<string>): boolean {
  for (const id of locked) {
    const previous = before.nodes.find(node => node.id === id);
    const next = after.nodes.find(node => node.id === id);
    if (!previous || !next) return true;
    const compare = (node: ProductionMapNode) => existingMapSignature({ ...before, nodes: [node], edges: [] });
    if (compare(previous) !== compare(next)) return true;
  }
  const incoming = (map: ProductionMapDefinition) => map.edges.filter(edge => locked.has(edge.to));
  const previous = incoming(before), next = incoming(after);
  if (previous.length !== next.length) return true;
  const compare = (edge: ProductionMapEdge) => stableJson({ ...edge, branch: normalizeMapBranch(edge.branch || "") });
  return previous.some(edge => !next.some(candidate => compare(edge) === compare(candidate)));
}

/** Calculation and order identity belong to the saved order; map PUT edits only its route. */
export function existingMapForSave(before: ProductionMapDefinition, draft: ProductionMapDefinition): ProductionMapDefinition {
  return { ...structuredClone(before), nodes: structuredClone(draft.nodes), edges: structuredClone(draft.edges) };
}

export async function readExistingMapState(client: ApiClient, id: string, signal?: AbortSignal): Promise<ExistingMapState> {
  const [payload, snapshot] = await Promise.all([
    client.get(path, { id }, signal), client.productionSnapshot(signal),
  ]);
  const saved = parseExistingMapSaved(payload, id);
  const canonical = snapshot.maps.find(entry => entry.map.id === id);
  if (canonical && existingMapSignature(parseExistingMapSaved(canonical, id).map) !== existingMapSignature(saved.map)) {
    throw new ApiError(409, "map_snapshot_changed", "Xarita yuklanayotganda o‘zgardi. Holatini qayta yuklang.");
  }
  return { saved, snapshot };
}

export async function loadExistingMap(client: ApiClient, id: string, signal?: AbortSignal): Promise<ExistingMapLoad> {
  const state = await readExistingMapState(client, id, signal);
  try {
    const source = await client.get(`${path}/order-edit`, { id }, signal);
    if (!isRecord(source) || !isRecord(source.map) || !isRecord(source.template)
      || source.map.id !== id || !Number.isSafeInteger(source.revision) || Number(source.revision) < 0) invalid();
    if (existingMapSignature(productionMapFromRow(source.map)) !== existingMapSignature(state.saved.map)) {
      throw new ApiError(409, "map_snapshot_changed", "Buyurtma hisob-kitobi yuklanayotganda xarita o‘zgardi. Qayta yuklang.");
    }
    const template = source.template;
    for (const field of ["name", "product", "customer"]) if (typeof template[field] !== "string") invalid();
    for (const field of ["kg", "frame_product_size_mm", "frame_count", "edge_allowance_mm", "waste_percent"]) if (!Number.isFinite(template[field])) invalid();
    return { ...state, template: structuredClone(template) as CalculateOrderTemplate, calculationSource: structuredClone(source) };
  } catch (error) {
    // This endpoint intentionally refuses calculation editing after any activity.
    // The native map editor still permits future-route changes in that situation.
    if (!(error instanceof ApiError) || ![400, 404, 409].includes(error.status) || error.code === "map_snapshot_changed") throw error;
    return { ...state, templateNotice: "Bu buyurtmaning Calculate tahriri yopiq. Saqlangan xarita o‘lchamlari saqlanadi; kelgusi bosqichlarni tahrirlash mumkin." };
  }
}

export function assertExistingMapBaseline(baseline: ExistingMapState, latest: ExistingMapState): void {
  if (latest.snapshot.epoch !== baseline.snapshot.epoch || latest.snapshot.scope !== baseline.snapshot.scope
    || latest.snapshot.rev < baseline.snapshot.rev) {
    throw new ApiError(409, "map_revision_changed", "Server holati almashdi. Xaritani qayta oching.");
  }
  if (existingMapSignature(baseline.saved.map) !== existingMapSignature(latest.saved.map)) {
    throw new ApiError(409, "map_edit_conflict", "Xarita boshqa oynada o‘zgargan. Saqlash bloklandi; yangi holatni yuklang.");
  }
}

export function existingMapSaveMayHaveSucceeded(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === "invalid_response");
}

/** No invented revision/header contract: the current native PUT lacks a CAS/idempotency API. */
export async function saveExistingMap(
  client: ApiClient,
  baseline: ExistingMapState,
  draft: ProductionMapDefinition,
  options: { signal?: AbortSignal; onSent?: (map: ProductionMapDefinition) => void; isCurrent?: () => boolean } = {},
): Promise<ExistingMapSaved> {
  const id = baseline.saved.map.id;
  const pending = activeSaves.get(client) || new Set<string>();
  activeSaves.set(client, pending);
  if (pending.has(id)) throw new ApiError(409, "map_save_in_progress", "Bu xarita saqlanmoqda. Javobni kuting.");
  pending.add(id);
  try {
    const latest = await readExistingMapState(client, id, options.signal);
    const map = existingMapForSave(baseline.saved.map, draft);
    if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException("So‘rov bekor qilindi.", "AbortError");
    if (latest.snapshot.epoch === baseline.snapshot.epoch && latest.snapshot.scope === baseline.snapshot.scope
      && latest.snapshot.rev >= baseline.snapshot.rev && existingMapSignature(latest.saved.map) === existingMapSignature(map)) return latest.saved;
    assertExistingMapBaseline(baseline, latest);
    if (existingMapLockViolation(baseline.saved.map, map, existingMapLockedNodeIds(baseline.saved.map, latest.snapshot))) {
      throw new ApiError(409, "production_map_started_stage_locked", "Ish boshlangan bosqich va unga kiruvchi yo‘lni o‘zgartirib bo‘lmaydi. Holatni yangilang.");
    }
    options.onSent?.(map);
    const saved = parseExistingMapSaved(await client.request(path, "PUT", { body: map, signal: options.signal }), map.id);
    if (existingMapSignature(saved.map) !== existingMapSignature(map)) invalid("Server saqlangan xaritani tasdiqlamadi. Saqlash holatini tekshiring.");
    return saved;
  } finally { pending.delete(id); }
}

export type ExistingMapRecovery = "saved" | "unchanged" | "conflict";

export function existingMapRecoveryResult(baseline: ExistingMapState, attempted: ProductionMapDefinition, latest: ExistingMapState): ExistingMapRecovery {
  if (latest.snapshot.epoch !== baseline.snapshot.epoch || latest.snapshot.scope !== baseline.snapshot.scope || latest.snapshot.rev < baseline.snapshot.rev) return "conflict";
  const signature = existingMapSignature(latest.saved.map);
  if (signature === existingMapSignature(attempted)) return "saved";
  return signature === existingMapSignature(baseline.saved.map) ? "unchanged" : "conflict";
}

export function existingMapErrorMessage(error: Error): string {
  if (!(error instanceof ApiError)) return error.message;
  if (error.status === 403) return "Bu xaritani tahrirlash uchun ruxsat berilmagan.";
  if (error.code === "production_map_started_stage_locked") return "Ish boshlangan bosqich yoki uning kiruvchi yo‘li bloklangan. Yangi holatni yuklab, kelgusi bosqichlarni tahrirlang.";
  if (error.code === "opened_order_calculation_locked" || error.code === "production_map_opened_order_calculation_locked") return "Buyurtma o‘lchamlarini xarita oynasidan o‘zgartirib bo‘lmaydi. Buyurtma hisob-kitobi tahriridan foydalaning.";
  if (error.status === 409) return error.message;
  return error.message;
}
