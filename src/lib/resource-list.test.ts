import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { ApiClient } from "./api";
import type { Query, ResourceKind } from "./api-types";
import { resourceListOptions } from "./resource-list";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

function openList(kind: ResourceKind, query: Query = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = new ApiClient({ endpoint: "https://erp.example.com", token: "qa-token" });
  const observer = new InfiniteQueryObserver(queryClient, {
    ...resourceListOptions({ queryClient, client: api, demo: false, scope: "qa", kind, query }),
    enabled: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(() => { unsubscribe(); queryClient.clear(); });
  return { observer, queryClient };
}

type ListObserver = ReturnType<typeof openList>["observer"];
async function loadAll(observer: ListObserver) {
  await observer.refetch();
  while (observer.getCurrentResult().hasNextPage)
    await observer.fetchNextPage({ cancelRefetch: false });
  return observer.getCurrentResult().data!.pages.flatMap((page) => page.items);
}

describe("resource scroll loading", () => {
  it("does not request the inventory projection for a disabled factory-only entry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = new ApiClient({ endpoint: "https://erp.example.com", token: "qa-token" });
    const options = resourceListOptions({ queryClient, client, demo: false, scope: "factory-only", kind: "locations", query: {}, enabled: false });
    const observer = new InfiniteQueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    cleanups.push(() => { unsubscribe(); queryClient.clear(); });
    await queryClient.invalidateQueries({ queryKey: ["resource", "factory-only", "locations"] });
    expect(options.enabled).toBe(false);
    expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("appends every stock record once and keeps warehouse/search on every request", async () => {
    const source = Array.from({ length: 53 }, (_, i) => ({ code: `stock-${i}`, order_id: `order-${i}` }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return new Response(JSON.stringify(source.slice(offset, offset + limit)));
    });
    vi.stubGlobal("fetch", fetch);
    const { observer } = openList("stock", { warehouse: "Ombor A", q: "Film" });
    expect(await loadAll(observer)).toEqual(source);
    expect(fetch.mock.calls.map(([input]) => Object.fromEntries(new URL(String(input)).searchParams))).toEqual([
      { warehouse: "Ombor A", q: "Film", offset: "0", limit: "21" },
      { warehouse: "Ombor A", q: "Film", offset: "20", limit: "21" },
      { warehouse: "Ombor A", q: "Film", offset: "40", limit: "21" },
    ]);
  });

  it("uses the users envelope has_more without repeating or skipping a page", async () => {
    const source = Array.from({ length: 45 }, (_, i) => ({ id: `user-${i}` }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return new Response(JSON.stringify({ items: source.slice(offset, offset + limit), has_more: offset + limit < source.length }));
    });
    vi.stubGlobal("fetch", fetch);
    expect(await loadAll(openList("users").observer)).toEqual(source);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("offset"))).toEqual(["0", "20", "40"]);
  });

  it("reveals an entire unpaged response above 500 records from one server request", async () => {
    const source = Array.from({ length: 625 }, (_, i) => ({ id: `event-${i}` }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(source)));
    vi.stubGlobal("fetch", fetch);
    const { observer } = openList("activity");
    await observer.refetch();
    expect(observer.getCurrentResult().data!.pages[0].items).toEqual(source.slice(0, 20));
    while (observer.getCurrentResult().hasNextPage) await observer.fetchNextPage();
    expect(observer.getCurrentResult().data!.pages.flatMap((page) => page.items)).toEqual(source);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains server-cap metadata while locally revealing a limit-only response", async () => {
    const source = Array.from({ length: 500 }, (_, i) => ({ id: `worker-${i}` }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(source)));
    vi.stubGlobal("fetch", fetch);
    const { observer } = openList("workers");
    expect(await loadAll(observer)).toEqual(source);
    expect(observer.getCurrentResult().data!.pages.every((page) => page.bounded)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "500" });
  });

  it("renews a cached response on refresh while retaining the already displayed depth", async () => {
    const oldRows = Array.from({ length: 42 }, (_, i) => ({ id: `role-${i}`, label: "Old" }));
    const newRows = oldRows.map((row) => ({ ...row, label: "New" }));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(oldRows)))
      .mockResolvedValueOnce(new Response(JSON.stringify(newRows)));
    vi.stubGlobal("fetch", fetch);
    const { observer, queryClient } = openList("roles");
    expect(await loadAll(observer)).toEqual(oldRows);
    await queryClient.invalidateQueries({ queryKey: ["resource", "qa", "roles"] });
    await observer.refetch();
    expect(observer.getCurrentResult().data!.pages.flatMap((page) => page.items)).toEqual(newRows);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded rows after a failed next request and permits retry", async () => {
    const source = Array.from({ length: 25 }, (_, i) => ({ code: `item-${i}` }));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(source.slice(0, 21))))
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(source.slice(20))));
    vi.stubGlobal("fetch", fetch);
    const { observer } = openList("items");
    await observer.refetch();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
    expect(observer.getCurrentResult().data!.pages.flatMap((page) => page.items)).toEqual(source.slice(0, 20));
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data!.pages.flatMap((page) => page.items)).toEqual(source);
  });

  it("isolates warehouse filters and session scopes", async () => {
    let version = 1;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify([{ code: `${url.searchParams.get("warehouse")}-${version}` }]));
    });
    vi.stubGlobal("fetch", fetch);
    const queryClient = new QueryClient();
    cleanups.push(() => queryClient.clear());
    const client = new ApiClient({ endpoint: "https://erp.example.com", token: "qa-token" });
    const args = { queryClient, client, demo: false, kind: "stock" as const, scope: "one" };
    const first = resourceListOptions({ ...args, query: { warehouse: "A" } });
    const second = resourceListOptions({ ...args, query: { warehouse: "B" } });
    const otherSession = resourceListOptions({ ...args, scope: "two", query: { warehouse: "A" } });
    await queryClient.fetchInfiniteQuery(first);
    await queryClient.fetchInfiniteQuery(second);
    version = 2;
    await queryClient.fetchInfiniteQuery(otherSession);
    expect(queryClient.getQueryData(first.queryKey)?.pages[0].items).toEqual([{ code: "A-1" }]);
    expect(queryClient.getQueryData(second.queryKey)?.pages[0].items).toEqual([{ code: "B-1" }]);
    expect(queryClient.getQueryData(otherSession.queryKey)?.pages[0].items).toEqual([{ code: "A-2" }]);
    expect(resourceListOptions({ ...args, query: {} }).enabled).toBe(false);
  });
});
