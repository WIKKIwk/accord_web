export type Row = Record<string, unknown>
export type Query = Record<string, string | number | boolean | undefined>

export interface Profile {
  role: string
  display_name: string
  legal_name?: string
  ref?: string
  phone?: string
  avatar_url?: string
}

export interface Session {
  token: string
  profile: Profile
  capabilities: string[]
  assigned_apparatus: string[]
  assigned_apparatus_labels: string[]
  assigned_item_groups: string[]
  assigned_warehouses: string[]
}

export interface Page {
  items: Row[]
  hasMore: boolean
  /** A limit-only endpoint may contain additional records beyond its server cap. */
  bounded?: boolean
}

export type ResourceKind =
  | 'orders' | 'maps' | 'pending' | 'completed' | 'closed' | 'completion'
  | 'wip' | 'opening-wip' | 'items' | 'item-groups' | 'apparatus' | 'workers'
  | 'suppliers' | 'customers' | 'warehouses' | 'stock' | 'users' | 'roles'
  | 'activity' | 'materials' | 'templates' | 'locations' | 'assets' | 'raw-materials'

export interface SavedMap extends Row {
  map: Row
  program: Row
}

export interface ProductionSnapshot extends Row {
  ok: true
  rev: number
  epoch: string
  scope: string
  maps: SavedMap[]
  order_statuses: Record<string, Row>
  order_customers: Record<string, string>
  sequences: Record<string, string[]>
  queue_states: Record<string, Record<string, string>>
  stage_states: Record<string, Record<string, string>>
  queue_action_controls: Record<string, Record<string, Row>>
  order_controls: Record<string, Row>
}

export interface CalculateLayerInput {
  material_id?: string
  material: string
  micron: string
}

export interface CalculateProductionOptions {
  print_method: 'metal' | 'flexo'
  cold_glue: boolean
  diameter_mm?: number | null
}

export interface CalculatorInput {
  kg: number
  frame_product_size_mm: number
  frame_count: number
  edge_allowance_mm: number
  waste_percent: number
  roll_count?: number | null
  layers: CalculateLayerInput[]
  order_number?: string
  date?: string
  customer?: string
  product?: string
  status?: string
  material_display?: string
  color?: string
  note?: string
}

/** New orders leave identity fields empty; Mini RS assigns them when opening. */
export interface CalculateOrderTemplate extends Row, CalculatorInput {
  name: string
  product: string
  production_options?: CalculateProductionOptions
  print_val_size_mm?: number | null
  width_mm?: number
  id?: string
  code?: string
  saved_at?: string
  customer_ref?: string
  item_code?: string
  source_map_id?: string
  image_id?: string
  image_name?: string
  image_mime?: string
  image_size_bytes?: number
  image_url?: string
}

export interface CalculateProductQuery {
  customerRef?: string
  q?: string
  offset?: number
  limit?: number
}

export type CreateResourceKind = 'warehouses' | 'items' | 'customers' | 'suppliers' | 'workers'

export interface SettingsInput {
  default_target_warehouse: string
  default_uom: string
  admin_name: string
  admin_phone: string
  werka_name: string
  werka_phone: string
}
