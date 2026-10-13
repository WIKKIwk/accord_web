import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  getSmoothStepPath,
} from "@xyflow/react";
import type {
  Node,
  Edge,
  EdgeProps,
  NodeProps,
  NodeChange,
  EdgeChange,
  Connection,
  ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  Factory,
  Flag,
  GitBranch,
  Layers3,
  Link2,
  Loader2,
  PackageCheck,
  Plus,
  Save,
  Scissors,
  Search,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, isRecord, text } from "@/lib/api";
import type { ApiClient } from "@/lib/api";
import type { CalculateOrderTemplate, Row } from "@/lib/api-types";
import { useSession } from "@/lib/session";
import { useProductionWorkflow } from "@/lib/production-workflow";
import {
  automaticOrderTemplate,
  calculationSignature,
} from "@/lib/order-draft";
import { getDemoPage } from "@/lib/demo";
import { MutationScope } from "@/lib/mutation-scope";
import type { MutationLease } from "@/lib/mutation-scope";
import {
  addMapNode,
  addAlternativeApparatusGroup,
  apparatusGroups,
  apparatusMatchesMap,
  apparatusOption,
  connectMapNodes,
  createMapNode,
  createOrderMap,
  fromEditorGraph,
  mapEdgeId,
  productionMapFromRow,
  removeMapEdge,
  removeMapNode,
  toEditorGraph,
  updateMapNode,
  validateProductionMap,
  withoutAlternativeAssignments,
} from "@/lib/production-map";
import type {
  ApparatusOption,
  ProductionMapDefinition,
  ProductionMapNode,
  ProductionMapEdge,
} from "@/lib/production-map";
import { numberLabel } from "@/lib/presentation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type FlowNode = Node<ProductionMapNode, "production">;
type FlowEdge = Omit<Edge<ProductionMapEdge>, "label"> & { label?: string };
const nodeTypes = { production: ProductionNodeCard };
const edgeTypes = { production: ProductionConnectionEdge };
const ProductionNodeActionsContext = createContext<{
  removeNode: (id: string) => void;
  removeEdge: (id: string) => void;
  nodeTitles: Record<string, string>;
  disabled: boolean;
} | null>(null);
const previewTemplate: CalculateOrderTemplate = {
  name: "Namuna qadoq",
  product: "Namuna qadoq",
  item_code: "DEMO-PRODUCT",
  customer: "Namuna mijoz",
  kg: 100,
  frame_product_size_mm: 250,
  frame_count: 2,
  edge_allowance_mm: 15,
  width_mm: 515,
  waste_percent: 5,
  roll_count: 5,
  status: "Rulon",
  layers: [{ material: "BOPP", micron: "20" }],
  production_options: { print_method: "flexo", cold_glue: false },
};

function ProductionConnectionEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  interactionWidth,
  style,
  selected,
  label,
}: EdgeProps<FlowEdge>) {
  const actions = useContext(ProductionNodeActionsContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const description = `${actions?.nodeTitles[source] || source} → ${actions?.nodeTitles[target] || target}${label ? ` (${label})` : ""}`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        style={{ ...style, ...(selected ? { stroke: "var(--foreground)" } : {}) }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {label && (
            <Badge variant="outline" className="bg-background">
              {label}
            </Badge>
          )}
          {actions && (
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="size-7 rounded-full shadow-sm hover:text-destructive"
              aria-label={`Bog‘lanishni uzish: ${description}`}
              title="Bog‘lanishni uzish"
              disabled={actions.disabled}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                actions.removeEdge(id);
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function ProductionNodeCard({ data: node, selected }: NodeProps<FlowNode>) {
  const actions = useContext(ProductionNodeActionsContext);
  const isOrder = node.kind === "task" && node.role_code === "zakaz";
  const isApparatus =
    node.kind === "apparatus" || (node.kind === "task" && !isOrder);
  const Icon =
    node.kind === "start"
      ? Flag
      : node.kind === "end"
        ? PackageCheck
        : node.kind === "condition"
          ? GitBranch
          : node.kind === "apparatus"
            ? Factory
            : ClipboardList;
  const kind =
    node.kind === "start"
      ? "Boshlanish"
      : node.kind === "end"
        ? "Tayyor mahsulot"
        : isOrder
          ? "Buyurtma"
          : node.kind === "apparatus"
            ? "Aparat"
            : node.kind === "task"
              ? "Ishlov stansiyasi"
              : node.kind;
  return (
    <div className="relative w-60">
      {node.kind !== "start" && (
        <Handle
          type="target"
          position={Position.Top}
          aria-label={`${node.title}: kirish`}
          className="!size-3 !border-2 !border-background !bg-foreground"
        />
      )}
      <Card
        className={`gap-2 py-3 shadow-sm ${selected ? "ring-2 ring-ring" : ""}`}
      >
        <CardContent className="space-y-2 px-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon className="size-4" />
            <span>{kind}</span>
            {node.alternative_group_id && (
              <Badge variant="outline" className="ml-auto text-[10px]">
                Muqobil
              </Badge>
            )}
            {isApparatus && actions && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="nodrag nopan ml-auto size-6 text-muted-foreground hover:text-destructive"
                aria-label={`${node.title}ni xaritadan olib tashlash`}
                title="Xaritadan olib tashlash"
                disabled={actions.disabled}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  actions.removeNode(node.id);
                }}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <p className="line-clamp-2 text-sm font-medium">{node.title}</p>
          {node.rezka_kadr_count && (
            <p className="text-xs text-muted-foreground">
              {node.rezka_kadr_count} kadr ·{" "}
              {(node.rezka_frame_groups || []).join(" + ")}
            </p>
          )}
          {node.kind === "condition" && (
            <div className="flex justify-between pt-1 text-[10px] text-muted-foreground">
              <span>Shunda</span>
              <span>Aks holda</span>
            </div>
          )}
        </CardContent>
      </Card>
      {node.kind !== "end" &&
        (node.kind === "condition" ? (
          <>
            <Handle
              type="source"
              id="true"
              position={Position.Bottom}
              style={{ left: "30%" }}
              aria-label={`${node.title}: Shunda`}
              className="!size-3 !border-2 !border-background !bg-foreground"
            />
            <Handle
              type="source"
              id="false"
              position={Position.Bottom}
              style={{ left: "70%" }}
              aria-label={`${node.title}: Aks holda`}
              className="!size-3 !border-2 !border-background !bg-foreground"
            />
          </>
        ) : (
          <Handle
            type="source"
            position={Position.Bottom}
            aria-label={`${node.title}: chiqish`}
            className="!size-3 !border-2 !border-background !bg-foreground"
          />
        ))}
    </div>
  );
}

export function ProductionMapPage() {
  const workflow = useProductionWorkflow();
  const { demo } = useSession();
  const fresh =
    workflow.calculated &&
    workflow.calculated.signature === calculationSignature(workflow.draft);
  const template = fresh
    ? automaticOrderTemplate(workflow.draft, workflow.calculated!.result)
    : demo
      ? previewTemplate
      : null;
  if (
    !template ||
    (!demo &&
      (!workflow.map ||
        workflow.mapSignature !== workflow.calculated?.signature))
  )
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {fresh ? "Xaritani hisobdan ulang" : "Avval buyurtmani hisoblang"}
          </CardTitle>
          <CardDescription>
            Buyurtma formasida «Mapni ulash» tugmasi orqali davom eting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/app/calculate">
              <ArrowLeft />
              Buyurtma formasiga qaytish
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  const initialMap = workflow.map
    ? productionMapFromRow(workflow.map)
    : createOrderMap(template, { width_mm: 515 }, "zakaz-draft-preview");
  return (
    <ProductionMapEditor
      key={initialMap.id}
      initialMap={initialMap}
      template={template}
      preview={!fresh}
    />
  );
}

function ProductionMapEditor({
  initialMap,
  template,
  preview,
}: {
  initialMap: ProductionMapDefinition;
  template: CalculateOrderTemplate;
  preview: boolean;
}) {
  const { client, demo, scope, connection } = useSession();
  const workflow = useProductionWorkflow();
  const navigate = useNavigate(),
    queryClient = useQueryClient();
  const initial = useMemo(
    () => decorateGraph(initialMap, "order"),
    [initialMap.id],
  );
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<FlowEdge[]>(initial.edges);
  const nodesRef = useRef(nodes),
    edgesRef = useRef(edges);
  const [selectedNodeId, setSelectedNodeId] = useState("order");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    operation: string;
    editId?: string;
  } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [checkedOrders, setCheckedOrders] = useState(false);
  const { uncertain, setUncertain } = workflow;
  const imageMissing = Boolean(
    workflow.localImage && !workflow.draft.image?.image_id,
  );
  const [source, setSource] = useState(""),
    [target, setTarget] = useState("");
  const [history, setHistory] = useState<ProductionMapDefinition[]>([]),
    [future, setFuture] = useState<ProductionMapDefinition[]>([]);
  const flow = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const [mutations] = useState(() => new MutationScope());
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const catalog = useQuery({
    queryKey: ["map-apparatus", scope],
    queryFn: ({ signal }) =>
      demo
        ? getDemoPage("apparatus", { limit: 500 })
        : client!.list("apparatus", { limit: 500 }, signal),
  });
  const apparatus = catalog.data?.items || [];
  const groups = apparatusGroups(apparatus).filter(
    (group) => group.operation !== "unclassified",
  );
  const currentMap = () =>
    fromEditorGraph(initialMap, nodesRef.current, edgesRef.current);
  const graph = currentMap();
  const issues = validateProductionMap(graph, { apparatus, template });
  const errors = issues.filter((issue) => issue.severity === "error");
  const selected = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => mutations.cancelAll(), [scope, mutations]);
  const recovery = useQuery({
    queryKey: ["map-save-recovery", scope],
    queryFn: ({ signal }) => client!.listSnapshot("orders", {}, signal),
    enabled: recoveryOpen && uncertain && Boolean(client) && !demo,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => setCheckedOrders(false), [recovery.dataUpdatedAt]);
  const relatedOrders = (recovery.data?.items ?? []).filter((order) =>
    template.item_code
      ? order.product_code === template.item_code
      : order.title === template.product,
  );
  const save = useMutation({
    mutationFn: async ({
      map,
      request,
    }: {
      map: ProductionMapDefinition;
      request: {
        client: ApiClient | null;
        scope: string;
        lease: MutationLease;
        sent: boolean;
      };
    }) => {
      if (!request.client || demo)
        throw new Error("Xaritani saqlash uchun ERP serveriga kiring.");
      const invalid = validateProductionMap(map, {
        apparatus,
        template,
      }).filter((issue) => issue.severity === "error");
      if (invalid.length) throw new Error(invalid[0].message);
      await request.client.me(request.lease.controller.signal);
      if (!mutations.isCurrent(request.lease) || scopeRef.current !== request.scope)
        throw new DOMException("So‘rov bekor qilindi.", "AbortError");
      request.sent = true;
      setUncertain(true);
      return request.client.saveProductionMapWithOrder(
        withoutAlternativeAssignments(map),
        template,
        request.lease.controller.signal,
      );
    },
    onSuccess: (data, { request }) => {
      if (
        scopeRef.current !== request.scope ||
        !mutations.isCurrent(request.lease)
      )
        return;
      const saved = isRecord(data.saved) ? data.saved : {};
      const map = isRecord(saved.map) ? saved.map : {};
      toast.success(
        `Production map va buyurtma №${text(map.order_number)} saqlandi.`,
      );
      void queryClient.invalidateQueries();
      workflow.reset();
      navigate(`/app/orders?selected=${encodeURIComponent(text(map.id, ""))}`);
    },
    onError: (error, { request }) => {
      if (
        request.scope !== scopeRef.current ||
        !mutations.isCurrent(request.lease)
      )
        return;
      setConfirm(false);
      setUncertain(
        request.sent && error instanceof ApiError &&
          (error.status === 0 || error.status >= 500 || error.code === "invalid_response"),
      );
    },
    onSettled: (_data, _error, { request }) => mutations.finish(request.lease),
  });

  function persist(map: ProductionMapDefinition) {
    workflow.setMap(map);
  }
  function replaceGraph(map: ProductionMapDefinition, remember = true) {
    if (remember) {
      setHistory((old) => [...old.slice(-29), currentMap()]);
      setFuture([]);
    }
    const next = decorateGraph(map, selectedNodeId);
    nodesRef.current = next.nodes;
    edgesRef.current = next.edges;
    setNodes(next.nodes);
    setEdges(next.edges);
    persist(map);
  }
  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const safe = changes.filter(
      (change) =>
        change.type !== "remove" ||
        !nodesRef.current.some(
          (node) =>
            node.id === change.id && ["start", "end"].includes(node.data.kind),
        ),
    );
    const next = applyNodeChanges(safe, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (safe.some((change) => change.type === "remove")) {
      const ids = new Set(next.map((node) => node.id));
      edgesRef.current = edgesRef.current.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      );
      setEdges(edgesRef.current);
      persist(currentMap());
    }
  }
  function onEdgesChange(changes: EdgeChange<FlowEdge>[]) {
    const next = applyEdgeChanges(changes, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
    if (changes.some((change) => change.type === "remove"))
      persist(currentMap());
  }
  function connect(connection: Connection) {
    if (!connection.source || !connection.target || save.isPending) return;
    try {
      replaceGraph(
        connectMapNodes(
          currentMap(),
          connection.source,
          connection.target,
          connection.sourceHandle || "",
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Bog‘lanish yaratilmadi.",
      );
    }
  }
  function applyNode(id: string, patch: Partial<ProductionMapNode>) {
    let next = updateMapNode(currentMap(), id, patch);
    const node = next.nodes.find((node) => node.id === id);
    if (node?.alternative_group_id && patch.rezka_frame_groups) {
      for (const other of next.nodes)
        if (
          other.id !== id &&
          other.alternative_group_id === node.alternative_group_id
        )
          next = updateMapNode(next, other.id, {
            rezka_kadr_count: patch.rezka_kadr_count,
            rezka_frame_groups: patch.rezka_frame_groups,
            rezka_label_length: null,
          });
    }
    replaceGraph(next);
  }
  function removeNode(id: string) {
    const map = currentMap();
    const node = map.nodes.find((node) => node.id === id);
    if (save.isPending || !node || ["start", "end"].includes(node.kind)) return;
    replaceGraph(removeMapNode(map, id));
    if (selectedNodeId === id) setSelectedNodeId("");
    setSelectedEdgeId(null);
    if (source === id) setSource("");
    if (target === id) setTarget("");
  }
  function removeEdge(id: string) {
    if (save.isPending) return;
    const map = currentMap();
    const edge = map.edges.find((edge) => mapEdgeId(edge) === id);
    if (!edge) return;
    replaceGraph(removeMapEdge(map, edge));
    if (selectedEdgeId === id) setSelectedEdgeId(null);
  }
  function pickApparatus(items: ApparatusOption[], alternative: boolean) {
    if (!picker || !items.length) return;
    try {
      const kind = picker.operation === "task" ? "task" : "apparatus";
      const cut = kind === "apparatus" && items[0].operation === "cut";
      const count =
        Number.isSafeInteger(template.frame_count) && template.frame_count > 0
          ? template.frame_count
          : 0;
      const rezka =
        cut && count
          ? {
              rezka_kadr_count: count,
              rezka_frame_groups: Array.from({ length: count }, () => 1),
            }
          : {};
      let next = currentMap();
      if (picker.editId) {
        const node = next.nodes.find((node) => node.id === picker.editId);
        next = updateMapNode(next, picker.editId, {
          apparatus_id: items[0].id,
          title: items[0].name,
          ...(node?.rezka_kadr_count ? {} : rezka),
        });
      } else if (alternative) {
        const group = groups.find(
          (group) => group.operation === picker.operation,
        );
        next = addAlternativeApparatusGroup(
          next,
          items.map((item) => item.row),
          group?.title || "Aparatlar",
          rezka,
        );
      } else {
        const node = createMapNode(next, kind, {
          title: items[0].name,
          apparatus_id: items[0].id,
          ...rezka,
        });
        next = addMapNode(next, node);
        setSelectedNodeId(node.id);
      }
      replaceGraph(next);
      setPicker(null);
      requestAnimationFrame(() => {
        void flow.current?.fitView({ padding: 0.3, duration: 250 });
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Bosqich qo‘shilmadi.",
      );
    }
  }
  function addTask() {
    const node = createMapNode(currentMap(), "task");
    replaceGraph(addMapNode(currentMap(), node));
    setSelectedNodeId(node.id);
    setPicker({ operation: "task", editId: node.id });
  }
  function goBack() {
    persist(currentMap());
    navigate("/app/calculate");
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((old) => [currentMap(), ...old]);
    setHistory((old) => old.slice(0, -1));
    replaceGraph(previous, false);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setHistory((old) => [...old, currentMap()]);
    setFuture((old) => old.slice(1));
    replaceGraph(next, false);
  }
  const pickerItems = picker
    ? apparatus
        .map(apparatusOption)
        .filter(
          (item) =>
            (picker.operation === "task" ||
              picker.operation === "edit" ||
              item.operation === picker.operation) &&
            item.active,
        )
    : [];
  const compatible = pickerItems.filter((item) =>
    apparatusMatchesMap(
      item.row,
      picker?.operation === "task" ? { ...graph, nodes: [] } : graph,
      template,
      apparatus,
    ),
  );

  return (
    <ProductionNodeActionsContext.Provider
      value={{
        removeNode,
        removeEdge,
        nodeTitles: Object.fromEntries(
          graph.nodes.map((node) => [node.id, node.title]),
        ),
        disabled: save.isPending,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Production map
            </h1>
            <Badge variant="outline">
              {demo ? "Ko‘rish rejimi" : "Yangi buyurtma"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {template.product} · {template.customer || "Mijoz tanlanmagan"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={save.isPending} onClick={goBack}>
            <ArrowLeft />
            Hisobga qaytish
          </Button>
          <Button
            disabled={
              demo ||
              save.isPending ||
              errors.length > 0 ||
              connection === "offline" ||
              uncertain ||
              imageMissing
            }
            onClick={() => setConfirm(true)}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            Saqlash va buyurtma ochish
          </Button>
        </div>
      </div>
      {preview && (
        <Alert>
          <AlertDescription>
            Namunaviy xarita. Tugunlarni tahrirlash mumkin; ERP serveriga
            saqlanmaydi.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>
          <span className="text-muted-foreground">KG: </span>
          {numberLabel(template.kg)}
        </span>
        <span>
          <span className="text-muted-foreground">Eni: </span>
          {numberLabel(graph.width_mm)} mm
        </span>
        <span>
          <span className="text-muted-foreground">Kadr: </span>
          {numberLabel(template.frame_count)}
        </span>
        <span>
          <span className="text-muted-foreground">Ishlab chiqarish: </span>
          {template.production_options?.print_method === "flexo"
            ? "Flexo"
            : "Temir"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {nodes.length} tugun · {edges.length} bog‘lanish
        </span>
      </div>
      {catalog.error && (
        <Alert variant="destructive">
          <AlertTitle>Aparatlar yuklanmadi</AlertTitle>
          <AlertDescription>
            {catalog.error.message}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void catalog.refetch();
              }}
            >
              Qayta urinish
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {imageMissing && (
        <Alert variant="destructive">
          <AlertDescription>
            Buyurtma rasmi yuklanmagan. Hisobga qaytib rasmni qayta tanlang yoki
            olib tashlang.
          </AlertDescription>
        </Alert>
      )}
      {uncertain && !save.isPending && (
        <Alert variant="destructive">
          <AlertDescription>
            {save.error && <span className="block">{save.error.message}</span>}
            Saqlash natijasi aniq emas. Xarita va buyurtma ma’lumotlari saqlanib turibdi. Takrorlashdan oldin{" "}
            <Link className="underline" to="/app/orders">
              buyurtmalar ro‘yxatini tekshiring
            </Link>
            .{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCheckedOrders(false);
                setRecoveryOpen(true);
              }}
            >
              Holatni tekshirish va qayta urinish
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {save.error && !uncertain && (
        <Alert variant="destructive">
          <AlertTitle>Buyurtma saqlanmadi</AlertTitle>
          <AlertDescription>
            {save.error.message} Xarita va buyurtma ma’lumotlari saqlanib turibdi. Ulanish tiklangach qayta saqlashingiz mumkin.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="gap-0 overflow-hidden py-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={save.isPending || catalog.isPending}
                >
                  <Plus />
                  Bosqich qo‘shish
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Ishlab chiqarish</DropdownMenuLabel>
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.operation}
                    onSelect={() => setPicker({ operation: group.operation })}
                  >
                    <Factory />
                    {group.title}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={addTask}>
                  <ClipboardList />
                  Ishlov stansiyasi
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={!history.length || save.isPending}
                onClick={undo}
              >
                Bekor qilish
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!future.length || save.isPending}
                onClick={redo}
              >
                Qaytarish
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Xaritani to‘liq ko‘rsatish"
                onClick={() => {
                  void flow.current?.fitView({ padding: 0.3, duration: 250 });
                }}
              >
                <ZoomIn />
              </Button>
            </div>
          </div>
          <div className="h-[calc(100svh-18rem)] min-h-[440px] w-full">
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_event, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId("");
              }}
              onNodeDragStart={() => {
                setHistory((old) => [...old.slice(-29), currentMap()]);
                setFuture([]);
              }}
              onNodeDragStop={() => persist(currentMap())}
              nodesDraggable={!save.isPending}
              nodesConnectable={!save.isPending}
              elementsSelectable={!save.isPending}
              deleteKeyCode={save.isPending ? null : ["Backspace", "Delete"]}
              minZoom={0.2}
              maxZoom={2}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              colorMode={dark ? "dark" : "light"}
              style={{ background: "var(--background)" }}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor="var(--muted-foreground)"
                style={{ background: "var(--card)", height: 85, width: 125 }}
              />
            </ReactFlow>
          </div>
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            Tugunni suring. Nuqtadan nuqtaga tortib ulang. Tugunni yoki
            bog‘lanishni bosib tahrirlang. Chiziqdagi × bog‘lanishni uzadi.
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                {selected
                  ? "Tugun tafsiloti"
                  : selectedEdge
                    ? "Bog‘lanish"
                    : "Xarita tafsiloti"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {selected ? (
                <>
                  <NodeInspector
                    key={selected.id}
                    node={selected}
                    catalog={apparatus}
                    template={template}
                    onChange={(patch) => applyNode(selected.id, patch)}
                    onPick={() =>
                      setPicker({
                        operation: selected.kind === "task" ? "task" : "edit",
                        editId: selected.id,
                      })
                    }
                    disabled={save.isPending}
                  />
                  {!["start", "end"].includes(selected.kind) && (
                    <>
                      <Separator />
                      <Button
                        variant="outline"
                        className="w-full"
                        disabled={save.isPending}
                        onClick={() => removeNode(selected.id)}
                      >
                        <Trash2 />
                        Tugunni o‘chirish
                      </Button>
                    </>
                  )}
                </>
              ) : selectedEdge ? (
                <>
                  <p className="text-sm">
                    {
                      graph.nodes.find(
                        (node) => node.id === selectedEdge.source,
                      )?.title
                    }
                    <ArrowRight className="my-2 size-4 text-muted-foreground" />
                    {
                      graph.nodes.find(
                        (node) => node.id === selectedEdge.target,
                      )?.title
                    }
                  </p>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={save.isPending}
                    onClick={() => removeEdge(selectedEdge.id)}
                  >
                    <Trash2 />
                    Bog‘lanishni uzish
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Xaritadan tugun yoki bog‘lanishni tanlang.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Yo‘l ulash</CardTitle>
              <CardDescription>
                Nuqtalarni tortish orqali ham ulash mumkin.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger
                  className="w-full"
                  aria-label="Boshlang‘ich tugun"
                >
                  <SelectValue placeholder="Qayerdan" />
                </SelectTrigger>
                <SelectContent>
                  {graph.nodes
                    .filter((node) => node.kind !== "end")
                    .map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full" aria-label="Maqsad tugun">
                  <SelectValue placeholder="Qayerga" />
                </SelectTrigger>
                <SelectContent>
                  {graph.nodes
                    .filter((node) => node.kind !== "start")
                    .map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                className="w-full"
                variant="outline"
                disabled={!source || !target || save.isPending}
                onClick={() =>
                  connect({
                    source,
                    target,
                    sourceHandle: null,
                    targetHandle: null,
                  })
                }
              >
                <Link2 />
                Ulash
              </Button>
            </CardContent>
          </Card>
          {!!issues.length && (
            <Card>
              <CardHeader>
                <CardTitle>Tekshiruv</CardTitle>
                <CardDescription>
                  {errors.length
                    ? `${errors.length} ta xatoni tuzating`
                    : "Eslatmalar"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {issues.map((issue, index) => (
                  <button
                    key={index}
                    className={`block w-full rounded-md border p-2 text-left text-xs ${issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}`}
                    onClick={() => {
                      if (issue.nodeId) setSelectedNodeId(issue.nodeId);
                    }}
                  >
                    {issue.message}
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <Dialog
        open={!!picker}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {picker?.operation === "task"
                ? "Ishlov stansiyasi"
                : picker?.editId
                  ? "Aparat tanlang"
                  : groups.find(
                      (group) => group.operation === picker?.operation,
                    )?.title || "Aparat tanlang"}
            </DialogTitle>
            <DialogDescription>
              Buyurtma parametrlariga mos apparatni tanlang.
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Aparat qidirish…" />
            <CommandList>
              <CommandEmpty>Mos apparat topilmadi.</CommandEmpty>
              <CommandGroup>
                {pickerItems.map((item) => {
                  const allowed = compatible.some(
                    (candidate) => candidate.id === item.id,
                  );
                  return (
                    <CommandItem
                      key={item.id}
                      value={`${item.name} ${item.id}`}
                      disabled={!allowed}
                      onSelect={() => pickApparatus([item], false)}
                    >
                      <Factory />
                      <span>{item.name}</span>
                      {!allowed && (
                        <Badge variant="outline" className="ml-auto">
                          Mos emas
                        </Badge>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          {picker && !picker.editId && compatible.length > 1 && (
            <Button
              variant="outline"
              onClick={() => pickApparatus(compatible, true)}
            >
              <GitBranch />
              Keyin tanlash — mos apparatlar
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Buyurtmani qayta saqlash</DialogTitle>
            <DialogDescription>
              {template.product} bo‘yicha ro‘yxat serverdan yangilanadi. Oldingi so‘rov buyurtmani saqlagan bo‘lsa, o‘sha buyurtmani oching. Qayta saqlash yangi buyurtma yaratadi.
            </DialogDescription>
          </DialogHeader>
          {recovery.isFetching ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Buyurtmalar tekshirilmoqda…
            </p>
          ) : recovery.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {recovery.error.message}
                <Button variant="outline" size="sm" onClick={() => { setCheckedOrders(false); void recovery.refetch(); }}>
                  Qayta tekshirish
                </Button>
              </AlertDescription>
            </Alert>
          ) : recovery.isSuccess ? (
            <>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>Buyurtma</TableHead><TableHead>Mijoz</TableHead><TableHead>KG</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {relatedOrders.map((order) => (
                      <TableRow key={text(order.id)}>
                        <TableCell>№{text(order.order_number)}</TableCell>
                        <TableCell>{text(order.customer_name)}</TableCell>
                        <TableCell>{numberLabel(order.order_kg)}</TableCell>
                        <TableCell><Button variant="link" size="sm" asChild><Link to={`/app/orders?selected=${encodeURIComponent(text(order.id, ""))}`}>Ochish</Link></Button></TableCell>
                      </TableRow>
                    ))}
                    {!relatedOrders.length && <TableRow><TableCell colSpan={4} className="text-muted-foreground">Shu mahsulot bo‘yicha buyurtma topilmadi.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id="map-save-orders-checked" checked={checkedOrders} onCheckedChange={(value) => setCheckedOrders(value === true)} />
                <Label htmlFor="map-save-orders-checked" className="text-sm leading-5">Ro‘yxatni tekshirdim, bu buyurtma saqlanmagan.</Label>
              </div>
            </>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecoveryOpen(false)}>Bekor qilish</Button>
            <Button disabled={!recovery.isSuccess || recovery.isFetching || !checkedOrders || connection === "offline"} onClick={() => {
              setUncertain(false);
              setRecoveryOpen(false);
              save.reset();
              setConfirm(true);
            }}>Shu xaritani qayta saqlash</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!save.isPending) setConfirm(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xarita va buyurtmani saqlash</DialogTitle>
            <DialogDescription>
              {template.product} · {numberLabel(template.kg)} kg. Xarita bilan
              buyurtma birga saqlanadi. Buyurtma raqamini ERP serveri beradi.
            </DialogDescription>
          </DialogHeader>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => setConfirm(false)}
            >
              Bekor qilish
            </Button>
            <Button
              disabled={
                save.isPending ||
                demo ||
                uncertain ||
                imageMissing ||
                errors.length > 0
                || connection === "offline"
              }
              onClick={() => {
                save.mutate({
                  map: currentMap(),
                  request: { client, scope, lease: mutations.begin(), sent: false },
                });
              }}
            >
              {save.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              Tasdiqlash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProductionNodeActionsContext.Provider>
  );
}

function decorateGraph(
  map: ProductionMapDefinition,
  selectedId = "",
): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const graph = toEditorGraph(map);
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      type: "production",
      selected: node.id === selectedId,
      deletable: !["start", "end"].includes(node.data.kind),
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      type: "production",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.8 },
      interactionWidth: 20,
    })),
  };
}

function NodeInspector({
  node,
  catalog,
  template,
  onChange,
  onPick,
  disabled,
}: {
  node: ProductionMapNode;
  catalog: Row[];
  template: CalculateOrderTemplate;
  onChange: (patch: Partial<ProductionMapNode>) => void;
  onPick: () => void;
  disabled: boolean;
}) {
  const apparatus = catalog
    .map(apparatusOption)
    .find((item) => item.id === node.apparatus_id);
  const station =
    node.kind === "apparatus" ||
    (node.kind === "task" && node.role_code !== "zakaz");
  const cut = node.kind === "apparatus" && apparatus?.operation === "cut";
  const count =
    Number.isSafeInteger(template.frame_count) && template.frame_count > 0
      ? template.frame_count
      : 0;
  const frameGroups = node.rezka_frame_groups || [];
  let cursor = 1;
  return (
    <>
      <Badge variant="outline">
        {node.kind === "start"
          ? "Boshlanish"
          : node.kind === "end"
            ? "Mahsulot"
            : station
              ? "Ishlab chiqarish bosqichi"
              : "Buyurtma"}
      </Badge>
      {station ? (
        <div className="space-y-2">
          <Label>Aparat</Label>
          <Button
            variant="outline"
            className="w-full justify-between"
            disabled={disabled || cut}
            onClick={onPick}
          >
            <span className="truncate">{apparatus?.name || node.title}</span>
            <Search className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="node-title">Tugun nomi</Label>
          <Input
            id="node-title"
            value={node.title}
            disabled={disabled}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </div>
      )}
      {node.alternative_group_label && (
        <p className="text-xs text-muted-foreground">
          {node.alternative_group_label} · Aparat keyin tanlanadi.
        </p>
      )}
      {cut && (
        <div className="space-y-3">
          <Separator />
          <div className="flex items-center gap-2">
            <Scissors className="size-4" />
            <p className="text-sm font-medium">Rezka kadr sozlamasi</p>
          </div>
          {count ? (
            <>
              <p className="text-xs text-muted-foreground">
                {count} kadr. Qo‘shni kadrlarni jipslash yoki qayta ajratish
                mumkin.
              </p>
              {!frameGroups.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      rezka_kadr_count: count,
                      rezka_frame_groups: Array.from(
                        { length: count },
                        () => 1,
                      ),
                    })
                  }
                >
                  Kadrlarni sozlash
                </Button>
              ) : (
                <div className="space-y-2">
                  {frameGroups.map((size, index) => {
                    const start = cursor,
                      end = cursor + size - 1;
                    cursor = end + 1;
                    return (
                      <div key={index} className="space-y-2">
                        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                          <span>
                            {start === end
                              ? `Kadr ${start}`
                              : `Kadr ${start}–${end}`}
                          </span>
                          {size > 1 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={disabled}
                              onClick={() => {
                                const next = [...frameGroups];
                                next.splice(
                                  index,
                                  1,
                                  ...Array.from({ length: size }, () => 1),
                                );
                                onChange({
                                  rezka_kadr_count: count,
                                  rezka_frame_groups: next,
                                  rezka_label_length: null,
                                });
                              }}
                            >
                              Ajratish
                            </Button>
                          )}
                        </div>
                        {index < frameGroups.length - 1 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={disabled}
                            onClick={() => {
                              const next = [...frameGroups];
                              next.splice(
                                index,
                                2,
                                size + frameGroups[index + 1],
                              );
                              onChange({
                                rezka_kadr_count: count,
                                rezka_frame_groups: next,
                                rezka_label_length: null,
                              });
                            }}
                          >
                            <Layers3 />
                            Jipslash
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                Rezka uchun buyurtmada musbat butun kadr soni bo‘lishi kerak.
                Hisobga qaytib kadr sonini to‘g‘rilang.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
      {node.kind === "end" && (
        <p className="text-xs text-muted-foreground">
          Mahsulot: {node.item_code || template.item_code}
        </p>
      )}
    </>
  );
}
