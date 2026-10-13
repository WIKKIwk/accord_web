import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Calculator,
  Check,
  ClipboardPlus,
  ImagePlus,
  Loader2,
  Plus,
  Trash2,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, isRecord, text } from "@/lib/api";
import type { ApiClient } from "@/lib/api";
import { MutationScope } from "@/lib/mutation-scope";
import type { MutationLease } from "@/lib/mutation-scope";
import type { Row } from "@/lib/api-types";
import { useSession } from "@/lib/session";
import { getDemoPage } from "@/lib/demo";
import {
  automaticOrderTemplate,
  calculationInput,
  customerSelection,
  newOrderLayer,
} from "@/lib/order-draft";
import type { OrderDraft } from "@/lib/order-draft";
import {
  CalculatorManagementActions,
  CalculatorManagementNotice,
  useCalculatorDraftState,
  useCalculatorManagement,
} from "@/components/calculator-management-controls";
import {
  CalculatorSaveUnknown,
  calculatorManagementError,
  calculatorMode,
  draftFromCalculatorTemplate,
  managedCalculationInput,
  managedCalculationSignature,
  managedCalculatorTemplate,
} from "@/lib/calculator-management";
import type { CalculatorMode, CalculatorSaveResult, CalculatorSource } from "@/lib/calculator-management";
import { createOrderMap, productionMapFromRow } from "@/lib/production-map";
import { CatalogPicker } from "@/components/catalog-picker";
import { numberLabel } from "@/lib/presentation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface ScopedRequest {
  scope: string;
  client: ApiClient | null;
  demo: boolean;
  lease: MutationLease;
}

export function CalculatorPage() {
  const { scope } = useSession();
  const [params] = useSearchParams();
  let mode: CalculatorMode;
  try { mode = calculatorMode(params); }
  catch (error) {
    return <Alert variant="destructive"><AlertDescription>{calculatorManagementError(error)} <Link className="underline" to="/app/calculate">Yangi buyurtma ochish</Link></AlertDescription></Alert>;
  }
  return <CalculatorContent key={`${scope}:${mode.kind}:${mode.kind === 'new' ? '' : `${mode.id}:${mode.kind === 'template' && mode.edit}`}`} mode={mode} />;
}

function CalculatorContent({ mode }: { mode: CalculatorMode }) {
  const { client, demo, scope } = useSession();
  const management = useCalculatorManagement(mode);
  const source = management.source ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    draft,
    setDraft,
    selectedMaterials,
    setSelectedMaterials,
    calculated,
    setCalculated,
    map,
    setMap,
    mapSignature,
    setMapSignature,
    localImage,
    setLocalImage,
    uncertain,
    setUncertain,
    retainedDraft,
    reset,
  } = useCalculatorDraftState(mode);
  const [confirm, setConfirm] = useState(false);
  const productGeneration = useRef(0);
  const customerRequest = useRef<AbortController | null>(null);
  const [mutations] = useState(() => new MutationScope());
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const hydrated = useRef<CalculatorSource | null>(null);
  const signature = managedCalculationSignature(draft, source);
  const result = calculated?.signature === signature ? calculated.result : null;

  useEffect(
    () => () => {
      productGeneration.current += 1;
      customerRequest.current?.abort();
      mutations.cancelAll();
    },
    [scope, mutations],
  );

  const calculation = useMutation({
    mutationFn: async ({
      current,
      request,
    }: {
      current: OrderDraft;
      request: ScopedRequest;
    }) => {
      if (!request.client || request.demo)
        throw new Error("Hisoblash uchun ERP serveriga kiring.");
      return request.client.calculate(
        source ? managedCalculationInput(current, source) : calculationInput(current),
        request.lease.controller.signal,
      );
    },
    onSuccess: (data, { current, request }) => {
      if (isCurrent(request))
        setCalculated({
          result: data,
          signature: managedCalculationSignature(current, source),
        });
    },
    onSettled: (_data, _error, { request }) => mutations.finish(request.lease),
  });
  const opening = useMutation({
    mutationFn: async ({
      current,
      result,
      request,
    }: {
      current: OrderDraft;
      result: Row | null;
      request: ScopedRequest;
    }) => {
      if (!request.client || request.demo || !result || !management.api)
        throw new Error("Avval buyurtmani hisoblang.");
      if (!isCurrent(request)) throw new DOMException('So‘rov bekor qilindi.', 'AbortError');
      const template = source?.kind === 'template' ? managedCalculatorTemplate(current, result, source) : automaticOrderTemplate(current, result);
      return management.api.automaticOpen(
        template,
        request.lease.controller.signal,
      );
    },
    onSuccess: (data, { request }) => {
      if (!isCurrent(request)) return;
      management.clearAutomatic();
      const saved = isRecord(data.saved) ? data.saved : {};
      const map = isRecord(saved.map) ? saved.map : {};
      toast.success(
        `Buyurtma №${text(map.order_number)} ishlab chiqarishga ochildi.`,
      );
      void queryClient.invalidateQueries();
      reset();
      navigate(`/app/orders?selected=${encodeURIComponent(text(map.id, ""))}`);
    },
    onError: (error, { request }) => {
      if (!isCurrent(request)) return;
      if (error instanceof ApiError && error.status > 0 && error.status < 500) management.clearAutomatic();
      setUncertain(
        error instanceof ApiError &&
          (error.status === 0 || error.status >= 500),
      );
    },
    onSettled: (_data, _error, { request }) => mutations.finish(request.lease),
  });
  const imageUpload = useMutation({
    mutationFn: async ({
      file,
      request,
    }: {
      file: File;
      request: ScopedRequest;
    }) => {
      if (!request.client || request.demo)
        throw new Error("Rasm yuklash uchun ERP serveriga kiring.");
      return request.client.uploadOrderImage(
        file,
        file.name,
        request.lease.controller.signal,
      );
    },
    onSuccess: (image, { request }) => {
      if (isCurrent(request)) setDraft((old) => ({ ...old, image }));
    },
    onSettled: (_data, _error, { request }) => mutations.finish(request.lease),
  });
  const busy =
    calculation.isPending || opening.isPending || imageUpload.isPending || management.pending;
  const imageMissing = Boolean(localImage && !draft.image?.image_id);
  const completedPending = source?.kind === 'pending' && !!source.pending.completion;
  const managementOpenUnknown = management.error instanceof CalculatorSaveUnknown;

  useEffect(() => {
    const changed = mode.kind !== 'new' && source && retainedDraft && JSON.stringify(draft) !== JSON.stringify(draftFromCalculatorTemplate(source.template, source.kind === 'order' || source.kind === 'pending'));
    if (!changed && !uncertain && !opening.isPending && !management.pending && !management.error) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draft, source, mode.kind, retainedDraft, uncertain, opening.isPending, management.pending, management.error]);

  useEffect(() => {
    if (!source || hydrated.current === source) return;
    hydrated.current = source;
    productGeneration.current += 1;
    customerRequest.current?.abort();
    mutations.cancelAll();
    if (retainedDraft) return;
    setDraft(draftFromCalculatorTemplate(source.template, source.kind === 'order' || source.kind === 'pending'));
    setSelectedMaterials({}); setCalculated(null); setMap(null); setMapSignature(''); setLocalImage(''); setUncertain(false);
    calculation.reset(); opening.reset(); imageUpload.reset(); setConfirm(false);
  }, [source, mutations, setDraft, setSelectedMaterials, setCalculated, setMap, setMapSignature, setLocalImage, setUncertain]);

  function scopedRequest(): ScopedRequest {
    return { scope, client, demo, lease: mutations.begin() };
  }
  function isCurrent(request: ScopedRequest) {
    return (
      request.scope === currentScope.current &&
      mutations.isCurrent(request.lease)
    );
  }

  function change<K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) {
    setDraft((old) => ({ ...old, [key]: value }));
    calculation.reset();
    if (!uncertain) opening.reset();
  }
  function changeLayer(
    key: string,
    value: Partial<OrderDraft["layers"][number]>,
  ) {
    setDraft((old) => ({
      ...old,
      layers: old.layers.map((layer) =>
        layer.key === key ? { ...layer, ...value } : layer,
      ),
    }));
    calculation.reset();
  }
  function selectCustomer(row: Row) {
    productGeneration.current += 1;
    customerRequest.current?.abort();
    setDraft((old) => source?.kind === 'order' ? { ...old, customer_ref: text(row.ref, ''), customer: text(row.name || row.ref, '') } : customerSelection(old, row));
    calculation.reset();
  }
  async function selectProduct(row: Row) {
    const generation = ++productGeneration.current;
    customerRequest.current?.abort();
    const code = text(row.code, "");
    setDraft((old) => ({
      ...old,
      item_code: code,
      product: text(row.name || row.code, ""),
    }));
    calculation.reset();
    if (draft.customer_ref || draft.customer) return;
    const controller = new AbortController();
    customerRequest.current = controller;
    try {
      const customer = demo
        ? getDemoPage("customers", { limit: 500 }).items.find(
            (customer) =>
              Array.isArray(customer.assigned_items) &&
              customer.assigned_items.some(
                (item) => isRecord(item) && item.code === code,
              ),
          ) || null
        : await client!.productCustomer(code, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== productGeneration.current ||
        !customer
      )
        return;
      setDraft((old) =>
        old.item_code === code && !old.customer_ref && !old.customer
          ? {
              ...old,
              customer_ref: text(customer.ref, ""),
              customer: text(customer.name || customer.ref, ""),
            }
          : old,
      );
    } catch {
      /* Mobile keeps the product selectable if optional customer lookup fails. */
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    calculation.mutate({
      current: structuredClone(draft),
      request: scopedRequest(),
    });
  }
  function pickImage(file: File | undefined) {
    if (!file) return;
    setLocalImage(URL.createObjectURL(file));
    setDraft((old) => ({ ...old, image: null }));
    imageUpload.mutate({ file, request: scopedRequest() });
  }

  function openMapEditor() {
    if (!result || imageUpload.error || imageMissing || (uncertain && (!map || mapSignature !== signature))) return;
    const template = automaticOrderTemplate(draft, result);
    const next =
      map && mapSignature === signature
        ? productionMapFromRow(map)
        : createOrderMap(template, result);
    setMap({
      ...next,
      title: template.name,
      product_code: template.item_code || template.product,
      customer_name: template.customer || "",
      image_id: template.image_id || "",
    });
    setMapSignature(signature);
    navigate("/app/map-editor");
  }
  const resultRows =
    result && Array.isArray(result.results)
      ? result.results.filter(isRecord)
      : [];

  function managementSaved(saved: CalculatorSaveResult) {
    if (saved.kind === 'template') {
      toast.success('Buyurtma shabloni saqlandi.');
      navigate(`/app/templates?selected=${encodeURIComponent(text(saved.template.id, ''))}`);
    } else if (saved.kind === 'deleted') {
      toast.success('Shablon o‘chirildi.'); navigate('/app/templates');
    } else {
      const map = saved.kind === 'order' ? saved.order.map : isRecord(saved.saved.map) ? saved.saved.map : {};
      toast.success(saved.kind === 'order' ? `Buyurtma №${text(map.order_number)} tahrirlandi.` : `Buyurtma №${text(map.order_number)} ishlab chiqarishga ochildi.`);
      navigate(`/app/orders?selected=${encodeURIComponent(text(map.id, ''))}`);
    }
  }
  if (mode.kind !== 'new' && (!source || hydrated.current !== source || demo || !management.allowed)) {
    const error = management.error || management.loadError || (demo ? new Error('Bu amal uchun ERP serveriga ulaning.') : !management.allowed ? new ApiError(403, 'forbidden') : null);
    return <div className="space-y-4"><h1 className="text-2xl font-semibold">Buyurtma ma’lumotlari</h1>{error ? <Alert variant="destructive"><AlertDescription>{calculatorManagementError(error)}</AlertDescription></Alert> : <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />Buyurtma yuklanmoqda…</p>}<div className="flex gap-2">{error && !demo && <Button variant="outline" disabled={management.pending} onClick={() => void management.reload()}>Qayta yuklash</Button>}<Button variant="outline" asChild><Link to={mode.kind === 'pending' ? '/app/pending' : mode.kind === 'order' ? '/app/orders' : '/app/templates'}>Ro‘yxatga qaytish</Link></Button></div></div>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode.kind === 'order' ? `Buyurtma №${text(source?.template.order_number)} tahriri` : mode.kind === 'pending' ? `Kutilayotgan buyurtma №${text(source?.template.order_number)}` : mode.kind === 'template' ? mode.edit ? 'Shablonni tahrirlash' : 'Shablondan buyurtma ochish' : 'Buyurtma ochish'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Mahsulot, ishlab chiqarish turi va hisob parametrlari.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/app/templates">Saqlangan buyurtmalar</Link>
        </Button>
      </div>
      {demo && (
        <Alert>
          <AlertDescription>
            Forma ko‘rish rejimida. Hisoblash, rasm yuklash va buyurtma ochish
            uchun ERP serveriga ulaning.{" "}
            <Button asChild variant="link" size="sm">
              <Link to="/app/map-editor">
                Map muharririni ko‘rish
                <Waypoints />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {source?.kind === 'order' && <Alert><AlertDescription>Mavjud xarita yo‘nalishi saqlanadi. Buyurtma turi, bosma usuli va bir qatlamli yoki ko‘p qatlamli tuzilishni avvalgidek qoldiring.</AlertDescription></Alert>}
      {completedPending && <Alert><AlertDescription>Bu buyurtma ishlab chiqarishga chiqarilgan.</AlertDescription></Alert>}
      {mode.kind === 'template' && mode.edit && <Button variant="outline" asChild><Link to={`/app/calculate?templateId=${encodeURIComponent(mode.id)}`}>Yangi buyurtmaga ishlatish</Link></Button>}
      <form
        onSubmit={submit}
        className="grid items-start gap-6 xl:grid-cols-[1fr_360px]"
      >
        <fieldset disabled={busy || completedPending} className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Buyurtma ma’lumotlari</CardTitle>
              <CardDescription>
                Mijoz va ishlab chiqariladigan tayyor mahsulot.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="order-customer">Mijoz</Label>
                <CatalogPicker
                  id="order-customer"
                  kind="customers"
                  label="Mijozni"
                  value={draft.customer_ref}
                  selectedLabel={draft.customer}
                  onSelect={selectCustomer}
                />
              </div>
              <fieldset disabled={source?.kind === 'order' && Array.isArray(source.order.map.nodes) && source.order.map.nodes.some(node => isRecord(node) && text(node.item_code, '').trim())} className="space-y-2">
                <Label htmlFor="order-product">Mahsulot *</Label>
                <CatalogPicker
                  key={draft.customer_ref}
                  id="order-product"
                  kind="items"
                  label="Mahsulotni"
                  value={draft.item_code}
                  selectedLabel={draft.product}
                  calculateProducts
                  customerRef={draft.customer_ref}
                  onSelect={(row) => {
                    void selectProduct(row);
                  }}
                />
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor="order-status">Buyurtma turi</Label>
                <Select
                  value={source?.kind === 'order' ? text(source.template.status, draft.status) : draft.status}
                  disabled={source?.kind === 'order'}
                  onValueChange={(v) =>
                    change("status", v as OrderDraft["status"])
                  }
                >
                  <SelectTrigger id="order-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {source?.kind === 'order' ? <SelectItem value={text(source.template.status, draft.status)}>{text(source.template.status, '').toLowerCase() === 'flexo' ? 'Flexo' : draft.status}</SelectItem> : <><SelectItem value="Rulon">Rulon</SelectItem><SelectItem value="Paket">Paket</SelectItem></>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="print-method">Ishlab chiqarish turi</Label>
                <Select
                  value={draft.print_method}
                  disabled={source?.kind === 'order'}
                  onValueChange={(v) =>
                    change("print_method", v as OrderDraft["print_method"])
                  }
                >
                  <SelectTrigger id="print-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="metal">Temir</SelectItem>
                    <SelectItem value="flexo">Flexo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="order-image">
                  <ImagePlus className="size-4" />
                  Buyurtma rasmi
                </Label>
                <Input
                  id="order-image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={demo || imageUpload.isPending}
                  onChange={(event) => pickImage(event.target.files?.[0])}
                />
                {imageUpload.isPending && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Rasm yuklanmoqda…
                  </p>
                )}
                {imageUpload.error && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {imageUpload.error.message}
                    </AlertDescription>
                  </Alert>
                )}
                {imageMissing && !imageUpload.isPending && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Rasm ERP serveriga yuklanmagan. Rasmni qayta tanlang yoki
                      olib tashlang.
                    </AlertDescription>
                  </Alert>
                )}
                {localImage && (
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <img
                      src={localImage}
                      alt="Buyurtma rasmi"
                      className="max-h-40 max-w-[65%] rounded object-contain"
                    />
                    <div className="min-w-0 space-y-2">
                      <p className="break-words text-xs text-muted-foreground">
                        {text(draft.image?.image_name, "")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setLocalImage("");
                          change("image", null);
                          imageUpload.reset();
                        }}
                      >
                        <Trash2 />
                        Olib tashlash
                      </Button>
                    </div>
                  </div>
                )}
                {!localImage && draft.image?.image_id ? <div className="flex items-center justify-between gap-3 rounded-md border p-3"><p className="break-words text-sm">{text(draft.image.image_name, 'Mavjud buyurtma rasmi')}</p><Button type="button" variant="outline" size="sm" onClick={() => change('image', null)}><Trash2 />Olib tashlash</Button></div> : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Hisob parametrlari</CardTitle>
              <CardDescription>
                KG, kadr o‘lchami va material qatlamlari bo‘yicha hisob.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField
                id="kg"
                label="KG *"
                value={draft.kg}
                onChange={(v) => change("kg", v)}
                required
              />
              <NumberField
                id="frame_product_size_mm"
                label="1ta kadrdagi mahsulot o‘lchami, mm *"
                value={draft.frame_product_size_mm}
                onChange={(v) => change("frame_product_size_mm", v)}
                required
              />
              <NumberField
                id="frame_count"
                label="Kadr soni *"
                value={draft.frame_count}
                onChange={(v) => change("frame_count", v)}
                required
              />
              {(draft.print_method === "flexo" || mode.kind !== 'new') && (
                <NumberField
                  id="edge_allowance_mm"
                  label="Qo‘shimcha uzunlik, mm *"
                  value={draft.edge_allowance_mm}
                  onChange={(v) => change("edge_allowance_mm", v)}
                  required
                />
              )}
              <NumberField
                id="waste_percent"
                label="Atxod foiz, % *"
                value={draft.waste_percent}
                onChange={(v) => change("waste_percent", v)}
                required
              />
              <NumberField
                id="roll_count"
                label="Val soni"
                value={draft.roll_count}
                onChange={(v) => change("roll_count", v)}
                integer
              />
              <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
                <Checkbox
                  id="by-val"
                  checked={draft.by_val}
                  onCheckedChange={(value) => change("by_val", value === true)}
                />
                <Label htmlFor="by-val">Val bo‘yicha hisoblash</Label>
              </div>
              {draft.by_val && (
                <NumberField
                  id="print_val_size_mm"
                  label="Val razmeri, mm *"
                  value={draft.print_val_size_mm}
                  onChange={(v) => change("print_val_size_mm", v)}
                  required
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Material qatlamlari</CardTitle>
                <Button type="button" variant="link" size="sm" asChild>
                  <Link to="/app/materials">Materiallar va mikronlar</Link>
                </Button>
              </div>
              <CardDescription>
                Materialni tanlang va mikron qalinligini kiriting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.layers.map((layer, index) => {
                const material = selectedMaterials[layer.material_id];
                const variants =
                  material && Array.isArray(material.variants)
                    ? material.variants.filter(isRecord)
                    : [];
                return (
                  <div
                    key={layer.key}
                    className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
                  >
                    <Badge variant="outline" className="mb-2">
                      {index + 1}-qatlam
                    </Badge>
                    <div className="min-w-40 flex-1 space-y-2">
                      <Label htmlFor={`layer-${layer.key}`}>Material *</Label>
                      <CatalogPicker
                        id={`layer-${layer.key}`}
                        kind="materials"
                        label="Materialni"
                        value={layer.material_id}
                        selectedLabel={layer.material}
                        onSelect={(row) => {
                          const id = text(row.id, "");
                          setSelectedMaterials((old) => ({
                            ...old,
                            [id]: row,
                          }));
                          changeLayer(layer.key, {
                            material_id: id,
                            material: text(row.name, ""),
                          });
                        }}
                      />
                    </div>
                    <div className="w-32 space-y-2">
                      <Label htmlFor={`micron-${layer.key}`}>Mikron *</Label>
                      <Input
                        id={`micron-${layer.key}`}
                        inputMode="numeric"
                        value={layer.micron}
                        onChange={(event) =>
                          changeLayer(layer.key, { micron: event.target.value })
                        }
                        list={`microns-${layer.key}`}
                        required
                      />
                      <datalist id={`microns-${layer.key}`}>
                        {variants.map((variant) => (
                          <option
                            key={text(variant.micron)}
                            value={text(variant.micron)}
                          />
                        ))}
                      </datalist>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${index + 1}-qatlamni o‘chirish`}
                      disabled={index === 0}
                      onClick={() =>
                        change(
                          "layers",
                          draft.layers.filter((item) => item.key !== layer.key),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  change("layers", [
                    ...draft.layers,
                    newOrderLayer(crypto.randomUUID()),
                  ])
                }
              >
                <Plus />
                Qatlam qo‘shish
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Izoh</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                aria-label="Buyurtma izohi"
                placeholder="Ishlab chiqarish uchun qo‘shimcha ko‘rsatmalar…"
                value={draft.note}
                onChange={(event) => change("note", event.target.value)}
              />
            </CardContent>
          </Card>
        </fieldset>
        <div className="space-y-4 xl:sticky xl:top-6">
          <Card>
            <CardHeader>
              <CardTitle>Hisoblash natijasi</CardTitle>
              <CardDescription>Natija ERP serveridan olinadi.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {calculation.error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {calculation.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {result ? (
                <>
                  <div className="grid gap-3">
                    {[
                      ["width_mm", "Material eni, mm"],
                      ["min_mold_size_mm", "Minimal qolip, mm"],
                      ["rubber_size_mm", "Rezina o‘lchami, mm"],
                    ].map(([key, label]) => (
                      <div
                        key={key}
                        className="flex justify-between gap-3 text-sm"
                      >
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium tabular-nums">
                          {numberLabel(result[key])}
                        </span>
                      </div>
                    ))}
                  </div>
                  {resultRows.map((row, index) => (
                    <div key={index} className="space-y-2">
                      <p className="text-sm font-medium">
                        {index === 0
                          ? "Asosiy variant"
                          : `${index + 1}-variant`}
                      </p>
                      <div className="overflow-hidden rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Hisob</TableHead>
                              <TableHead className="text-right">
                                Qiymat
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {[
                              ["coeff_sum", "Koeffitsiyent"],
                              ["total_gsm", "Tayyor mahsulot GSM, g/m²"],
                              ["base_length", "Asosiy uzunlik, m"],
                              [
                                "waste_length",
                                `Atxod, ${numberLabel(result.waste_percent)}%`,
                              ],
                              ["rounded_length", "Yakuniy uzunlik, m"],
                            ].map(([key, label]) => (
                              <TableRow key={key}>
                                <TableCell className="whitespace-normal">
                                  {label}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {numberLabel(row[key])}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ))}
                  <Badge variant="secondary">
                    <Check className="size-3" />
                    Hisob tayyor
                  </Badge>
                </>
              ) : (
                <div className="py-8 text-center">
                  <Calculator className="mx-auto mb-3 size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Parametrlarni to‘ldirib, hisoblashni boshlang.
                  </p>
                </div>
              )}
              <Button type="submit" className="w-full" disabled={demo || busy || completedPending}>
                {calculation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Calculator />
                )}
                Hisoblash
              </Button>
              {mode.kind === 'new' && <Button
                type="button"
                className="w-full"
                disabled={
                  busy ||
                  !result ||
                  (uncertain && (!map || mapSignature !== signature)) ||
                  Boolean(imageUpload.error) ||
                  imageMissing
                }
                onClick={openMapEditor}
              >
                <Waypoints />
                Mapni ulash
              </Button>}
              <CalculatorManagementActions mode={mode} management={management} result={result} productName={draft.product} prepareTemplate={(reusable, name) => managedCalculatorTemplate(draft, result, source, reusable, name)} busy={busy || uncertain || managementOpenUnknown || imageMissing || Boolean(imageUpload.error)} onSaved={managementSaved} />
              {!opening.isPending && <CalculatorManagementNotice management={management} onSaved={managementSaved} />}
              {(mode.kind === 'new' || mode.kind === 'template' && !mode.edit) && <Button
                type="button"
                className="w-full"
                variant="outline"
                disabled={
                  demo ||
                  busy ||
                  !result ||
                  uncertain ||
                  managementOpenUnknown ||
                  Boolean(imageUpload.error) ||
                  imageMissing
                }
                onClick={() => setConfirm(true)}
              >
                <ClipboardPlus />
                Avtomatik buyurtma ochish
              </Button>}
              {uncertain && !opening.isPending && (
                <Alert variant="destructive">
                  <AlertDescription>
                    So‘rov natijasi aniq emas. Qayta ochishdan oldin{" "}
                    <Link className="underline" to="/app/orders">
                      buyurtmalar ro‘yxatini tekshiring
                    </Link>
                    .{" "}
                    {mode.kind === 'new' ? <Button type="button" variant="outline" size="sm" onClick={() => { management.clearAutomatic(); reset(); }}>Yangi buyurtma boshlash</Button> : <Button type="button" variant="outline" size="sm" asChild><Link to="/app/calculate">Yangi buyurtma boshlash</Link></Button>}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </form>
      <Dialog
        open={confirm}
        onOpenChange={(value) => {
          if (!opening.isPending) setConfirm(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Avtomatik buyurtma ochish</DialogTitle>
            <DialogDescription>
              {draft.product} · {numberLabel(result?.kg)} kg. Buyurtma raqamini
              ERP serveri beradi.
            </DialogDescription>
          </DialogHeader>
          {opening.error && (
            <Alert variant="destructive">
              <AlertDescription>{opening.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={opening.isPending}
              onClick={() => setConfirm(false)}
            >
              Bekor qilish
            </Button>
            <Button
              disabled={opening.isPending || uncertain || !result}
              onClick={() => {
                setUncertain(true);
                opening.mutate({
                  current: structuredClone(draft),
                  result,
                  request: scopedRequest(),
                });
              }}
            >
              {opening.isPending && <Loader2 className="animate-spin" />}
              Tasdiqlash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  required,
  integer,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  integer?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </div>
  );
}
