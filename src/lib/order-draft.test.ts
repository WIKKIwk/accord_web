import { describe, expect, it } from "vitest";
import {
  automaticOrderTemplate,
  calculationInput,
  calculationSignature,
  customerSelection,
  newOrderDraft,
  newOrderLayer,
  orderDraftError,
} from "./order-draft";

function validDraft() {
  const draft = newOrderDraft();
  Object.assign(draft, {
    item_code: "FINISHED-1",
    product: " Qadoq ",
    kg: "120",
    frame_product_size_mm: "250",
    frame_count: "3",
  });
  draft.layers = [
    {
      ...newOrderLayer("first"),
      material_id: "pet",
      material: "PET",
      micron: "12",
    },
  ];
  return draft;
}

describe("mobile new-order parity", () => {
  it("leaves KG, frames, optional val count and Flexo allowance empty", () => {
    expect(newOrderDraft()).toMatchObject({
      kg: "",
      frame_count: "",
      frame_product_size_mm: "",
      roll_count: "",
      edge_allowance_mm: "",
      waste_percent: "5",
      status: "Rulon",
      print_method: "metal",
    });
    expect(newOrderDraft()).not.toHaveProperty("name");
    expect(newOrderDraft()).not.toHaveProperty("order_number");
    expect(newOrderDraft()).not.toHaveProperty("color");
  });
  it("uses product name and leaves all new identities for the backend", () => {
    const template = automaticOrderTemplate(validDraft(), { width_mm: 765 });
    expect(template).toMatchObject({
      name: "Qadoq",
      order_number: "",
      id: "",
      code: "",
      color: "",
      customer_ref: "",
      width_mm: 765,
      production_options: { print_method: "metal", cold_glue: false },
    });
    expect(calculationInput(validDraft())).not.toHaveProperty("order_number");
    expect(calculationInput(validDraft())).not.toHaveProperty("name");
    expect(calculationInput(validDraft())).not.toHaveProperty("color");
  });
  it("customer is optional, and selecting another customer clears the old product", () => {
    expect(orderDraftError(validDraft())).toBeNull();
    expect(
      customerSelection(validDraft(), { ref: "CUSTOMER-2", name: "Mijoz" }),
    ).toMatchObject({
      customer_ref: "CUSTOMER-2",
      customer: "Mijoz",
      item_code: "",
      product: "",
    });
  });
  it("image response metadata cannot replace generated identity or order parameters", () => {
    const draft = validDraft();
    draft.image = {
      image_id: "image-1",
      image_name: "rasm.webp",
      image_mime: "image/webp",
      image_size_bytes: 100,
      image_url: "/image",
      id: "wrong",
      order_number: "manual",
      kg: 999,
      name: "wrong",
    };
    expect(automaticOrderTemplate(draft, { width_mm: 765 })).toMatchObject({
      id: "",
      order_number: "",
      kg: 120,
      name: "Qadoq",
      image_id: "image-1",
    });
  });
  it("keeps product form and print method independent, and ignores hidden allowance in Temir", () => {
    const draft = validDraft();
    draft.status = "Paket";
    draft.edge_allowance_mm = "999";
    expect(calculationInput(draft)).toMatchObject({
      status: "Paket",
      edge_allowance_mm: 15,
    });
    draft.print_method = "flexo";
    draft.edge_allowance_mm = "0";
    expect(calculationInput(draft)).toMatchObject({
      status: "Paket",
      edge_allowance_mm: 0,
    });
    expect(
      automaticOrderTemplate(draft, { width_mm: 750 }).production_options,
    ).toEqual({ print_method: "flexo", cold_glue: false });
  });
  it.each(["", "-1", "NaN", "Infinity"])(
    "rejects invalid visible Flexo allowance %s",
    (value) => {
      const draft = validDraft();
      draft.print_method = "flexo";
      draft.edge_allowance_mm = value;
      expect(orderDraftError(draft)).not.toBeNull();
    },
  );
  it("omits inactive print-val option and never changes calculation width through it", () => {
    const draft = validDraft();
    draft.print_val_size_mm = "850";
    expect(automaticOrderTemplate(draft, { width_mm: 765 })).not.toHaveProperty(
      "print_val_size_mm",
    );
    draft.by_val = true;
    expect(automaticOrderTemplate(draft, { width_mm: 765 })).toMatchObject({
      width_mm: 765,
      print_val_size_mm: 850,
    });
    expect(calculationInput(draft)).not.toHaveProperty("print_val_size_mm");
    draft.print_val_size_mm = "0";
    expect(orderDraftError(draft)).not.toBeNull();
  });
  it("does not invent a required roll count or a three-layer cap", () => {
    const draft = validDraft();
    draft.layers = Array.from({ length: 5 }, (_, i) => ({
      ...draft.layers[0],
      key: String(i),
    }));
    expect(calculationInput(draft).layers).toHaveLength(5);
    expect(calculationInput(draft)).not.toHaveProperty("roll_count");
    draft.roll_count = "2";
    expect(calculationInput(draft).roll_count).toBe(2);
    draft.roll_count = "2.5";
    expect(orderDraftError(draft)).not.toBeNull();
  });
  it("preserves zero waste and decimal comma without accepting nonfinite or 100% waste", () => {
    const draft = validDraft();
    draft.kg = "120,5";
    draft.waste_percent = "0";
    expect(calculationInput(draft)).toMatchObject({
      kg: 120.5,
      waste_percent: 0,
    });
    for (const value of ["100", "-1", "NaN", "Infinity", ""]) {
      draft.waste_percent = value;
      expect(orderDraftError(draft)).not.toBeNull();
    }
  });
  it("accepts custom catalog micron and sends a backend-compatible integer string", () => {
    const draft = validDraft();
    draft.layers[0].micron = "35,0";
    expect(calculationInput(draft).layers[0].micron).toBe("35");
    for (const value of ["12.5", "0", "NaN", "4294967296"]) {
      draft.layers[0].micron = value;
      expect(orderDraftError(draft)).not.toBeNull();
    }
  });
  it("invalidates calculation on routing changes but not note or image metadata", () => {
    const draft = validDraft(),
      signature = calculationSignature(draft);
    draft.note = "Izoh";
    draft.image = { image_id: "image-1" };
    expect(calculationSignature(draft)).toBe(signature);
    draft.print_method = "flexo";
    expect(calculationSignature(draft)).not.toBe(signature);
  });
});
