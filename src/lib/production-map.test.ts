import { describe, expect, it } from "vitest";
import type { CalculateOrderTemplate, Row } from "./api-types";
import { getDemoPage } from "./demo";
import {
  addAlternativeApparatusGroup, addMapNode, apparatusGroups, apparatusMatchesMap,
  connectMapNodes, createMapNode, createOrderMap, fromEditorGraph, mapEdgeId,
  normalizeMapBranch, productionMapFromRow, removeMapEdge, removeMapNode,
  toEditorGraph, updateMapNode, validateProductionMap, withoutAlternativeAssignments,
} from "./production-map";

const template: CalculateOrderTemplate = {
  name: "Qahva qadoqlari", product: "Qahva qadoqlari", item_code: "FINISHED-7",
  customer: "Mijoz", kg: 120, frame_product_size_mm: 250, frame_count: 3,
  edge_allowance_mm: 15, waste_percent: 5, width_mm: 765,
  production_options: { print_method: "metal", cold_glue: false },
  layers: [{ material: "PET", micron: "12" }],
};
const map = () => createOrderMap(template, { width_mm: 765, results: [{ rounded_length: 1600 }] }, "zakaz-draft-test");
const equipment = (id: string, operation = "print", technology = "rotogravure", extra: Row = {}): Row => ({
  apparatus_id: `apparatus:default:${id}`, display: { display_name: id, catalog_order: 1 },
  execution_profile: { operation, technology, color_station_count: 7, min_web_width_mm: 150, max_web_width_mm: 850, ...extra },
  lifecycle: { state: "active" },
});
const errors = (value: ReturnType<typeof map>, catalog = {}) => validateProductionMap(value, catalog).filter(issue => issue.severity === "error").map(issue => issue.code);

describe("native mobile production map editing", () => {
  it("starts with the mobile order task, leaves identities to Mini RS and uses planned rounded meters", () => {
    expect(map()).toMatchObject({ id: "zakaz-draft-test", code: "", order_number: "", product_code: "FINISHED-7", order_kg: 120, base_length: 1600, customer_name: "Mijoz" });
    expect(map().nodes.map(node => [node.id, node.kind, node.y])).toEqual([["start", "start", 32], ["order", "task", 164], ["end", "end", 296]]);
    expect(map().nodes[1].role_code).toBe("zakaz");
    expect(map().edges).toEqual([{ from: "start", to: "order" }, { from: "order", to: "end" }]);
    expect(errors(map())).toEqual([]);
    expect(map().nodes.some(node => node.kind === "apparatus" || node.kind === "location")).toBe(false);
  });
  it("creates a unique temporary draft once, without using the template identity as an order", () => {
    const first = createOrderMap({ ...template, id: "template-source", order_number: "1234" }, {});
    const second = createOrderMap(template, {});
    expect(first.id).toMatch(/^zakaz-draft-/);
    expect(first.id).not.toBe(second.id);
    expect(first.order_number).toBe("");
  });
  it("round-trips full native params and unknown server metadata while only updating dragged coordinates", () => {
    const source = map();
    source.image_id = "image-7";
    source.nodes[1] = { ...source.nodes[1], apparatus_id: "apparatus:default:station", qty_formula: "order_qty", from_location: "Ombor-1", to_location: "Zavod A", rezka_kadr_count: 3, rezka_frame_groups: [1, 2], rezka_label_length: 250, alternative_group_id: "alt_cut_1", alternative_assigned_title: "Rezka", alternative_assigned_apparatus_id: "apparatus:default:station", custom_future_field: { value: 1 } };
    const native = productionMapFromRow({ map: source, program: {} });
    const editor = toEditorGraph(native);
    editor.nodes[1].position = { x: -15, y: 900 };
    const result = fromEditorGraph(native, editor.nodes, editor.edges);
    expect(result.nodes[1]).toEqual({ ...source.nodes[1], x: -15, y: 900 });
    expect(source.nodes[1].x).toBe(420);
    expect(result.image_id).toBe("image-7");
    (result.nodes[1].custom_future_field as Row).value = 2;
    expect((source.nodes[1].custom_future_field as Row).value).toBe(1);
  });
  it("keeps condition edges distinct even when both branches target the same node", () => {
    const first = { from: "condition", to: "end", branch: "true" }, second = { ...first, branch: "false" };
    expect(mapEdgeId(first)).not.toBe(mapEdgeId(second));
    expect(normalizeMapBranch(" HA ")).toBe("true");
    expect(normalizeMapBranch("yo'q")).toBe("false");
    const value = { ...map(), edges: [first, second] };
    const graph = toEditorGraph(value);
    expect(graph.edges.map(edge => edge.label)).toEqual(["Shunda", "Aks holda"]);
    expect(fromEditorGraph(value, graph.nodes, graph.edges).edges).toEqual([first, second]);
    expect(removeMapEdge(value, first).edges).toEqual([second]);
  });
  it("inserts a process before finish without overwriting native branch metadata", () => {
    const source = map();
    source.edges[1].branch = "true";
    const node = createMapNode(source, "task", { apparatus_id: "apparatus:default:station" });
    const result = addMapNode(source, node);
    expect(result.edges).toContainEqual({ from: "order", to: node.id, branch: "true" });
    expect(result.edges).toContainEqual({ from: node.id, to: "end" });
    expect(source.nodes).toHaveLength(3);
    expect(result.nodes.find(item => item.id === "end")?.y).toBe(428);
  });
  it("uses immutable node ids and removes only actual incident connections on deletion", () => {
    const added = addMapNode(map(), createMapNode(map(), "task"));
    const edited = updateMapNode(added, "task_1", { id: "wrong", title: "Kesish" });
    expect(edited.nodes.find(node => node.id === "task_1")?.title).toBe("Kesish");
    const removed = removeMapNode(edited, "task_1");
    expect(removed.edges).toEqual([{ from: "start", to: "order" }]);
    expect(removeMapNode(removed, "start")).toEqual(removed);
    expect(removeMapNode(removed, "end")).toEqual(removed);
  });
  it("rejects dangling connections and cycles; connecting an existing edge is idempotent", () => {
    expect(() => connectMapNodes(map(), "missing", "end")).toThrow();
    expect(() => connectMapNodes(map(), "end", "start")).toThrow(/aylanma/);
    expect(connectMapNodes(map(), "start", "order").edges).toHaveLength(2);
  });
  it("requires both native condition branches and one start/finish", () => {
    let value = addMapNode(map(), createMapNode(map(), "condition"));
    expect(errors(value)).toContain("missing_condition_branch");
    value = connectMapNodes(value, "condition_1", "end", "ha");
    value = connectMapNodes(value, "condition_1", "end", "no");
    expect(errors(value)).toEqual([]);
    expect(errors({ ...value, nodes: value.nodes.filter(node => node.kind !== "end") })).toContain("missing_end");
  });
  it("reports disconnected nodes as warnings and delegates expression evaluation to Mini RS", () => {
    const value = addMapNode(map(), createMapNode(map(), "formula", { formula: { target: "custom_kg", expression: "order_qty / custom_ratio" } }), { beforeEnd: false });
    expect(errors(value)).toEqual([]);
    expect(validateProductionMap(value)).toContainEqual(expect.objectContaining({ code: "unreachable_node", severity: "warning" }));
  });
  it("preserves parallel candidate topology through successive alternative groups", () => {
    const printers = [equipment("print-7"), equipment("print-8", "print", "rotogravure", { color_station_count: 8 })];
    const first = addAlternativeApparatusGroup(map(), printers, "Bosma");
    const cuts = [equipment("cut-1", "cut", "slitting"), equipment("cut-2", "cut", "slitting")];
    const second = addAlternativeApparatusGroup(first, cuts, "Rezka", { rezka_kadr_count: 3, rezka_frame_groups: [1, 2] });
    const printNodes = second.nodes.filter(node => node.alternative_group_label === "Bosma"), cutNodes = second.nodes.filter(node => node.alternative_group_label === "Rezka");
    expect(printNodes).toHaveLength(2);
    expect(cutNodes).toHaveLength(2);
    for (const printer of printNodes) for (const cutter of cutNodes) expect(second.edges).toContainEqual({ from: printer.id, to: cutter.id });
    for (const cutter of cutNodes) {
      expect(second.edges).toContainEqual({ from: cutter.id, to: "end" });
      expect(cutter.rezka_frame_groups).toEqual([1, 2]);
    }
    expect(errors(second, { apparatus: [...printers, ...cuts], template })).toEqual([]);
  });
  it("clears dispatch assignment before saving an order template, preserving candidate groups and rezka settings", () => {
    const source = addAlternativeApparatusGroup(map(), [equipment("print-7")], "Bosma", { rezka_kadr_count: 3, rezka_frame_groups: [3] });
    source.nodes[2].alternative_assigned_title = "print-7";
    source.nodes[2].alternative_assigned_apparatus_id = "apparatus:default:print-7";
    const clean = withoutAlternativeAssignments(source);
    expect(clean.nodes[2]).not.toHaveProperty("alternative_assigned_apparatus_id");
    expect(clean.nodes[2]).not.toHaveProperty("alternative_assigned_title");
    expect(clean.nodes[2].alternative_group_id).toBe(source.nodes[2].alternative_group_id);
    expect(clean.nodes[2].rezka_frame_groups).toEqual([3]);
    expect(source.nodes[2].alternative_assigned_title).toBe("print-7");
  });
});

describe("mobile apparatus selection and validation", () => {
  it("keeps actual demo Flexo candidates selectable and respects their native color counts", () => {
    const demoTemplate: CalculateOrderTemplate = {
      ...template, frame_product_size_mm: 250, frame_count: 2, width_mm: 515, roll_count: 5,
      production_options: { print_method: "flexo", cold_glue: false },
    };
    const value = createOrderMap(demoTemplate, { width_mm: 515 }, "zakaz-draft-preview");
    const catalog = getDemoPage("apparatus", { limit: 500 }).items;
    const printers = apparatusGroups(catalog).find(group => group.operation === "print")!.apparatus;
    expect(printers.filter(item => apparatusMatchesMap(item.row, value, demoTemplate, catalog)).map(item => item.name)).toEqual(["Flexo 01", "Flexo 02"]);
    expect(printers.filter(item => apparatusMatchesMap(item.row, { ...value, roll_count: 7 }, demoTemplate, catalog)).map(item => item.name)).toEqual(["Flexo 01"]);
  });
  it("groups active canonical profiles by operation and orders by catalog order", () => {
    const retired = equipment("retired"); retired.lifecycle = { state: "retired" };
    const rows = [equipment("cut", "cut", "slitting"), equipment("print"), retired, { id: "legacy", name: "Legacy" }];
    expect(apparatusGroups(rows).map(group => group.operation)).toEqual(["print", "cut"]);
    expect(apparatusGroups(rows)[0].apparatus[0]).toMatchObject({ id: "apparatus:default:print", name: "print", operation: "print" });
  });
  it("keeps Flexo independent of metal cylinder limits and checks the canonical print profile", () => {
    const flexo = equipment("flexo", "print", "flexographic", { color_station_count: 8, max_web_width_mm: 1500 });
    const value = { ...map(), width_mm: 1200, roll_count: 8 };
    const draft = { ...template, production_options: { print_method: "flexo" as const, cold_glue: false }, frame_product_size_mm: 400 };
    expect(apparatusMatchesMap(flexo, value, draft)).toBe(true);
    expect(apparatusMatchesMap(flexo, value, template)).toBe(false);
    expect(apparatusMatchesMap(flexo, { ...value, roll_count: 9 }, draft)).toBe(false);
    expect(apparatusMatchesMap(flexo, { ...value, print_val_size_mm: 1600 }, draft)).toBe(false);
  });
  it("uses print-val routing width without substituting the material width", () => {
    const printer = equipment("print-7");
    expect(apparatusMatchesMap(printer, { ...map(), width_mm: 1000 }, template)).toBe(false);
    expect(apparatusMatchesMap(printer, { ...map(), width_mm: 1000, print_val_size_mm: 800 }, template)).toBe(true);
  });
  it("allows wider lamination only after native cut frame groups fit the machine", () => {
    const laminator = equipment("laminate", "laminate", "solventless");
    const cutter = equipment("cut", "cut", "slitting");
    const source = { ...map(), width_mm: 1200 };
    expect(apparatusMatchesMap(laminator, source, template, [cutter])).toBe(false);
    const divided = addMapNode(source, createMapNode(source, "apparatus", { apparatus_id: "apparatus:default:cut", rezka_kadr_count: 3, rezka_frame_groups: [1, 2] }));
    expect(apparatusMatchesMap(laminator, divided, template, [cutter])).toBe(true);
    divided.nodes.find(node => node.kind === "apparatus")!.rezka_frame_groups = [3];
    expect(apparatusMatchesMap(laminator, divided, template, [cutter])).toBe(false);
  });
  it("checks canonical ids and exact rezka sums, without inventing a required warehouse", () => {
    const cutter = equipment("cut", "cut", "slitting");
    const value = addMapNode(map(), createMapNode(map(), "apparatus", { apparatus_id: "apparatus:default:cut", rezka_kadr_count: 3, rezka_frame_groups: [2, 2] }));
    expect(errors(value, { apparatus: [cutter] })).toContain("invalid_rezka_frame_groups");
    expect(errors(updateMapNode(value, "apparatus_1", { apparatus_id: "Rezka" }))).toContain("canonical_apparatus_id_required");
    expect(errors(map(), { warehouses: [] })).toEqual([]);
    expect(validateProductionMap(updateMapNode(map(), "order", { from_location: "Zavod A" }), { warehouses: [] })).toContainEqual(expect.objectContaining({ code: "warehouse_not_found", severity: "warning" }));
  });
});
