import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./api";
import type { CalculateOrderTemplate, ProductionSnapshot } from "./api-types";
import type { ProductionMapDefinition } from "./production-map";
import {
  assertExistingMapBaseline, existingMapErrorMessage, existingMapForSave,
  existingMapIncomingEdgeIsLocked, existingMapLockedNodeIds, existingMapLockViolation,
  existingMapRecoveryResult, existingMapSaveMayHaveSucceeded, existingMapSignature,
  loadExistingMap, parseExistingMapSaved, readExistingMapState, saveExistingMap,
} from "./existing-map";
import type { ExistingMapState } from "./existing-map";

const id = "zakaz-0031";
const first = "apparatus:default:print-7", second = "apparatus:default:cut-1";
const template: CalculateOrderTemplate = {
  id: "calculate-31", source_map_id: id, code: "0031", order_number: "0031",
  name: "Buyurtma", product: "Film", customer: "Mijoz", item_code: "FILM-1",
  kg: 200, frame_product_size_mm: 250, frame_count: 3, edge_allowance_mm: 15,
  width_mm: 765, waste_percent: 5, roll_count: 6, layers: [{ material: "PET", micron: "12" }],
  production_options: { print_method: "metal", cold_glue: false },
};
const native = (): ProductionMapDefinition => ({
  id, product_code: "FILM-1", title: "Film", code: "0031", order_number: "0031",
  customer_name: "Mijoz", width_mm: 765, print_val_size_mm: 750, order_kg: 200,
  roll_count: 6, base_length: 10500, image_id: "image31", future_metadata: { keep: true },
  nodes: [
    { id: "start", kind: "start", title: "Boshlanish", x: 420, y: 32 },
    { id: "print", kind: "apparatus", title: "Bosma", apparatus_id: first, x: 420, y: 164 },
    { id: "cut", kind: "apparatus", title: "Rezka", apparatus_id: second, rezka_kadr_count: 3, rezka_frame_groups: [1, 2], x: 420, y: 296 },
    { id: "end", kind: "end", title: "Mahsulot", item_code: "FILM-1", x: 420, y: 428 },
  ],
  edges: [{ from: "start", to: "print" }, { from: "print", to: "cut" }, { from: "cut", to: "end" }],
});
const wrapper = (map = native()) => ({ map, program: { map_id: map.id, product_code: map.product_code, operations: [] } });
const snapshot = (map = native(), patch: Partial<ProductionSnapshot> = {}): ProductionSnapshot => ({
  ok: true, rev: 10, epoch: "epoch1", scope: "", maps: [wrapper(map)],
  order_statuses: { [map.id]: { lifecycle_status: "in_progress" } },
  order_customers: { [map.id]: "Mijoz" }, sequences: {}, queue_states: {}, stage_states: {}, queue_action_controls: {}, order_controls: {}, ...patch,
});
const state = (map = native(), patch: Partial<ProductionSnapshot> = {}): ExistingMapState => ({ saved: wrapper(map), snapshot: snapshot(map, patch) });
const client = () => new ApiClient({ endpoint: "http://localhost:8181", token: "fixture-token" });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

function transport(options: { current?: ProductionMapDefinition; snapshotPatch?: Partial<ProductionSnapshot>; source?: unknown; sourceStatus?: number; put?: (map: ProductionMapDefinition) => Response | Promise<Response> } = {}) {
  const map = options.current || native();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/order-edit")) return json(options.source ?? { map, template, revision: 3, future_source: "preserved" }, options.sourceStatus);
    if (url.pathname.endsWith("/sequence")) return json(snapshot(map, options.snapshotPatch));
    if (init?.method === "PUT") return options.put ? options.put(JSON.parse(String(init.body)) as ProductionMapDefinition) : json(wrapper(JSON.parse(String(init.body)) as ProductionMapDefinition));
    return json(wrapper(map));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const writes = (fetch: ReturnType<typeof transport>) => fetch.mock.calls.filter(([, init]) => init?.method === "PUT");

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("existing native map loading", () => {
  it("loads the exact saved map, calculation template, metadata and revisioned stage authority", async () => {
    const fetch = transport();
    const loaded = await loadExistingMap(client(), id);
    expect(loaded.saved.map).toMatchObject(native());
    expect(loaded.template).toEqual(template);
    expect(loaded.calculationSource).toMatchObject({ revision: 3, future_source: "preserved" });
    expect(loaded.snapshot).toMatchObject({ rev: 10, epoch: "epoch1" });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual([
      "/v1/mobile/admin/production-maps", "/v1/mobile/admin/production-maps/order-edit", "/v1/mobile/admin/production-maps/sequence",
    ]);
    expect(writes(fetch)).toHaveLength(0);
  });
  it("allows future-route editing when the separate calculation endpoint is locked, without fabricating a template", async () => {
    transport({ sourceStatus: 409, source: { error: "Buyurtmada harakat bor" } });
    const loaded = await loadExistingMap(client(), id);
    expect(loaded.template).toBeUndefined();
    expect(loaded.templateNotice).toContain("Calculate tahriri yopiq");
    expect(loaded.saved.map).toMatchObject({ order_kg: 200, width_mm: 765, base_length: 10500 });
    expect(loaded.saved.map.nodes[2].rezka_frame_groups).toEqual([1, 2]);
  });
  it.each([403, 500])("does not hide a calculation load authorization/server failure (%s)", async status => {
    transport({ sourceStatus: status, source: { error: status === 403 ? "forbidden" : "store_failed" } });
    await expect(loadExistingMap(client(), id)).rejects.toMatchObject({ status });
  });
  it("rejects a torn map/snapshot read and a calculation snapshot for another map", async () => {
    const changed = native(); changed.nodes[2].x = 900;
    transport({ snapshotPatch: { maps: [wrapper(changed)] } });
    await expect(readExistingMapState(client(), id)).rejects.toMatchObject({ status: 409, code: "map_snapshot_changed" });
    transport({ source: { map: { ...native(), id: "zakaz-other" }, template, revision: 3 } });
    await expect(loadExistingMap(client(), id)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects malformed native graph/program contracts instead of silently loading an empty editor", () => {
    for (const value of [native(), { ...wrapper(), program: {} }, wrapper({ ...native(), id: "other" }), wrapper({ ...native(), nodes: [{ ...native().nodes[0], x: Infinity }] })]) {
      expect(() => parseExistingMapSaved(value, id)).toThrow(ApiError);
    }
  });
});

describe("native map edit policy", () => {
  it.each(["print_preflight", "in_progress", "paused", "frozen", "completed", "unknown_state"])("locks an apparatus with stored state %s", value => {
    expect(existingMapLockedNodeIds(native(), snapshot(native(), { queue_states: { [first]: { [id]: value } } }))).toEqual(new Set(["print"]));
  });
  it("does not lock absent or pending stages and does not infer starts from global order status", () => {
    expect(existingMapLockedNodeIds(native(), snapshot())).toEqual(new Set());
    expect(existingMapLockedNodeIds(native(), snapshot(native(), { queue_states: { [first]: { [id]: " Pending " } } }))).toEqual(new Set());
  });
  it("locks canonical stage history even when the apparatus queue entry is gone", () => {
    const authority = snapshot(native(), { stage_states: { [id]: { print: "completed", cut: "pending" } } });
    expect(existingMapLockedNodeIds(native(), authority)).toEqual(new Set(["print"]));
  });
  it("uses canonical pending stage state instead of a global frozen queue overlay for future apparatus", () => {
    const authority = snapshot(native(), { queue_states: { [first]: { [id]: "frozen" }, [second]: { [id]: "frozen" } },
      stage_states: { [id]: { print: "frozen", cut: "pending" } }, order_controls: { [id]: { state: "frozen" } } });
    expect(existingMapLockedNodeIds(native(), authority)).toEqual(new Set(["print"]));
  });
  it("resolves assigned canonical apparatus identities and locks the entire alternative group", () => {
    const map = native();
    map.nodes[1] = { ...map.nodes[1], alternative_group_id: "alt_print", alternative_assigned_apparatus_id: "apparatus:default:print-8", alternative_assigned_title: "Bosma 8" };
    map.nodes.push({ ...map.nodes[1], id: "alternative", apparatus_id: "apparatus:default:print-8", x: 720 });
    const authority = snapshot(map, { queue_states: { "apparatus:default:print-8": { [id]: "paused" } } });
    expect(existingMapLockedNodeIds(map, authority)).toEqual(new Set(["print", "alternative"]));
  });
  it("rejects moving/removing/changing a started node or incoming edge, and allows future-route rewiring", () => {
    const map = native(), locked = new Set(["print"]);
    const moved = structuredClone(map); moved.nodes[1].x += 1;
    expect(existingMapLockViolation(map, moved, locked)).toBe(true);
    const removed = { ...map, nodes: map.nodes.filter(node => node.id !== "print") };
    expect(existingMapLockViolation(map, removed, locked)).toBe(true);
    expect(existingMapLockViolation(map, { ...map, edges: map.edges.slice(1) }, locked)).toBe(true);
    const future = structuredClone(map); future.nodes[2].title = "Kelgusi Rezka";
    future.edges = [{ from: "start", to: "print" }, { from: "print", to: "end" }];
    expect(existingMapLockViolation(map, future, locked)).toBe(false);
    expect(existingMapIncomingEdgeIsLocked(map.edges[0], locked)).toBe(true);
    expect(existingMapIncomingEdgeIsLocked(map.edges[1], locked)).toBe(false);
  });
  it("retains saved order/calculation/image metadata and assigned alternatives in the update", () => {
    const original = native();
    original.nodes[1].alternative_assigned_apparatus_id = first;
    original.nodes[1].alternative_assigned_title = "Bosma";
    const draft = { ...structuredClone(original), id: "new-order", order_kg: 900, width_mm: 200, title: "Changed product", image_id: "other" };
    draft.nodes[2].x = 500;
    const update = existingMapForSave(original, draft);
    expect(update).toMatchObject({ id, order_kg: 200, width_mm: 765, title: "Film", image_id: "image31", future_metadata: { keep: true } });
    expect(update.nodes[1].alternative_assigned_apparatus_id).toBe(first);
    expect(update.nodes[2].x).toBe(500);
    expect(original.nodes[2].x).toBe(420);
  });
  it("compares omitted native defaults while retaining unknown metadata for concurrency detection", () => {
    const map = native(), other = structuredClone(map);
    other.nodes[1] = { ...other.nodes[1], formula: null, role_code: "", item_code: "", rezka_frame_groups: [], rezka_label_length: null };
    other.edges[0].branch = "";
    delete other.code;
    expect(existingMapSignature(other)).toBe(existingMapSignature(map));
    other.future_metadata = { keep: false };
    expect(existingMapSignature(other)).not.toBe(existingMapSignature(map));
  });
});

describe("existing order concurrency, authorization and outcome recovery", () => {
  it("accepts unrelated revision progress, and rejects a changed map, epoch, identity scope or older snapshot", () => {
    expect(() => assertExistingMapBaseline(state(), state(native(), { rev: 11 }))).not.toThrow();
    for (const patch of [{ rev: 9 }, { epoch: "other" }, { scope: "other" }]) expect(() => assertExistingMapBaseline(state(), state(native(), patch))).toThrow(ApiError);
    const changed = native(); changed.nodes[2].x = 700;
    expect(() => assertExistingMapBaseline(state(), state(changed))).toThrow(/boshqa oynada/);
  });
  it("PUTs one fixed existing-order native DTO, without a new-order endpoint or unsupported revision/idempotency fields", async () => {
    const fetch = transport(), draft = native(); draft.nodes[2].x = 700;
    const saved = await saveExistingMap(client(), state(), draft);
    expect(saved.map.id).toBe(id);
    expect(saved.map.nodes[2].x).toBe(700);
    expect(writes(fetch)).toHaveLength(1);
    const [url, init] = writes(fetch)[0];
    expect(new URL(String(url)).pathname).toBe("/v1/mobile/admin/production-maps");
    expect(JSON.parse(String(init?.body))).toEqual(existingMapForSave(native(), draft));
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeNull();
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("template");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("expected_revision");
  });
  it("rejects a concurrent change or newly-started stage before sending any PUT", async () => {
    const draft = native(); draft.nodes[1].x = 700;
    const changed = native(); changed.nodes[2].x = 900;
    let fetch = transport({ current: changed });
    await expect(saveExistingMap(client(), state(), draft)).rejects.toMatchObject({ status: 409, code: "map_edit_conflict" });
    expect(writes(fetch)).toHaveLength(0);
    fetch = transport({ snapshotPatch: { queue_states: { [first]: { [id]: "in_progress" } } } });
    await expect(saveExistingMap(client(), state(), draft)).rejects.toMatchObject({ code: "production_map_started_stage_locked" });
    expect(writes(fetch)).toHaveLength(0);
  });
  it.each([403, 409])("preserves a definitive write refusal (%s), with no retry", async status => {
    const fetch = transport({ put: () => json({ error: status === 403 ? "forbidden" : "production_map_started_stage_locked" }, status) });
    const draft = native(); draft.nodes[2].x = 700;
    let error: unknown;
    try { await saveExistingMap(client(), state(), draft); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status });
    expect(existingMapSaveMayHaveSucceeded(error)).toBe(false);
    expect(writes(fetch)).toHaveLength(1);
    if (status === 403) expect(existingMapErrorMessage(error as Error)).toContain("ruxsat berilmagan");
  });
  it("recognizes uncertain writes without automatically replaying, and distinguishes saved/unchanged/conflicting recovery", async () => {
    const fetch = transport({ put: async () => { throw new TypeError("Disconnected"); } });
    const draft = native(); draft.nodes[2].x = 700;
    let error: unknown;
    try { await saveExistingMap(client(), state(), draft); } catch (caught) { error = caught; }
    expect(existingMapSaveMayHaveSucceeded(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(writes(fetch)).toHaveLength(1);
    expect(existingMapRecoveryResult(state(), draft, state(draft, { rev: 11 }))).toBe("saved");
    expect(existingMapRecoveryResult(state(), draft, state())).toBe("unchanged");
    const other = native(); other.nodes[2].x = 800;
    expect(existingMapRecoveryResult(state(), draft, state(other, { rev: 11 }))).toBe("conflict");
    expect(existingMapRecoveryResult(state(), draft, state(draft, { epoch: "new-server" }))).toBe("conflict");
  });
  it("accepts the already-saved exact retry payload without issuing another PUT", async () => {
    const draft = native(); draft.nodes[2].x = 700;
    const fetch = transport({ current: draft, snapshotPatch: { rev: 11 } });
    expect((await saveExistingMap(client(), state(), draft)).map.nodes[2].x).toBe(700);
    expect(writes(fetch)).toHaveLength(0);
  });
  it("treats an invalid or wrong-map successful write response as uncertain", async () => {
    transport({ put: () => json(wrapper({ ...native(), id: "other-order" })) });
    const draft = native(); draft.nodes[2].x = 700;
    await expect(saveExistingMap(client(), state(), draft)).rejects.toMatchObject({ status: 502, code: "invalid_response" });
    expect(existingMapSaveMayHaveSucceeded(new ApiError(502, "invalid_response"))).toBe(true);
  });
  it("allows one in-flight save for one client/order and releases that guard after completion", async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    const fetch = transport({ put: map => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : json(wrapper(map)) });
    const api = client(), draft = native(); draft.nodes[2].x = 700;
    const saving = saveExistingMap(api, state(), draft);
    await vi.waitFor(() => expect(writes(fetch)).toHaveLength(1));
    await expect(saveExistingMap(api, state(), draft)).rejects.toMatchObject({ code: "map_save_in_progress" });
    expect(writes(fetch)).toHaveLength(1);
    finish(json(wrapper(draft)));
    await saving;
    await expect(saveExistingMap(api, state(), draft)).resolves.toMatchObject({ map: { id } });
    expect(writes(fetch)).toHaveLength(2);
  });
  it("does not write after a session/route lease changes during preflight", async () => {
    const fetch = transport(), draft = native(); draft.nodes[2].x = 700;
    await expect(saveExistingMap(client(), state(), draft, { isCurrent: () => false })).rejects.toMatchObject({ name: "AbortError" });
    expect(writes(fetch)).toHaveLength(0);
  });
});
