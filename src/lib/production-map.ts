import type { CalculateOrderTemplate, Row } from "./api-types";

// Native DTOs: Mini RS core/production_map/catalog/definition.rs.
export const productionNodeKinds = [
  "start", "location", "material", "apparatus", "kk_product", "formula",
  "condition", "task", "wait", "output", "end",
] as const;
export type ProductionNodeKind = typeof productionNodeKinds[number];
export interface ProductionFormula extends Row { target: string; expression: string }
export interface ProductionMapNode extends Row {
  id: string;
  kind: ProductionNodeKind;
  title: string;
  x: number;
  y: number;
  apparatus_id?: string;
  formula?: ProductionFormula | null;
  role_code?: string;
  item_code?: string;
  qty_formula?: string;
  from_location?: string;
  to_location?: string;
  alternative_group_id?: string;
  alternative_group_label?: string;
  alternative_assigned_title?: string;
  alternative_assigned_apparatus_id?: string;
  rezka_kadr_count?: number | null;
  rezka_frame_groups?: number[];
  rezka_label_length?: number | null;
}
export interface ProductionMapEdge extends Row { from: string; to: string; branch?: string }
export interface ProductionMapDefinition extends Row {
  id: string;
  product_code: string;
  title: string;
  code?: string;
  order_number?: string;
  customer_name?: string;
  image_id?: string;
  roll_count?: number | null;
  width_mm?: number | null;
  print_val_size_mm?: number | null;
  order_kg?: number | null;
  base_length?: number | null;
  nodes: ProductionMapNode[];
  edges: ProductionMapEdge[];
}
export interface EditorNode { id: string; position: { x: number; y: number }; data: ProductionMapNode }
export interface EditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  label?: string;
  data?: ProductionMapEdge;
}

const string = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const clone = <T>(value: T): T => structuredClone(value);

/** Accepts either a native map or the server's saved {map, program} wrapper. */
export function productionMapFromRow(value: Row): ProductionMapDefinition {
  const source = value.map && typeof value.map === "object" ? record(value.map) : value;
  return {
    ...clone(source),
    id: string(source.id),
    product_code: string(source.product_code),
    title: string(source.title),
    nodes: (Array.isArray(source.nodes) ? source.nodes : []).map(value => {
      const node = record(value);
      if (!productionNodeKinds.includes(node.kind as ProductionNodeKind)) throw new Error("Xarita tuguni turi tanilmadi.");
      return { ...clone(node), id: string(node.id), kind: node.kind as ProductionNodeKind, title: string(node.title), x: number(node.x) ?? 0, y: number(node.y) ?? 0 };
    }),
    edges: (Array.isArray(source.edges) ? source.edges : []).map(value => {
      const edge = record(value);
      return { ...clone(edge), from: string(edge.from), to: string(edge.to), branch: string(edge.branch) };
    }),
  };
}

/** Mirrors mobile productionMapOrderFlowNodes/Edges, without choosing equipment. */
export function createOrderMap(template: CalculateOrderTemplate, result: Row, draftId = `zakaz-draft-${Date.now()}-${crypto.randomUUID()}`): ProductionMapDefinition {
  const title = template.name.trim() || template.product.trim() || "Buyurtma";
  const product = template.product.trim() || "Mahsulot";
  const firstResult = record(Array.isArray(result.results) ? result.results[0] : undefined);
  return {
    id: draftId,
    product_code: string(template.item_code).trim() || product,
    title,
    code: "",
    order_number: "",
    customer_name: string(template.customer).trim(),
    ...(template.image_id ? { image_id: template.image_id } : {}),
    ...(number(template.roll_count) !== undefined ? { roll_count: template.roll_count } : {}),
    ...(number(template.width_mm) !== undefined || number(result.width_mm) !== undefined ? { width_mm: number(template.width_mm) ?? number(result.width_mm) } : {}),
    ...(number(template.print_val_size_mm) !== undefined ? { print_val_size_mm: template.print_val_size_mm } : {}),
    order_kg: template.kg,
    ...(number(firstResult.rounded_length) !== undefined ? { base_length: number(firstResult.rounded_length) } : {}),
    nodes: [
      { id: "start", kind: "start", title: "Boshlanish", x: 420, y: 32 },
      { id: "order", kind: "task", title, role_code: "zakaz", x: 420, y: 164 },
      { id: "end", kind: "end", title: product, item_code: string(template.item_code), x: 420, y: 296 },
    ],
    edges: [{ from: "start", to: "order" }, { from: "order", to: "end" }],
  };
}

export function normalizeMapBranch(branch: string): string {
  const value = branch.trim().toLowerCase();
  if (["1", "ha", "yes", "true"].includes(value)) return "true";
  if (["0", "yo'q", "yoq", "no", "false"].includes(value)) return "false";
  return value;
}
export function branchLabel(branch: string): string {
  const value = normalizeMapBranch(branch);
  return value === "true" ? "Shunda" : value === "false" ? "Aks holda" : branch;
}
export function mapEdgeId(edge: ProductionMapEdge): string {
  return JSON.stringify([edge.from, edge.to, normalizeMapBranch(edge.branch || "")]);
}
export function toEditorGraph(map: ProductionMapDefinition): { nodes: EditorNode[]; edges: EditorEdge[] } {
  return {
    nodes: map.nodes.map(node => ({ id: node.id, position: { x: node.x, y: node.y }, data: clone(node) })),
    edges: map.edges.map(edge => ({ id: mapEdgeId(edge), source: edge.from, target: edge.to, sourceHandle: normalizeMapBranch(edge.branch || "") || null, label: branchLabel(edge.branch || ""), data: clone(edge) })),
  };
}
export function fromEditorGraph(map: ProductionMapDefinition, nodes: readonly EditorNode[], edges: readonly EditorEdge[]): ProductionMapDefinition {
  return {
    ...clone(map),
    nodes: nodes.map(node => ({ ...clone(node.data), id: node.id, x: node.position.x, y: node.position.y })),
    edges: edges.map(edge => ({ ...clone(edge.data || {}), from: edge.source, to: edge.target, branch: normalizeMapBranch(edge.sourceHandle ?? edge.data?.branch ?? "") })),
  };
}

export function createMapNode(map: ProductionMapDefinition, kind: ProductionNodeKind, patch: Partial<ProductionMapNode> = {}): ProductionMapNode {
  let index = 1;
  while (map.nodes.some(node => node.id === `${kind}_${index}`)) index += 1;
  const end = map.nodes.find(node => node.kind === "end");
  const titles: Record<ProductionNodeKind, string> = {
    start: "Boshlanish", location: "Joylashuv", material: "Material", apparatus: "Aparat tanlang", kk_product: "Yarim tayyor mahsulot",
    formula: "Hisoblash", condition: "Shart", task: "Ishlov stansiyasi", wait: "Kutish", output: "Chiqish", end: "Tugash",
  };
  return {
    id: `${kind}_${index}`, kind, title: titles[kind], x: end?.x ?? 420, y: end?.y ?? 296,
    ...(kind === "task" ? { role_code: "worker" } : {}),
    ...(kind === "formula" ? { formula: { target: "result_kg", expression: "order_qty" } } : {}),
    ...(kind === "condition" ? { formula: { target: "", expression: "order_qty >= 100" } } : {}),
    ...clone(patch),
  };
}

/** Insert before the finish and retain every incoming alternative/condition branch. */
export function addMapNode(map: ProductionMapDefinition, node: ProductionMapNode, options: { beforeEnd?: boolean } = {}): ProductionMapDefinition {
  if (map.nodes.some(existing => existing.id === node.id)) throw new Error("Tugun identifikatori takrorlangan.");
  const next = clone(map);
  const endIndex = next.nodes.findIndex(existing => existing.kind === "end");
  if (options.beforeEnd === false || endIndex < 0 || node.kind === "start" || node.kind === "end") {
    next.nodes.push(clone(node));
    return next;
  }
  const end = next.nodes[endIndex];
  const incoming = next.edges.filter(edge => edge.to === end.id);
  next.nodes.splice(endIndex, 0, clone(node));
  next.nodes[endIndex + 1] = { ...end, y: Math.max(end.y, node.y) + 132 };
  next.edges = next.edges.filter(edge => edge.to !== end.id);
  next.edges.push(...incoming.map(edge => ({ ...edge, to: node.id })));
  if (node.kind !== "condition") next.edges.push({ from: node.id, to: end.id });
  return next;
}
export function updateMapNode(map: ProductionMapDefinition, id: string, patch: Partial<ProductionMapNode>): ProductionMapDefinition {
  return { ...clone(map), nodes: map.nodes.map(node => node.id === id ? { ...clone(node), ...clone(patch), id: node.id } : clone(node)) };
}
/** Mobile removes incident edges; it never invents a bypass after deletion. */
export function removeMapNode(map: ProductionMapDefinition, id: string): ProductionMapDefinition {
  const node = map.nodes.find(node => node.id === id);
  if (!node || node.kind === "start" || node.kind === "end") return clone(map);
  return { ...clone(map), nodes: map.nodes.filter(node => node.id !== id).map(clone), edges: map.edges.filter(edge => edge.from !== id && edge.to !== id).map(clone) };
}
export function connectMapNodes(map: ProductionMapDefinition, from: string, to: string, branch = ""): ProductionMapDefinition {
  if (!map.nodes.some(node => node.id === from) || !map.nodes.some(node => node.id === to)) throw new Error("Bog‘lanish tuguni topilmadi.");
  const edge = { from, to, branch: normalizeMapBranch(branch) };
  if (map.edges.some(existing => mapEdgeId(existing) === mapEdgeId(edge))) return clone(map);
  const next = { ...clone(map), edges: [...map.edges.map(clone), edge] };
  if (hasMapCycle(next)) throw new Error("Xaritada aylanma bog‘lanish bo‘lishi mumkin emas.");
  return next;
}
export function removeMapEdge(map: ProductionMapDefinition, edge: ProductionMapEdge): ProductionMapDefinition {
  return { ...clone(map), edges: map.edges.filter(candidate => mapEdgeId(candidate) !== mapEdgeId(edge)).map(clone) };
}
export function withoutAlternativeAssignments(map: ProductionMapDefinition): ProductionMapDefinition {
  return { ...clone(map), nodes: map.nodes.map(node => {
    const copy = clone(node);
    delete copy.alternative_assigned_title;
    delete copy.alternative_assigned_apparatus_id;
    return copy;
  }) };
}

/** Mobile's «Keyin tanlash»: candidates share one stage and retain parallel paths. */
export function addAlternativeApparatusGroup(map: ProductionMapDefinition, rows: readonly Row[], label: string, rezkaSettings: Partial<ProductionMapNode> = {}): ProductionMapDefinition {
  const candidates = rows.map(apparatusOption).filter((item, index, options) => item.active && isCanonicalApparatusId(item.id) && options.findIndex(candidate => candidate.id === item.id) === index);
  const endIndex = map.nodes.findIndex(node => node.kind === "end");
  if (endIndex < 0 || candidates.length === 0) return clone(map);
  const next = clone(map), end = next.nodes[endIndex];
  const incoming = next.edges.filter(edge => edge.to === end.id);
  if (!incoming.length) throw new Error("Tugash tuguniga avval jarayonni ulang.");
  const previous = next.nodes.filter(node => incoming.some(edge => edge.from === node.id));
  const y = Math.max(...previous.map(node => node.y)) + 132;
  let groupIndex = 1;
  while (next.nodes.some(node => node.alternative_group_id === `alt_${candidates[0].operation}_${groupIndex}`)) groupIndex += 1;
  const groupId = `alt_${candidates[0].operation}_${groupIndex}`;
  const center = previous.reduce((sum, node) => sum + node.x, 0) / previous.length;
  const created: ProductionMapNode[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const node = createMapNode({ ...next, nodes: [...next.nodes, ...created] }, "apparatus", {
      title: candidate.name, apparatus_id: candidate.id,
      alternative_group_id: groupId, alternative_group_label: label,
      ...(rezkaSettings.rezka_kadr_count != null ? { rezka_kadr_count: rezkaSettings.rezka_kadr_count } : {}),
      ...(rezkaSettings.rezka_frame_groups ? { rezka_frame_groups: clone(rezkaSettings.rezka_frame_groups) } : {}),
      ...(rezkaSettings.rezka_label_length != null ? { rezka_label_length: rezkaSettings.rezka_label_length } : {}),
      x: center + (index - (candidates.length - 1) / 2) * 240, y,
    });
    created.push(node);
  }
  next.nodes.splice(endIndex, 0, ...created);
  next.nodes[endIndex + created.length] = { ...end, y: y + 132 };
  next.edges = next.edges.filter(edge => edge.to !== end.id);
  for (const node of created) {
    next.edges.push(...incoming.map(edge => ({ ...clone(edge), to: node.id })));
    next.edges.push({ from: node.id, to: end.id });
  }
  return next;
}

export function isCanonicalApparatusId(value: string): boolean {
  const id = value.trim();
  const parts = id.split(":");
  return id.length > 0 && id.length <= 128 && id === id.toLowerCase() && !/\s/.test(id) && parts.length >= 3 && parts[0] === "apparatus" && parts.slice(1).every(Boolean);
}
export interface ApparatusOption {
  id: string; name: string; operation: string; technology: string; active: boolean; sortOrder: number;
  colors?: number; minWidth?: number; maxWidth?: number; row: Row;
}
export function apparatusOption(row: Row): ApparatusOption {
  const projection = row.runtime_projection ? record(row.runtime_projection) : row;
  const profile = record(projection.execution_profile), display = record(projection.display), lifecycle = record(projection.lifecycle);
  return {
    id: string(projection.apparatus_id).trim(), name: string(display.display_name).trim(),
    operation: string(profile.operation).trim().toLowerCase(), technology: string(profile.technology).trim(),
    active: (string(lifecycle.state) || (projection.active === false ? "retired" : "active")) === "active",
    sortOrder: number(display.catalog_order) ?? number(projection.sort_order) ?? 10000,
    colors: number(profile.color_station_count), minWidth: number(profile.min_web_width_mm), maxWidth: number(profile.max_web_width_mm), row,
  };
}
const operationOrder = ["print", "laminate", "cut", "package", "glue", "unclassified"];
export function apparatusGroups(rows: readonly Row[]): { operation: string; title: string; apparatus: ApparatusOption[] }[] {
  const labels: Record<string, string> = { print: "Bosma", laminate: "Laminatsiya", cut: "Rezka", package: "Paket", glue: "Kley", unclassified: "Boshqa aparatlar" };
  const options = rows.map(apparatusOption).filter(item => item.active && isCanonicalApparatusId(item.id));
  return operationOrder.map(operation => ({
    operation, title: labels[operation],
    apparatus: options.filter(item => (operationOrder.slice(0, -1).includes(item.operation) ? item.operation : "unclassified") === operation)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  })).filter(group => group.apparatus.length > 0);
}
const rubberSize = (width: number) => Math.max(1, Math.min(27, Math.ceil(width / 50))) * 50;
const fitsLamination = (apparatus: ApparatusOption, width?: number | null) => !width || width <= 0 || rubberSize(width) <= (apparatus.technology === "extrusion_lamination" ? 1300 : 1050);
/** Ports mobile print profile, Temir/Flexo and cut-before-lamination selection. */
export function apparatusMatchesMap(row: Row, map: ProductionMapDefinition, template?: CalculateOrderTemplate, catalog: readonly Row[] = []): boolean {
  const apparatus = apparatusOption(row);
  if (!apparatus.active || !isCanonicalApparatusId(apparatus.id)) return false;
  if (apparatus.operation === "laminate") {
    if (fitsLamination(apparatus, map.width_mm)) return true;
    return map.nodes.some(node => {
      const id = node.alternative_assigned_apparatus_id || node.apparatus_id;
      if (node.kind !== "apparatus" || !catalog.some(candidate => { const item = apparatusOption(candidate); return item.id === id && item.operation === "cut"; })) return false;
      const count = node.rezka_kadr_count || 0;
      if (count <= 0) return false;
      const groups = node.rezka_frame_groups || [];
      return groups.length === 0 ? fitsLamination(apparatus, (map.width_mm || 0) / count)
        : groups.reduce((sum, value) => sum + value, 0) === count && groups.every(group => fitsLamination(apparatus, (map.width_mm || 0) * group / count));
    });
  }
  if (apparatus.operation !== "print") return true;
  const method = template?.production_options?.print_method;
  if (method === "flexo" && apparatus.technology !== "flexographic") return false;
  if (method === "metal" && (apparatus.technology !== "rotogravure" || ![7, 8, 9].includes(apparatus.colors || 0))) return false;
  const width = map.print_val_size_mm ?? (template && template.frame_product_size_mm > 0 && template.frame_count > 0 ? template.frame_product_size_mm * template.frame_count : map.width_mm);
  const roll = map.roll_count;
  if (roll && apparatus.colors !== undefined && roll > apparatus.colors) return false;
  if (width && ((apparatus.minWidth !== undefined && width < apparatus.minWidth) || (apparatus.maxWidth !== undefined && width > apparatus.maxWidth))) return false;
  if (apparatus.technology === "flexographic" || apparatus.colors === undefined) return true;
  const metalWidth = map.print_val_size_mm ?? map.width_mm;
  if (roll && roll > 9) return false;
  if (!metalWidth || metalWidth <= 0) return true;
  const rubber = rubberSize(metalWidth);
  return apparatus.colors === 7 ? rubber <= 850 : apparatus.colors === 8 ? rubber >= 150 && rubber <= 1050 : apparatus.colors === 9 ? rubber >= 800 && rubber <= 1350 : false;
}

function hasMapCycle(map: ProductionMapDefinition): boolean {
  const indegree = new Map(map.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(map.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of map.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = [...indegree.keys()].filter(id => indegree.get(id) === 0);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    visited += 1;
    for (const id of outgoing.get(queue[index]) || []) {
      const remaining = indegree.get(id)! - 1;
      indegree.set(id, remaining);
      if (remaining === 0) queue.push(id);
    }
  }
  return visited !== indegree.size;
}
export interface MapValidationIssue { code: string; message: string; nodeId?: string; severity: "error" | "warning" }
export interface MapValidationCatalog { apparatus?: readonly Row[]; warehouses?: readonly Row[]; template?: CalculateOrderTemplate }
export function validateProductionMap(map: ProductionMapDefinition, catalog: MapValidationCatalog = {}): MapValidationIssue[] {
  const issues: MapValidationIssue[] = [];
  const issue = (code: string, message: string, nodeId?: string, severity: "error" | "warning" = "error") => issues.push({ code, message, nodeId, severity });
  if (!map.id.trim()) issue("missing_id", "Xarita identifikatori yo‘q.");
  if (!map.product_code.trim()) issue("missing_product_code", "Mahsulot kodi yo‘q.");
  if (!map.title.trim()) issue("missing_title", "Buyurtma nomi yo‘q.");
  if (map.print_val_size_mm != null && (!Number.isFinite(map.print_val_size_mm) || map.print_val_size_mm <= 0)) issue("invalid_print_val_size", "Val razmeri musbat son bo‘lishi kerak.");
  const starts = map.nodes.filter(node => node.kind === "start"), ends = map.nodes.filter(node => node.kind === "end");
  if (starts.length !== 1) issue("missing_start", "Xaritada bitta boshlanish tuguni bo‘lishi kerak.");
  if (ends.length !== 1) issue("missing_end", "Xaritada bitta tugash tuguni bo‘lishi kerak.");
  const ids = new Set<string>();
  for (const node of map.nodes) {
    const id = node.id.trim().toLowerCase();
    if (!id || ids.has(id)) issue("duplicate_node", "Tugun identifikatori bo‘sh yoki takrorlangan.", node.id);
    ids.add(id);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) issue("invalid_position", "Tugun koordinatasi noto‘g‘ri.", node.id);
    if (!productionNodeKinds.includes(node.kind)) issue("invalid_kind", "Tugun turi tanilmadi.", node.id);
    if (node.kind === "formula" || node.kind === "condition") {
      if (!node.formula?.expression.trim()) issue("missing_formula_expression", "Formula yoki shartni kiriting.", node.id);
      if (node.kind === "formula" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.formula?.target.trim() || "")) issue("invalid_formula_target", "Formula natijasi uchun o‘zgaruvchi nomini kiriting.", node.id);
    }
    if (node.kind === "condition") {
      const branches = new Set(map.edges.filter(edge => edge.from === node.id).map(edge => normalizeMapBranch(edge.branch || "")));
      if (!branches.has("true") || !branches.has("false")) issue("missing_condition_branch", "Shartning «Shunda» va «Aks holda» yo‘llarini ulang.", node.id);
    }
    const apparatusId = node.apparatus_id || "";
    if (node.kind === "apparatus" && !isCanonicalApparatusId(apparatusId)) issue("canonical_apparatus_id_required", "Aparatni ro‘yxatdan tanlang.", node.id);
    const assignedId = node.alternative_assigned_apparatus_id || "";
    if ((assignedId && !isCanonicalApparatusId(assignedId)) || (!assignedId && node.alternative_assigned_title)) issue("canonical_assigned_apparatus_id_required", "Muqobil aparat identifikatori noto‘g‘ri.", node.id);
    if (assignedId && (!node.alternative_group_id || !map.nodes.some(candidate => candidate.kind === "apparatus" && candidate.alternative_group_id === node.alternative_group_id && candidate.apparatus_id === assignedId))) issue("invalid_alternative_assignment", "Tanlangan aparat muqobil guruhda yo‘q.", node.id);
    if (catalog.apparatus && node.kind === "apparatus" && isCanonicalApparatusId(apparatusId)) {
      const apparatus = catalog.apparatus.find(row => apparatusOption(row).id === (assignedId || apparatusId));
      if (!apparatus) issue("apparatus_not_found", "Tanlangan aparat katalogda topilmadi.", node.id, "warning");
      else {
        if (!apparatusMatchesMap(apparatus, map, catalog.template, catalog.apparatus)) issue("incompatible_apparatus", "Aparat buyurtma parametrlariga mos emas.", node.id);
        if (apparatusOption(apparatus).operation === "cut" && (!Number.isSafeInteger(node.rezka_kadr_count) || (node.rezka_kadr_count || 0) <= 0)) issue("rezka_kadr_count_required", "Rezka kadr sozlamasini to‘ldiring.", node.id);
      }
    }
    const groups = node.rezka_frame_groups || [];
    if (groups.length && (!groups.every(value => Number.isSafeInteger(value) && value > 0) || groups.reduce((sum, value) => sum + value, 0) !== node.rezka_kadr_count)) issue("invalid_rezka_frame_groups", "Rezka guruhlari yig‘indisi kadr soniga mos emas.", node.id);
    for (const value of [node.from_location, node.to_location]) {
      const location = value?.trim();
      if (!location) continue;
      if (new TextEncoder().encode(location).length > 120 || !/[\p{L}\p{N}]/u.test(location) || !/^[\p{L}\p{N}\s_.\/()\-]+$/u.test(location)) issue("invalid_location", "Joylashuv nomi yoki kodi noto‘g‘ri.", node.id);
      // The backend also accepts factory locations; the warehouse list is not exhaustive.
      else if (catalog.warehouses && !catalog.warehouses.some(row => [row.name, row.warehouse, row.id].some(value => string(value) === location))) issue("warehouse_not_found", "Joylashuv omborlar ro‘yxatida topilmadi. Serverda tekshiriladi.", node.id, "warning");
    }
  }
  for (const edge of map.edges) if (!ids.has(edge.from.trim().toLowerCase()) || !ids.has(edge.to.trim().toLowerCase())) issue("missing_edge_node", "Bog‘lanishning bir tuguni topilmadi.");
  if (hasMapCycle(map)) issue("cycle", "Xaritada aylanma bog‘lanish bor.");
  if (starts.length === 1) {
    const reachable = new Set([starts[0].id]);
    const queue = [starts[0].id];
    for (let index = 0; index < queue.length; index++) for (const edge of map.edges) if (edge.from === queue[index] && !reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
    for (const node of map.nodes) if (!reachable.has(node.id)) issue("unreachable_node", "Tugun boshlanishdan ulanmagan.", node.id, "warning");
  }
  // Formula evaluation, capacity and custody rules remain authoritative on Mini RS.
  return issues;
}
