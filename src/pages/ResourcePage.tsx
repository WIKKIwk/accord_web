import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpDown,
  Check,
  ChevronRight,
  ClipboardList,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/lib/session";
import { resourceListOptions } from "@/lib/resource-list";
import { getDemoPage } from "@/lib/demo";
import { isRecord, resourceDefinitions, text, valueAt } from "@/lib/api";
import type { ApiClient } from "@/lib/api";
import { MutationScope } from "@/lib/mutation-scope";
import { canManageResource, canViewPage, hasCapability, resourceCanCreate } from "@/lib/permissions";
import { CatalogAdminControls } from "@/components/catalog-admin-controls";
import { CatalogPicker } from "@/components/catalog-picker";
import { AdminIdentityControls, AdminRoleCreateButton } from "@/components/admin-identity-controls";
import { MaterialCatalogControls, MaterialCatalogToolbar } from "@/components/material-catalog-controls";
import { RawMaterialControls, OrderRawMaterialControls } from "@/components/raw-material-controls";
import { ProductionOrderControls } from "@/components/production-order-controls";
import { OrderWipAdminControls, WipAdminControls, WipAdminToolbar } from "@/components/wip-admin-controls";
import { ApparatusPlanningControls, OrderSchedulingControls } from "@/components/apparatus-planning-controls";
import { WorkerProfileControls } from "@/components/worker-profile-controls";
import { InventoryAdminControls, InventoryAdminToolbar } from "@/components/inventory-admin-controls";
import { ResourceCreateNotice, useResourceCreate } from "@/components/resource-create-controls";
import { ApparatusAdminControls, ApparatusAdminToolbar } from "@/components/apparatus-admin-controls";
import { RawMaterialRuleToolbar } from "@/components/raw-material-rule-controls";
import { resourceCreateItemCodePolicy } from "@/lib/resource-create";
import type { CatalogKind } from "@/lib/catalog-admin";
import type { MutationLease } from "@/lib/mutation-scope";
import type { ResourceKind, Row } from "@/lib/api-types";
import type { NavigationPage } from "@/lib/navigation";
import { cellLabel, completionDecisionRequired, display, numberLabel, statusFilterLabel, views } from "@/lib/presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { InfiniteListEnd } from "@/components/infinite-list-end";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ResourcePage({ page }: { page: NavigationPage }) {
  const kind = page.resource!;
  const { client, demo, scope, session } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [status, setStatus] = useState(kind === "wip" && ['waiting', 'in_use', 'processed', 'all'].includes(params.get('status') ?? '') ? params.get('status')! : kind === "wip" ? "waiting" : "all"),
    [sort, setSort] = useState<{ key: string; descending: boolean } | null>(
      null,
    );
  const [hidden, setHidden] = useState<string[]>([]),
    [createOpen, setCreateOpen] = useState(false);
  const warehouse = params.get("warehouse") || "";
  const userRoles = ['supplier', 'customer', 'material_taminotchi', 'worker', 'qolipchi', 'boyoqchi', 'tayyorlov_masteri', 'homashyo_rezkachi'];
  const role = kind === 'users' && userRoles.includes(params.get('role') ?? '') ? params.get('role')! : '';
  const inactive = kind === 'suppliers' && params.get('inactive') === 'true';
  const view = views[kind],
    def = resourceDefinitions[kind];
  useEffect(() => {
    if (kind === 'wip') setStatus(['waiting', 'in_use', 'processed', 'all'].includes(params.get('status') ?? '') ? params.get('status')! : 'waiting');
  }, [kind, params]);
  const warehouses = useQuery({
    queryKey: ["warehouses-picker", scope],
    queryFn: ({ signal }) =>
      demo
        ? getDemoPage("warehouses", { limit: 500 })
        : client!.list("warehouses", { limit: 500 }, signal),
    enabled: kind === "stock" && (demo || Boolean(client)),
  });
  const listAllowed = kind !== 'locations' || demo || hasCapability(session, 'inventory.movement.manage');
  const data = useInfiniteQuery(
    resourceListOptions({
      queryClient,
      client,
      demo,
      scope,
      kind,
      enabled: listAllowed,
      query: { q, warehouse, ...(kind === "wip" ? { status } : {}), ...(role ? { role } : {}), ...(inactive ? { inactive: true } : {}) },
    }),
  );
  const items = data.data?.pages.flatMap((page) => page.items) || [];
  const bounded = data.data?.pages.some((page) => page.bounded);
  function refreshList() {
    void queryClient.invalidateQueries({ queryKey: ["resource", scope, kind] });
  }
  const selectedId = params.get("selected");
  const selected =
    items.find((row) => identity(kind, row) === selectedId) ||
    (selectedId && (kind === "orders" || kind === "maps")
      ? demo
        ? getDemoPage(kind, { limit: 500 }).items.find(
            (row) => identity(kind, row) === selectedId,
          ) || null
        : { id: selectedId }
      : null);
  const columns = view.columns.filter((column) => !hidden.includes(column.key));
  const statusColumn = view.columns.find((column) => column.status);
  const states = kind === "wip" ? ["waiting", "in_use", "processed"] : statusColumn
    ? [
        ...new Set(
          items
            .map((row) => text(valueAt(row, statusColumn.key), ""))
            .filter(Boolean),
        ),
      ]
    : [];
  const filterStates = status === "all" || states.includes(status) ? states : [...states, status];
  let shown = items.filter(
    (row) =>
      status === "all" ||
      (statusColumn && String(valueAt(row, statusColumn.key)) === status),
  );
  if (sort)
    shown = [...shown].sort((a, b) => {
      const x = valueAt(a, sort.key),
        y = valueAt(b, sort.key);
      const compared =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : display(x).localeCompare(display(y), "uz");
      return sort.descending ? -compared : compared;
    });
  function pick(row: Row | null) {
    const next = new URLSearchParams(params);
    row ? next.set("selected", identity(kind, row)) : next.delete("selected");
    setParams(next);
  }
  function exportRows() {
    const csvCell = (value: unknown) =>
      `"${display(value)
        .replace(/^[=+@-]/, "'")
        .replaceAll('"', '""')}"`;
    const csv = [
      columns.map((c) => csvCell(c.label)).join(","),
      ...shown.map((row) =>
        columns.map((c) => csvCell(cellLabel(c, row))).join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${page.id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {page.title}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {page.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={exportRows}
            disabled={!shown.length}
          >
            <ArrowDownToLine />
            Eksport
          </Button>
          {kind === 'roles' && <AdminRoleCreateButton onSaved={refreshList} />}
          {kind === 'materials' && <MaterialCatalogToolbar onSaved={refreshList} />}
          {kind === 'opening-wip' && <WipAdminToolbar onSaved={refreshList} />}
          {kind === 'apparatus' && <ApparatusAdminToolbar onSaved={refreshList} />}
          {kind === 'raw-materials' && <RawMaterialRuleToolbar onSaved={refreshList} />}
          {(kind === 'assets' || kind === 'locations') && <InventoryAdminToolbar kind={kind} onSaved={refreshList} />}
          {(kind === "orders" || kind === "templates") && canViewPage(session, 'calculate') ? (
            <Button asChild>
              <Link to="/app/calculate">
                <Plus />
                Buyurtma ochish
              </Link>
            </Button>
          ) : (
            view.fields && resourceCanCreate(session, kind) && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                Yangi {view.singular.toLocaleLowerCase("uz")}
              </Button>
            )
          )}
        </div>
      </div>
      {kind === "stock" && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-6">
            <Label htmlFor="warehouse-select">Ombor</Label>
            <Select
              value={warehouse}
              onValueChange={(value) => {
                const next = new URLSearchParams();
                next.set("warehouse", value);
                setParams(next);
              }}
            >
              <SelectTrigger id="warehouse-select" className="w-full sm:w-80">
                <SelectValue placeholder="Omborni tanlang" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.data?.items
                  .filter((row) => !row.is_group)
                  .map((row) => (
                    <SelectItem
                      key={text(row.warehouse)}
                      value={text(row.warehouse)}
                    >
                      {text(row.warehouse)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {warehouses.error && (
              <p className="text-sm text-destructive">
                {warehouses.error.message}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {!listAllowed ? <Alert><AlertDescription>Inventar joylari ro‘yxatini ko‘rish uchun ruxsat berilmagan. Zavod joylarini yuqoridagi boshqarish tugmasi orqali oching.</AlertDescription></Alert> : <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Ro‘yxat</TabsTrigger>
          <TabsTrigger value="overview">Umumiy ko‘rinish</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {kind === 'suppliers' && <Select value={inactive ? 'inactive' : 'active'} onValueChange={value => { const next = new URLSearchParams(params); if (value === 'inactive') next.set('inactive', 'true'); else next.delete('inactive'); next.delete('selected'); setParams(next); }}><SelectTrigger className="w-48" aria-label="Ta’minotchi ro‘yxati"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Faol ta’minotchilar</SelectItem><SelectItem value="inactive">O‘chirilgan ta’minotchilar</SelectItem></SelectContent></Select>}
              {kind === 'users' && <Select value={role || 'all'} onValueChange={value => { const next = new URLSearchParams(params); value === 'all' ? next.delete('role') : next.set('role', value); next.delete('selected'); setParams(next); }}><SelectTrigger className="w-48" aria-label="Foydalanuvchi vazifasi"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Barcha vazifalar</SelectItem>{userRoles.map(role => <SelectItem key={role} value={role}>{role === 'worker' ? 'Apparatchi / ishchi' : display(role)}</SelectItem>)}</SelectContent></Select>}
              {def.search !== "none" && (
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Ro‘yxatdan qidirish…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Ro‘yxatdan qidirish"
                  />
                </div>
              )}
              {(filterStates.length > 1 || status !== "all") && (
                <Select value={status} onValueChange={value => {
                  setStatus(value);
                  if (kind === 'wip') { const next = new URLSearchParams(params); next.set('status', value); next.delete('selected'); setParams(next); }
                }}>
                  <SelectTrigger
                    className="w-44"
                    aria-label="Holat bo‘yicha filtr"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Barcha holatlar</SelectItem>
                    {filterStates.map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusFilterLabel(statusColumn!, s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={refreshList}
                disabled={data.isFetching || (kind === "stock" && !warehouse)}
                aria-label="Ro‘yxatni yangilash"
              >
                <RefreshCw className={data.isFetching ? "animate-spin" : ""} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    Ustunlar
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Ko‘rinadigan ustunlar</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {view.columns.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={!hidden.includes(c.key)}
                      disabled={columns.length === 1 && !hidden.includes(c.key)}
                      onCheckedChange={(checked) =>
                        setHidden((old) =>
                          checked
                            ? old.filter((v) => v !== c.key)
                            : [...old, c.key],
                        )
                      }
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {data.error && !data.isFetchNextPageError && (
            <Alert variant="destructive">
              <AlertDescription>
                {data.error.message}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={refreshList}
                >
                  Qayta urinish
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((c) => (
                    <TableHead
                      key={c.key}
                      className={c.numeric ? "text-right" : ""}
                    >
                      <button
                        className={`inline-flex items-center gap-2 whitespace-nowrap py-2 font-medium ${c.numeric ? "w-full justify-end" : ""}`}
                        onClick={() =>
                          setSort((old) => ({
                            key: c.key,
                            descending:
                              old?.key === c.key ? !old.descending : false,
                          }))
                        }
                      >
                        {c.label}
                        <ArrowUpDown className="size-3 text-muted-foreground" />
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="w-12">
                    <span className="sr-only">Tafsilot</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.isPending && (kind !== "stock" || warehouse) ? (
                  Array.from({ length: 6 }, (_, i) => (
                    <TableRow key={i}>
                      {columns.map((c) => (
                        <TableCell key={c.key}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                      <TableCell />
                    </TableRow>
                  ))
                ) : shown.length ? (
                  shown.map((row, index) => (
                    <TableRow
                      key={`${identity(kind, row)}-${index}`}
                      className="cursor-pointer"
                      onClick={() => pick(row)}
                    >
                      {columns.map((c, i) => (
                        <TableCell
                          key={c.key}
                          className={`${c.numeric ? "text-right tabular-nums" : ""} ${i === 0 ? "font-medium" : "text-muted-foreground"}`}
                        >
                          {c.status ? (
                            <Badge variant="outline">{cellLabel(c, row)}</Badge>
                          ) : (
                            cellLabel(c, row)
                          )}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${view.singular} tafsiloti`}
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(row);
                          }}
                        >
                          <ChevronRight />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + 1}
                      className="h-52 text-center"
                    >
                      <ClipboardList className="mx-auto mb-3 size-8 text-muted-foreground" />
                      <p className="font-medium">
                        {kind === "stock" && !warehouse
                          ? "Omborni tanlang"
                          : search
                            ? "Natija topilmadi"
                            : data.error
                              ? "Ma’lumot yuklanmadi"
                              : "Ro‘yxat bo‘sh"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {kind === "stock" && !warehouse
                          ? "Mahsulot qoldiqlarini ko‘rish uchun omborni tanlang."
                          : search
                            ? "Boshqa so‘z bilan qidirib ko‘ring."
                            : "Serverdan kelgan yozuvlar shu yerda ko‘rinadi."}
                      </p>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <InfiniteListEnd
            active={kind !== "stock" || !!warehouse}
            hasMore={Boolean(data.hasNextPage)}
            isFetching={data.isFetching}
            error={data.isFetchNextPageError ? data.error : null}
            loadMore={() => data.fetchNextPage({ cancelRefetch: false })}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {shown.length} ta ko‘rsatilgan · {items.length} ta yuklangan
              {bounded && " · Server limiti doirasida"}
              {status !== "all" && kind !== "wip" && " · Yuklangan yozuvlar filtri"}
              {kind === "wip" && status !== "all" && ` · ${display(status)}`}
            </span>
          </div>
        </TabsContent>
        <TabsContent
          value="overview"
          className="grid gap-4 pt-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Card>
            <CardContent className="space-y-2 pt-6">
              <p className="text-sm text-muted-foreground">
                Yuklangan yozuvlar
              </p>
              <p className="text-3xl font-semibold tabular-nums">
                {data.data ? items.length : "—"}
              </p>
              <p className="text-xs text-muted-foreground">{page.title}</p>
            </CardContent>
          </Card>
          {states.map((s) => (
            <Card key={s}>
              <CardContent className="space-y-2 pt-6">
                <p className="text-sm text-muted-foreground">{statusFilterLabel(statusColumn!, s)}</p>
                <p className="text-3xl font-semibold tabular-nums">
                  {
                    items.filter(
                      (row) => String(valueAt(row, statusColumn!.key)) === s,
                    ).length
                  }
                </p>
                <p className="text-xs text-muted-foreground">
                  Yuklangan yozuvlar bo‘yicha
                </p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>}
      <CreateDialog
        kind={kind}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={() => {
          void queryClient.invalidateQueries({
            queryKey: ["resource", scope, kind],
          });
          void queryClient.invalidateQueries({
            queryKey: ["warehouses-picker", scope],
          });
        }}
      />
      <DetailSheet
        key={`${scope}:${kind}:${selectedId ?? ''}`}
        kind={kind}
        row={selected}
        warehouse={warehouse}
        onClose={() => pick(null)}
      />
    </>
  );
}

function identity(kind: ResourceKind, row: Row) {
  if (kind === "stock") return JSON.stringify([row.warehouse || "", row.code, row.order_id || "", row.uom || ""]);
  if (kind === "assets") return JSON.stringify([row.kind, row.asset_ref]);
  if (kind === "completed")
    return JSON.stringify([row.order_id, row.apparatus]);
  return text(
    row[resourceDefinitions[kind].identity] ??
      row.id ??
      row.code ??
      row.batch_id ??
      row.ref,
    "",
  );
}
interface ScopedRequest {
  scope: string;
  client: ApiClient | null;
  demo: boolean;
  lease: MutationLease;
}

function CreateDialog({
  kind,
  open,
  onOpenChange,
  onSaved,
}: {
  kind: ResourceKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { client, demo, scope, session } = useSession();
  const view = views[kind],
    fields = view.fields || [];
  const initialValues = useMemo(() => Object.fromEntries((views[kind].fields ?? []).map(field => [field.key, field.type === 'checkbox' ? false : field.initial || ''])), [kind]);
  const [validation, setValidation] = useState('');
  const creation = useResourceCreate(kind, initialValues, receipt => {
    toast.success(receipt.disposition === 'existing' ? 'Mavjud yozuv tanlandi.' : `${view.singular} ${receipt.disposition === 'saved' ? 'saqlandi' : 'yaratildi'}.`);
    setValidation('');
    onSaved();
    onOpenChange(false);
  });
  const { values, setValues } = creation;
  useEffect(() => setValidation(''), [kind, scope]);
  const groups = useQuery({ queryKey: ['catalog-admin-groups', scope], queryFn: ({ signal }) => demo ? getDemoPage('item-groups', { limit: 500 }) : client!.listSnapshot('item-groups', {}, signal), enabled: open && ['items', 'item-groups'].includes(kind) && canViewPage(session, 'item-groups') });
  const warehouseChoices = useQuery({ queryKey: ['warehouses-picker', scope], queryFn: ({ signal }) => demo ? getDemoPage('warehouses', { limit: 500 }) : client!.list('warehouses', { limit: 500 }, signal), enabled: open && kind === 'warehouses' });
  const uoms = useQuery({ queryKey: ['item-uoms', scope], queryFn: async ({ signal }) => { if (demo) return ['kg', 'dona', 'metr']; const result = await client!.get<unknown>('/v1/mobile/admin/items/uoms', undefined, signal); if (!Array.isArray(result) || result.some(value => typeof value !== 'string')) throw new Error('O‘lchov birliklari olinmadi.'); return result as string[] }, enabled: open && kind === 'items' });
  let generatedCode = false, policyError = '';
  try { generatedCode = kind === 'items' && resourceCreateItemCodePolicy(text(values.item_group, ''), groups.data?.items) === 'generated'; }
  catch (error) { policyError = error instanceof Error ? error.message : 'Material guruhlari to‘liq yuklanmagan. Qayta yuklang.'; }
  const fieldRequired = (field: typeof fields[number]) => kind === 'items' && field.key === 'code' ? !generatedCode : kind === 'items' && field.key === 'customer_ref' ? generatedCode : !!field.required;
  const dependenciesBlocked = ['items', 'item-groups'].includes(kind) && canViewPage(session, 'item-groups') && (groups.isPending || !!groups.error) || kind === 'items' && (uoms.isPending || !!uoms.error) || kind === 'warehouses' && (warehouseChoices.isPending || !!warehouseChoices.error);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (creation.blocked || dependenciesBlocked || policyError) return;
    if (fields.some(field => fieldRequired(field) && !text(values[field.key], '').trim())) { setValidation(generatedCode && !text(values.customer_ref, '').trim() ? 'Tayyor mahsulot uchun mijozni tanlang.' : 'Majburiy maydonlarni to‘ldiring.'); return; }
    setValidation('');
    const body = Object.fromEntries(
      fields.map(field => [field.key, kind === 'items' && field.key === 'code' && generatedCode ? '' : typeof values[field.key] === 'string' ? String(values[field.key]).trim() : values[field.key]]),
    );
    void creation.submit(body, { groups: groups.data?.items });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!creation.pending) onOpenChange(value);
      }}
    >
      <DialogContent onEscapeKeyDown={event => { if (creation.pending) event.preventDefault() }} onInteractOutside={event => { if (creation.pending) event.preventDefault() }} showCloseButton={!creation.pending}>
        <DialogHeader>
          <DialogTitle>
            Yangi {view.singular.toLocaleLowerCase("uz")}
          </DialogTitle>
          <DialogDescription>
            {demo
              ? "Bu namuna forma. Saqlash uchun real ERP serveriga kiring."
              : "Ma’lumot ERP serverida saqlanadi."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {fields.map((f) => (
            <div key={f.key} className="space-y-2">
              {f.type === "checkbox" ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`create-${f.key}`}
                    checked={values[f.key] === true}
                    disabled={creation.blocked}
                    onCheckedChange={(v) =>
                      setValues((old) => ({ ...old, [f.key]: v === true }))
                    }
                  />
                  <Label htmlFor={`create-${f.key}`}>{f.label}</Label>
                </div>
              ) : (
                <>
                  <Label htmlFor={`create-${f.key}`}>
                    {f.label}
                    {fieldRequired(f) && " *"}
                  </Label>
                  {kind === 'items' && f.key === 'customer_ref' ? <><CatalogPicker id="create-customer-ref" kind="customers" label="Mijoz" value={text(values.customer_ref, '')} selectedLabel={text(values.customer_name, '')} disabled={creation.blocked || !hasCapability(session, 'party.customer.read')} onSelect={customer => setValues(old => ({ ...old, customer_ref: customer.ref, customer_name: customer.name }))} />{generatedCode && <p className="text-xs text-muted-foreground">Tayyor mahsulot uchun mijoz tanlanishi shart.</p>}{!hasCapability(session, 'party.customer.read') && <p className="text-xs text-muted-foreground">Mijoz tanlash uchun ko‘rish ruxsati yetarli emas.</p>}</> :
                  ((['items', 'item-groups'].includes(kind) && ['item_group', 'parent'].includes(f.key)) || (kind === 'warehouses' && f.key === 'parent_warehouse')) ? <Select value={text(values[f.key], '') || '__none__'} disabled={creation.blocked || (kind !== 'warehouses' && (!canViewPage(session, 'item-groups') || !!policyError || groups.isPending || !!groups.error)) || (kind === 'warehouses' && (warehouseChoices.isPending || !!warehouseChoices.error))} onValueChange={value => setValues(old => ({ ...old, [f.key]: value === '__none__' ? '' : value }))}><SelectTrigger id={`create-${f.key}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none__">{f.key === 'item_group' ? 'Guruhni tanlang' : 'Asosiy daraja'}</SelectItem>{(kind === 'warehouses' ? warehouseChoices.data?.items.filter(row => row.is_group) : groups.data?.items.filter(row => f.key === 'item_group' ? !row.is_group : row.is_group))?.map(row => <SelectItem key={text(row.warehouse ?? row.name)} value={text(row.warehouse ?? row.name)}>{text(row.warehouse ?? row.item_group_name ?? row.name)}</SelectItem>)}</SelectContent></Select> : kind === 'items' && f.key === 'uom' ? <Select value={text(values.uom, '')} disabled={creation.blocked || uoms.isPending || !!uoms.error} onValueChange={value => setValues(old => ({ ...old, uom: value }))}><SelectTrigger id="create-uom"><SelectValue /></SelectTrigger><SelectContent>{[...new Set([text(values.uom, 'kg'), ...(uoms.data ?? [])])].filter(Boolean).map(uom => <SelectItem key={uom} value={uom}>{uom}</SelectItem>)}</SelectContent></Select> : f.type === "select" ? (
                    <Select
                      value={text(values[f.key], "")}
                      disabled={creation.blocked}
                      onValueChange={(v) =>
                        setValues((old) => ({ ...old, [f.key]: v }))
                      }
                    >
                      <SelectTrigger id={`create-${f.key}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {f.options?.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`create-${f.key}`}
                      type={f.type || "text"}
                      value={kind === 'items' && f.key === 'code' && generatedCode ? '' : text(values[f.key], "")}
                      placeholder={kind === 'items' && f.key === 'code' && generatedCode ? 'Server yaratadi' : undefined}
                      required={fieldRequired(f)}
                      disabled={creation.blocked || kind === 'items' && f.key === 'code' && generatedCode}
                      onChange={(e) =>
                        setValues((old) => ({
                          ...old,
                          [f.key]: e.target.value,
                        }))
                      }
                    />
                  )}
                </>
              )}
            </div>
          ))}
          {(validation || policyError || groups.error || warehouseChoices.error || uoms.error) && (
            <Alert variant="destructive">
              <AlertDescription>{validation || policyError || groups.error?.message || warehouseChoices.error?.message || uoms.error?.message}{(policyError || groups.error || warehouseChoices.error || uoms.error) && <Button type="button" variant="outline" onClick={() => { if (policyError || groups.error) void groups.refetch(); if (warehouseChoices.error) void warehouseChoices.refetch(); if (uoms.error) void uoms.refetch() }}>Qayta urinish</Button>}</AlertDescription>
            </Alert>
          )}
          <ResourceCreateNotice state={creation} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creation.pending}
              onClick={() => onOpenChange(false)}
            >
              Bekor qilish
            </Button>
            <Button type="submit" disabled={creation.blocked || dependenciesBlocked || !!policyError}>
              {creation.pending && <Loader2 className="animate-spin" />}
              Saqlash
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailSheet({
  kind,
  row,
  warehouse,
  onClose,
}: {
  kind: ResourceKind;
  row: Row | null;
  warehouse: string;
  onClose: () => void;
}) {
  const { client, demo, scope, session } = useSession();
  const queryClient = useQueryClient();
  const [mutations] = useState(() => new MutationScope());
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => () => mutations.cancelAll(), [scope, mutations]);
  const [tab, setTab] = useState("details");
  const sheetRef = useRef<HTMLDivElement>(null);
  const detail = useQuery({
    queryKey: ["detail", scope, kind, row && identity(kind, row)],
    queryFn: ({ signal }) => (demo || (kind === 'warehouses' && !canViewPage(session, 'stock')) ? row! : client!.detail(kind, row!, signal)),
    enabled: !!row && Boolean(demo || client),
  });
  const value = ['orders', 'maps', 'pending', 'apparatus', 'warehouses', 'items', 'workers', 'suppliers', 'customers', 'users'].includes(kind) ? { ...row, ...detail.data } : { ...row };
  function refreshMaterialDetail() { void queryClient.invalidateQueries({ queryKey: ['resource', scope, kind] }); void detail.refetch(); }
  const map = isRecord(value.map) ? value.map : value;
  const nodes = Array.isArray(map.nodes) ? map.nodes.filter(isRecord) : [];
  const capabilities = Array.isArray(value.capability_codes)
    ? value.capability_codes
    : Array.isArray(value.capabilities)
      ? value.capabilities
      : [];
  const rolls = useInfiniteQuery({
    queryKey: ["stock-rolls", scope, warehouse, row?.code, row?.order_id],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam: offset }) =>
      demo
        ? { items: [], hasMore: false }
        : client!.stockRolls(
            {
              warehouse,
              item_code: text(row?.code, ""),
              order_id: text(row?.order_id, ""),
              offset,
              limit: 50,
            },
            signal,
          ),
    enabled: kind === "stock" && !!row && tab === "rolls",
    getNextPageParam: (page, _pages, offset) =>
      page.hasMore ? offset + 50 : undefined,
  });
  const rollItems = rolls.data?.pages.flatMap((page) => page.items) || [];
  const decision = useMutation({
    mutationFn: async ({ action, selected, request }: {
      action: "approve" | "reject";
      selected: Row | null;
      request: ScopedRequest;
    }) => {
      if (request.demo || !request.client || !selected)
        throw new Error("Ko‘rish rejimida amal bajarilmaydi.");
      if (!completionDecisionRequired(selected))
        throw new Error("Bu bildirishnoma uchun qaror talab qilinmaydi.");
      return request.client.decideCompletion(text(selected.event_id, ""), action, request.lease.controller.signal);
    },
    onSuccess: (_data, { request }) => {
      if (request.scope !== currentScope.current || !mutations.isCurrent(request.lease)) return;
      toast.success("Qaror saqlandi.");
      void queryClient.invalidateQueries();
      onClose();
    },
    onSettled: (_data, _error, { request }) => mutations.finish(request.lease),
  });
  function decide(action: "approve" | "reject") {
    if (decision.isPending || !canManageResource(session, 'completion')) return;
    decision.mutate({ action, selected: row, request: { scope, client, demo, lease: mutations.begin() } });
  }
  return (
    <Sheet
      open={!!row}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setTab("details");
          decision.reset();
        }
      }}
    >
      <SheetContent ref={sheetRef} className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {display(
              value.name ??
                map.title ??
                value.order_title ??
                value.order_number ??
                value.label_item_name ??
                value.item_name ??
                value.warehouse ??
                valueAt(value, "display.display_name") ??
                value.label ??
                (row ? identity(kind, row) : undefined),
            )}
          </SheetTitle>
          <SheetDescription>{views[kind].singular} tafsiloti</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {detail.error && (
            <Alert variant="destructive">
              <AlertDescription>{detail.error.message}</AlertDescription>
            </Alert>
          )}
          {detail.isPending && <Skeleton className="h-20 w-full" />}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="details">Umumiy</TabsTrigger>
              {nodes.length > 0 && (
                <TabsTrigger value="stages">Xarita tugunlari</TabsTrigger>
              )}
              {kind === "stock" && (
                <TabsTrigger value="rolls">Rulonlar</TabsTrigger>
              )}
              {capabilities.length > 0 && (
                <TabsTrigger value="rights">Ruxsatlar</TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="details" className="space-y-5 pt-3">
              <dl className="divide-y">
                {views[kind].columns.map((c) => (
                  <div
                    key={c.key}
                    className="flex items-start justify-between gap-4 py-3 text-sm"
                  >
                    <dt className="text-muted-foreground">{c.label}</dt>
                    <dd className="max-w-[65%] break-words text-right font-medium">
                      {cellLabel(c, value)}
                    </dd>
                  </div>
                ))}
                {[
                  ["note", "Izoh"],
                  ["width_mm", "Kenglik, mm"],
                  ["roll_count", "Val soni"],
                  ["product_count", "Mahsulotlar"],
                  ["reserved_count", "Band mahsulotlar"],
                  ["assignment_count", "Mas’ullar"],
                ]
                  .filter(([key]) => value[key] != null)
                  .map(([key, label]) => (
                    <div
                      key={key}
                      className="flex justify-between gap-4 py-3 text-sm"
                    >
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right font-medium">
                        {display(value[key])}
                      </dd>
                    </div>
                  ))}
              </dl>
              {kind === "warehouses" && !value.is_group && canViewPage(session, 'stock') && (
                <Button asChild className="w-full">
                  <Link
                    to={`/app/stock?warehouse=${encodeURIComponent(text(value.warehouse, ""))}`}
                    onClick={onClose}
                  >
                    Mahsulot qoldiqlarini ochish
                    <ChevronRight />
                  </Link>
                </Button>
              )}
              {(kind === 'orders' || kind === 'maps') && canViewPage(session, 'map-editor') && !detail.isPending && !detail.error && <Button asChild className="w-full"><Link to={`/app/map-editor?mapId=${encodeURIComponent(text(map.id, ''))}`} onClick={onClose}>Ish xaritasini tahrirlash<ChevronRight /></Link></Button>}
              {row && !detail.isPending && !detail.error && canViewPage(session, 'calculate') && kind === 'orders' && text(map.id, '') && <Button variant="outline" asChild className="w-full"><Link to={`/app/calculate?orderId=${encodeURIComponent(text(map.id, ''))}`} onClick={onClose}>Buyurtma hisobini tahrirlash<ChevronRight /></Link></Button>}
              {row && !detail.isPending && !detail.error && canViewPage(session, 'calculate') && kind === 'templates' && text(value.id, '') && <div className="grid gap-2"><Button asChild><Link to={`/app/calculate?templateId=${encodeURIComponent(text(value.id, ''))}`} onClick={onClose}>Shablondan yangi buyurtma<ChevronRight /></Link></Button><Button variant="outline" asChild><Link to={`/app/calculate?templateId=${encodeURIComponent(text(value.id, ''))}&edit=1`} onClick={onClose}>Shablonni tahrirlash<ChevronRight /></Link></Button></div>}
              {row && !detail.isPending && !detail.error && canViewPage(session, 'calculate') && kind === 'pending' && text(value.id, '') && <Button asChild className="w-full"><Link to={`/app/calculate?pendingId=${encodeURIComponent(text(value.id, ''))}`} onClick={onClose}>Buyurtmani ishlab chiqarishga ochish<ChevronRight /></Link></Button>}
              {row && !detail.isPending && !detail.error && (['items', 'item-groups', 'customers', 'suppliers', 'warehouses'].includes(kind) || (kind === 'users' && ['supplier', 'customer'].includes(text(value.principal_role, '')))) && <CatalogAdminControls key={`${scope}:${kind}:${identity(kind, row)}`} kind={(kind === 'users' ? value.principal_role === 'supplier' ? 'suppliers' : 'customers' : kind) as CatalogKind} row={value} onSaved={() => { void detail.refetch() }} onRemoved={onClose} />}
              {row && !detail.isPending && !detail.error && ['users', 'workers', 'roles'].includes(kind) && <AdminIdentityControls key={`identity:${scope}:${kind}:${identity(kind, row)}`} kind={kind} row={kind === 'roles' ? row : value} onSaved={() => { void detail.refetch() }} onRemoved={onClose} />}
              {row && !detail.isPending && !detail.error && (kind === 'workers' || kind === 'users' && value.principal_role === 'aparatchi') && <WorkerProfileControls row={value} onSaved={() => { void detail.refetch() }} />}
              {row && !detail.isPending && !detail.error && kind === 'materials' && <MaterialCatalogControls row={row} onSaved={refreshMaterialDetail} onRemoved={onClose} />}
              {row && !detail.isPending && !detail.error && kind === 'raw-materials' && <RawMaterialControls row={value} onSaved={() => void detail.refetch()} />}
              {row && !detail.isPending && !detail.error && kind === 'orders' && <OrderRawMaterialControls row={value} onSaved={() => void detail.refetch()} />}
              {row && !detail.isPending && !detail.error && (kind === 'orders' || kind === 'maps') && <ProductionOrderControls row={value} />}
              {row && !detail.isPending && !detail.error && (kind === 'wip' || kind === 'opening-wip') && <WipAdminControls kind={kind} row={value} onSaved={refreshMaterialDetail} />}
              {row && !detail.isPending && !detail.error && kind === 'orders' && <OrderWipAdminControls row={value} onSaved={refreshMaterialDetail} />}
              {row && !detail.isPending && !detail.error && kind === 'apparatus' && <ApparatusPlanningControls row={value} onSaved={refreshMaterialDetail} />}
              {row && !detail.isPending && !detail.error && kind === 'apparatus' && <ApparatusAdminControls row={value} onSaved={refreshMaterialDetail} onRetired={onClose} />}
              {row && !detail.isPending && !detail.error && kind === 'orders' && <OrderSchedulingControls row={value} onSaved={refreshMaterialDetail} />}
              {row && !detail.isPending && !detail.error && (kind === 'assets' || kind === 'locations') && <InventoryAdminControls kind={kind} row={value} onSaved={refreshMaterialDetail} />}
              {row && !detail.isPending && !detail.error && (kind === 'orders' || kind === 'closed') && canViewPage(session, 'production-time') && <Button variant="outline" asChild className="w-full"><Link to={`/app/production-time?orderId=${encodeURIComponent(text(kind === 'closed' ? value.order_id : map.id, ''))}`} onClick={onClose}>Bosqichlar vaqtini ko‘rish<ChevronRight /></Link></Button>}
              {kind === "completion" && completionDecisionRequired(value) && canManageResource(session, 'completion') && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Hisobotni ko‘rib chiqib, qaroringizni tasdiqlang.
                  </p>
                  {decision.error && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {decision.error.message}
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex gap-2">
                    <Button
                      disabled={demo || decision.isPending || detail.isPending || detail.isError}
                      onClick={() => decide("approve")}
                    >
                      <Check />
                      Tasdiqlash
                    </Button>
                    <Button
                      variant="outline"
                      disabled={demo || decision.isPending || detail.isPending || detail.isError}
                      onClick={() => decide("reject")}
                    >
                      <X />
                      Rad etish
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="stages" className="space-y-3 pt-3">
              {nodes.map((node, index) => (
                <div
                  className="flex items-start gap-3 rounded-lg border p-4"
                  key={text(node.id, String(index))}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {index + 1}
                  </span>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      {display(node.title ?? node.kind)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {display(node.apparatus_id)}
                      {node.role_code ? ` · ${display(node.role_code)}` : ""}
                    </p>
                  </div>
                </div>
              ))}
            </TabsContent>
            <TabsContent value="rights" className="pt-3">
              <div className="flex flex-wrap gap-2">
                {capabilities.map((cap) => (
                  <Badge variant="secondary" key={String(cap)}>
                    {String(cap)}
                  </Badge>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="rolls" className="pt-3">
              {rolls.error && !rolls.data ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {rolls.error.message}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void rolls.refetch();
                      }}
                    >
                      Qayta urinish
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : rolls.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Shtrixkod</TableHead>
                      <TableHead>Miqdor</TableHead>
                      <TableHead>Birlik</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rollItems.map((roll, i) => (
                      <TableRow key={text(roll.stock_id, String(i))}>
                        <TableCell>{display(roll.barcode)}</TableCell>
                        <TableCell>{numberLabel(roll.qty)}</TableCell>
                        <TableCell>{display(roll.uom)}</TableCell>
                      </TableRow>
                    ))}
                    {!rollItems.length && (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="py-8 text-center text-muted-foreground"
                        >
                          Rulonlar topilmadi.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
              <InfiniteListEnd
                active={kind === "stock" && !!row && tab === "rolls"}
                hasMore={Boolean(rolls.hasNextPage)}
                isFetching={rolls.isFetching}
                error={rolls.isFetchNextPageError ? rolls.error : null}
                loadMore={() => rolls.fetchNextPage({ cancelRefetch: false })}
                root={sheetRef}
              />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
