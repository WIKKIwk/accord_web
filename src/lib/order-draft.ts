import type { CalculateOrderTemplate, CalculatorInput, Row } from "./api-types";

export interface OrderLayer {
  key: string;
  material_id: string;
  material: string;
  micron: string;
}

export interface OrderDraft {
  customer_ref: string;
  customer: string;
  item_code: string;
  product: string;
  status: "Rulon" | "Paket";
  print_method: "metal" | "flexo";
  kg: string;
  frame_product_size_mm: string;
  frame_count: string;
  edge_allowance_mm: string;
  waste_percent: string;
  roll_count: string;
  by_val: boolean;
  print_val_size_mm: string;
  note: string;
  layers: OrderLayer[];
  image: Row | null;
}

/** Mirrors the new-order defaults in admin_calculate_screen.dart, not template defaults. */
export function newOrderDraft(): OrderDraft {
  return {
    customer_ref: "",
    customer: "",
    item_code: "",
    product: "",
    status: "Rulon",
    print_method: "metal",
    kg: "",
    frame_product_size_mm: "",
    frame_count: "",
    edge_allowance_mm: "",
    waste_percent: "5",
    roll_count: "",
    by_val: false,
    print_val_size_mm: "",
    note: "",
    layers: [newOrderLayer("first")],
    image: null,
  };
}

export function newOrderLayer(key: string): OrderLayer {
  return { key, material_id: "", material: "", micron: "" };
}

export function draftNumber(value: string): number {
  const normalized = value.trim().replace(",", ".");
  return normalized ? Number(normalized) : NaN;
}

export function orderDraftError(draft: OrderDraft): string | null {
  if (!draft.item_code.trim() || !draft.product.trim())
    return "Mahsulotni tanlang.";
  for (const [value, label] of [
    [draft.kg, "KG"],
    [draft.frame_product_size_mm, "Kadr razmeri"],
    [draft.frame_count, "Kadr soni"],
  ])
    if (!Number.isFinite(draftNumber(value)) || draftNumber(value) <= 0)
      return `${label} uchun musbat son kiriting.`;
  if (
    draft.print_method === "flexo" &&
    (!Number.isFinite(draftNumber(draft.edge_allowance_mm)) ||
      draftNumber(draft.edge_allowance_mm) < 0)
  )
    return "Qo‘shimcha uzunlik uchun 0 yoki musbat son kiriting.";
  if (
    draft.by_val &&
    (!Number.isFinite(draftNumber(draft.print_val_size_mm)) ||
      draftNumber(draft.print_val_size_mm) <= 0)
  )
    return "Val razmeri uchun musbat son kiriting.";
  const waste = draftNumber(draft.waste_percent);
  if (!Number.isFinite(waste) || waste < 0 || waste >= 100)
    return "Chiqindi 0 dan 100 gacha bo‘lishi kerak (100 kirmaydi).";
  if (
    draft.roll_count.trim() &&
    (!Number.isSafeInteger(draftNumber(draft.roll_count)) ||
      draftNumber(draft.roll_count) <= 0)
  )
    return "Val soni uchun musbat butun son kiriting yoki bo‘sh qoldiring.";
  if (!draft.layers.length) return "Material qatlamini kiriting.";
  for (const [index, layer] of draft.layers.entries()) {
    if (!layer.material.trim())
      return `${index + 1}-qatlam materialini tanlang.`;
    if (
      !Number.isSafeInteger(draftNumber(layer.micron)) ||
      draftNumber(layer.micron) <= 0 ||
      draftNumber(layer.micron) > 4294967295
    )
      return `${index + 1}-qatlam mikroni uchun musbat butun son kiriting.`;
  }
  return null;
}

export function calculationSignature(draft: OrderDraft): string {
  return JSON.stringify([
    draft.product.trim(),
    draft.item_code,
    draft.kg,
    draft.frame_product_size_mm,
    draft.frame_count,
    draft.status,
    draft.print_method,
    draft.print_method === "flexo" ? draft.edge_allowance_mm : "",
    draft.by_val,
    draft.by_val ? draft.print_val_size_mm : "",
    draft.waste_percent,
    draft.roll_count,
    draft.layers.map((layer) => [
      layer.material_id,
      layer.material.trim(),
      layer.micron,
    ]),
  ]);
}

export function calculationInput(draft: OrderDraft): CalculatorInput {
  const error = orderDraftError(draft);
  if (error) throw new Error(error);
  return {
    customer: draft.customer.trim(),
    product: draft.product.trim(),
    status: draft.status,
    kg: draftNumber(draft.kg),
    frame_product_size_mm: draftNumber(draft.frame_product_size_mm),
    frame_count: draftNumber(draft.frame_count),
    edge_allowance_mm:
      draft.print_method === "flexo"
        ? draftNumber(draft.edge_allowance_mm)
        : 15,
    waste_percent: draftNumber(draft.waste_percent),
    ...(draft.roll_count.trim()
      ? { roll_count: draftNumber(draft.roll_count) }
      : {}),
    layers: draft.layers.map((layer) => ({
      ...(layer.material_id.trim()
        ? { material_id: layer.material_id.trim() }
        : {}),
      material: layer.material.trim(),
      micron: String(draftNumber(layer.micron)),
    })),
    note: draft.note.trim(),
  };
}

/** New identities belong to Mini RS. Val size is a map routing option, not calculation width. */
export function automaticOrderTemplate(
  draft: OrderDraft,
  result: Row,
): CalculateOrderTemplate {
  const input = calculationInput(draft);
  if (
    typeof result.width_mm !== "number" ||
    !Number.isFinite(result.width_mm) ||
    result.width_mm <= 0
  )
    throw new Error("Hisoblash natijasini yangilang.");
  return {
    ...input,
    id: "",
    code: "",
    order_number: "",
    name: draft.product.trim(),
    product: draft.product.trim(),
    customer_ref: draft.customer_ref,
    item_code: draft.item_code,
    material_display: "",
    color: "",
    width_mm: result.width_mm,
    production_options: { print_method: draft.print_method, cold_glue: false },
    ...(draft.by_val
      ? { print_val_size_mm: draftNumber(draft.print_val_size_mm) }
      : {}),
    image_id: String(draft.image?.image_id || ""),
    image_name: String(draft.image?.image_name || ""),
    image_mime: String(draft.image?.image_mime || ""),
    image_size_bytes: Number(draft.image?.image_size_bytes || 0),
    image_url: String(draft.image?.image_url || ""),
  };
}

export function customerSelection(
  draft: OrderDraft,
  customer: Row,
): OrderDraft {
  return {
    ...draft,
    customer_ref: String(customer.ref || ""),
    customer: String(customer.name || customer.ref || ""),
    item_code: "",
    product: "",
  };
}
