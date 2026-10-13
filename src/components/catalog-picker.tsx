import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { getDemoPage } from "@/lib/demo";
import { isRecord, text } from "@/lib/api";
import type { Page, Row } from "@/lib/api-types";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Keep loaded choices visible while scrolling through the server catalog. */
export function CatalogPicker({
  id,
  kind,
  label,
  value,
  selectedLabel,
  onSelect,
  calculateProducts = false,
  customerRef = "",
  disabled = false,
}: {
  id: string;
  kind: "customers" | "items" | "materials";
  label: string;
  value: string;
  selectedLabel: string;
  onSelect: (row: Row) => void;
  calculateProducts?: boolean;
  customerRef?: string;
  disabled?: boolean;
}) {
  const { client, demo, scope } = useSession();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const q = useDeferredValue(search.trim());
  const limit = 20;
  const catalog = useInfiniteQuery({
    queryKey: [
      "catalog-picker-infinite",
      scope,
      kind,
      calculateProducts,
      customerRef,
      q,
    ],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam: offset }) =>
      demo
        ? demoCatalog(kind, q, offset, limit, calculateProducts, customerRef)
        : kind === "materials"
          ? client!.calculateMaterials({ q, offset, limit }, signal)
          : calculateProducts
            ? client!.calculateProducts(
                { customerRef, q, offset, limit },
                signal,
              )
            : client!.list(kind, { q, offset, limit }, signal),
    enabled: open,
    getNextPageParam: (page, _pages, offset) =>
      page.hasMore ? offset + limit : undefined,
  });
  const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError } =
    catalog;
  useEffect(() => {
    if (
      !open ||
      !hasNextPage ||
      isFetching ||
      isFetchNextPageError ||
      !listRef.current ||
      !endRef.current
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false });
      },
      { root: listRef.current, rootMargin: "0px 0px 64px 0px" },
    );
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [open, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  const key = kind === "customers" ? "ref" : kind === "items" ? "code" : "id";
  const items = catalog.data?.pages.flatMap((page) => page.items) || [];
  return (
    <>
      <Button
        type="button"
        id={id}
        variant="outline"
        disabled={disabled}
        className="w-full justify-between font-normal"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>
          {selectedLabel || `${label} tanlang`}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      <CommandDialog
        title={`${label} tanlash`}
        description="Ro‘yxatdan qidiring. Keyingi natijalar pastga scroll qilinganda yuklanadi."
        open={open}
        onOpenChange={setOpen}
        showCloseButton
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`${label} qidirish…`}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList ref={listRef} aria-busy={catalog.isFetching}>
            {catalog.isPending ? (
              <div
                role="status"
                className="flex justify-center gap-2 p-6 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                Yuklanmoqda…
              </div>
            ) : catalog.error && !catalog.data ? (
              <div className="space-y-2 p-4 text-sm text-destructive">
                <p>{catalog.error.message}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void catalog.refetch();
                  }}
                >
                  Qayta urinish
                </Button>
              </div>
            ) : (
              <>
                {!catalog.hasNextPage && !catalog.isFetching && (
                  <CommandEmpty>Natija topilmadi.</CommandEmpty>
                )}
                <CommandGroup>
                  {items
                    .filter(
                      (row) => kind !== "materials" || row.active !== false,
                    )
                    .map((row) => (
                      <CommandItem
                        key={text(row[key])}
                        value={text(row[key])}
                        onSelect={() => {
                          onSelect(row);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={
                            String(row[key]) === value ? "" : "invisible"
                          }
                        />
                        <span>{text(row.name || row[key])}</span>
                        {kind === "items" && (
                          <span className="ml-auto text-xs text-muted-foreground">
                            {text(row.code)}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                </CommandGroup>
                <div ref={endRef} className="h-px" aria-hidden="true" />
                {catalog.isFetchingNextPage ? (
                  <div
                    role="status"
                    className="flex justify-center gap-2 p-3 text-sm text-muted-foreground"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    Yuklanmoqda…
                  </div>
                ) : catalog.isFetchNextPageError ? (
                  <div
                    role="alert"
                    className="space-y-2 p-3 text-sm text-destructive"
                  >
                    <p>{catalog.error?.message}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void catalog.fetchNextPage();
                      }}
                    >
                      Qayta urinish
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CommandList>
          <div className="flex items-center justify-between border-t p-2 text-xs text-muted-foreground">
            <span>{items.length} ta natija</span>
            {catalog.hasNextPage && (
              <span>Davomini ko‘rish uchun pastga scroll qiling</span>
            )}
          </div>
        </Command>
      </CommandDialog>
    </>
  );
}

function demoCatalog(
  kind: "customers" | "items" | "materials",
  q: string,
  offset: number,
  limit: number,
  products: boolean,
  customerRef: string,
): Page {
  if (kind === "customers" || (kind === "items" && !products))
    return getDemoPage(kind, { q, offset, limit });
  const customer = customerRef
    ? getDemoPage("customers", { limit: 500 }).items.find(
        (row) => row.ref === customerRef,
      )
    : null;
  let items =
    kind === "items" && customer
      ? Array.isArray(customer.assigned_items)
        ? customer.assigned_items.filter(isRecord)
        : []
      : getDemoPage(kind, { limit: 500 }).items;
  items = items.filter((row) =>
    kind === "materials"
      ? row.active !== false
      : String(row.item_group).trim().toLowerCase() === "tayyor mahsulot",
  );
  const needle = q.toLowerCase();
  if (needle)
    items = items.filter((row) =>
      [row.name, row.code].some((value) =>
        text(value, "").toLowerCase().includes(needle),
      ),
    );
  return {
    items: items.slice(offset, offset + limit),
    hasMore: offset + limit < items.length,
  };
}
