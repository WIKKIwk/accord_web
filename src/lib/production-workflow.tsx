import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Dispatch, PropsWithChildren, SetStateAction } from "react";
import type { Row } from "./api-types";
import { newOrderDraft } from "./order-draft";
import type { OrderDraft } from "./order-draft";
import { useSession } from "./session";

export interface ProductionCalculation {
  result: Row;
  signature: string;
}

export interface ProductionWorkflowValue {
  draft: OrderDraft;
  setDraft: Dispatch<SetStateAction<OrderDraft>>;
  selectedMaterials: Record<string, Row>;
  setSelectedMaterials: Dispatch<SetStateAction<Record<string, Row>>>;
  calculated: ProductionCalculation | null;
  setCalculated: Dispatch<SetStateAction<ProductionCalculation | null>>;
  map: Row | null;
  setMap: Dispatch<SetStateAction<Row | null>>;
  mapSignature: string;
  setMapSignature: Dispatch<SetStateAction<string>>;
  localImage: string;
  setLocalImage: Dispatch<SetStateAction<string>>;
  uncertain: boolean;
  setUncertain: Dispatch<SetStateAction<boolean>>;
  reset: () => void;
}

const ProductionWorkflowContext = createContext<ProductionWorkflowValue | null>(
  null,
);

/** This session's unfinished order stays in browser RAM across production routes. */
export function ProductionWorkflowProvider({ children }: PropsWithChildren) {
  const { scope } = useSession();
  return (
    <ScopedProductionWorkflow key={scope}>{children}</ScopedProductionWorkflow>
  );
}

function ScopedProductionWorkflow({ children }: PropsWithChildren) {
  const [draft, setDraft] = useState<OrderDraft>(newOrderDraft);
  const [selectedMaterials, setSelectedMaterials] = useState<
    Record<string, Row>
  >({});
  const [calculated, setCalculated] = useState<ProductionCalculation | null>(
    null,
  );
  const [map, setMap] = useState<Row | null>(null);
  const [mapSignature, setMapSignature] = useState("");
  const [localImage, setLocalImage] = useState("");
  const [uncertain, setUncertain] = useState(false);

  useEffect(
    () => () => {
      if (
        localImage.startsWith("blob:") &&
        typeof URL.revokeObjectURL === "function"
      )
        URL.revokeObjectURL(localImage);
    },
    [localImage],
  );

  const reset = useCallback(() => {
    setDraft(newOrderDraft());
    setSelectedMaterials({});
    setCalculated(null);
    setMap(null);
    setMapSignature("");
    setLocalImage("");
    setUncertain(false);
  }, []);

  const value = useMemo<ProductionWorkflowValue>(
    () => ({
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
      reset,
    }),
    [
      draft,
      selectedMaterials,
      calculated,
      map,
      mapSignature,
      localImage,
      uncertain,
      reset,
    ],
  );

  return (
    <ProductionWorkflowContext.Provider value={value}>
      {children}
    </ProductionWorkflowContext.Provider>
  );
}

export function useProductionWorkflow(): ProductionWorkflowValue {
  const context = useContext(ProductionWorkflowContext);
  if (!context)
    throw new Error(
      "useProductionWorkflow ProductionWorkflowProvider ichida ishlatilishi kerak.",
    );
  return context;
}
