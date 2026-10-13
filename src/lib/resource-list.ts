import { infiniteQueryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { resourceDefinitions } from "./api";
import type { ApiClient } from "./api";
import type { Query, ResourceKind } from "./api-types";
import { getDemoPage } from "./demo";

export function resourceListOptions({
  queryClient,
  client,
  demo,
  scope,
  kind,
  query,
}: {
  queryClient: QueryClient;
  client: ApiClient | null;
  demo: boolean;
  scope: string;
  kind: ResourceKind;
  query: Query;
}) {
  const limit = 20;
  const local =
    demo || (kind === 'suppliers' && query.inactive === true) || ["all", "limit"].includes(resourceDefinitions[kind].pagination);
  return infiniteQueryOptions({
    queryKey: ["resource", scope, kind, "infinite", query],
    initialPageParam: 0,
    enabled:
      (demo || Boolean(client)) &&
      (kind !== "stock" || Boolean(query.warehouse)),
    queryFn: async ({ signal, pageParam: offset }) => {
      if (!local) return client!.list(kind, { ...query, offset, limit }, signal);
      const snapshot = await queryClient.fetchQuery({
        queryKey: ["resource", scope, kind, "snapshot", query],
        queryFn: ({ signal: snapshotSignal }) =>
          demo
            ? getDemoPage(kind, { ...query, limit: Number.MAX_SAFE_INTEGER })
            : client!.listSnapshot(
                kind,
                query,
                AbortSignal.any([signal, snapshotSignal]),
              ),
        // Scrolling retains one response; reopening or refreshing may renew it.
        staleTime: offset === 0 ? 30_000 : Infinity,
      });
      return {
        items: snapshot.items.slice(offset, offset + limit),
        hasMore: offset + limit < snapshot.items.length,
        bounded: snapshot.bounded,
      };
    },
    getNextPageParam: (page, _pages, offset) =>
      page.hasMore ? offset + limit : undefined,
  });
}
