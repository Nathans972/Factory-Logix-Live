/**
 * FactoryLogix field mapping (spec 4.8, 10.7).
 * Mapping is configuration, not code. Stored in settings under key `mapping`.
 */

export type DatasetName = 'work_orders' | 'unit_steps' | 'defects' | 'operators' | 'routes' | 'standards';

export type FieldType = 'string' | 'number' | 'timestamp' | 'boolean';

export interface TargetFieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
}

export interface DatasetSpec {
  name: DatasetName;
  label: string;
  /** Required datasets must be mapped for the collector to run. */
  required: boolean;
  description: string;
  fields: TargetFieldSpec[];
}

/** Describes every target field per dataset for the mapping wizard. */
export const DATASET_SPECS: DatasetSpec[] = [
  {
    name: 'work_orders',
    label: 'Work orders (jobs)',
    required: true,
    description: 'One row per job: J-number, product, quantities, status.',
    fields: [
      { name: 'job_number', type: 'string', required: true, description: 'Job / work order number (J-number)' },
      { name: 'product_number', type: 'string', required: true, description: 'Product number (Z-number)' },
      { name: 'product_name', type: 'string', required: false, description: 'Product description' },
      { name: 'qty_released', type: 'number', required: true, description: 'Quantity released' },
      { name: 'qty_complete', type: 'number', required: false, description: 'Quantity complete (derived if not available)' },
      { name: 'status', type: 'string', required: false, description: 'Job status' },
      { name: 'created_at', type: 'timestamp', required: false, description: 'Created / released date' },
      { name: 'modified_at', type: 'timestamp', required: false, description: 'Last modified timestamp' },
    ],
  },
  {
    name: 'unit_steps',
    label: 'Unit process events',
    required: true,
    description: 'One row per unit per operation with start and complete timestamps.',
    fields: [
      { name: 'unit_id', type: 'string', required: true, description: 'Unit serial / ID' },
      { name: 'job_number', type: 'string', required: true, description: 'Job number' },
      { name: 'product_number', type: 'string', required: false, description: 'Product number (derived from work order if not available)' },
      { name: 'operation', type: 'string', required: true, description: 'Operation / step name' },
      { name: 'operation_seq', type: 'number', required: false, description: 'Operation sequence number in the route' },
      { name: 'operator', type: 'string', required: true, description: 'Operator user name' },
      { name: 'start_ts', type: 'timestamp', required: true, description: 'Start scan timestamp' },
      { name: 'complete_ts', type: 'timestamp', required: true, description: 'Complete scan timestamp' },
      { name: 'result', type: 'string', required: false, description: 'Pass / fail result' },
      { name: 'rework_flag', type: 'boolean', required: false, description: 'Rework / re-process flag' },
      { name: 'modified_at', type: 'timestamp', required: false, description: 'Last modified timestamp' },
    ],
  },
  {
    name: 'defects',
    label: 'Defects',
    required: false,
    description: 'One row per defect record.',
    fields: [
      { name: 'unit_id', type: 'string', required: true, description: 'Unit serial / ID' },
      { name: 'job_number', type: 'string', required: true, description: 'Job number' },
      { name: 'operation', type: 'string', required: true, description: 'Operation where found' },
      { name: 'operator', type: 'string', required: false, description: 'Operator who logged it' },
      { name: 'defect_code', type: 'string', required: false, description: 'Defect code' },
      { name: 'description', type: 'string', required: false, description: 'Defect description' },
      { name: 'found_ts', type: 'timestamp', required: true, description: 'Timestamp found' },
      { name: 'status', type: 'string', required: false, description: 'Defect status' },
      { name: 'modified_at', type: 'timestamp', required: false, description: 'Last modified timestamp' },
    ],
  },
  {
    name: 'operators',
    label: 'Operators',
    required: false,
    description: 'User IDs and display names. Derived from events when not mapped.',
    fields: [
      { name: 'operator_id', type: 'string', required: true, description: 'User name / ID' },
      { name: 'display_name', type: 'string', required: false, description: 'Display name' },
    ],
  },
  {
    name: 'routes',
    label: 'Product routes',
    required: false,
    description: 'Ordered operations per product. Derived from events when not mapped.',
    fields: [
      { name: 'product_number', type: 'string', required: true, description: 'Product number' },
      { name: 'operation', type: 'string', required: true, description: 'Operation name' },
      { name: 'sequence', type: 'number', required: true, description: 'Sequence in route' },
    ],
  },
  {
    name: 'standards',
    label: 'FactoryLogix standard hours',
    required: false,
    description: 'Standard units per hour per product/operation (fallback only).',
    fields: [
      { name: 'product_number', type: 'string', required: true, description: 'Product number' },
      { name: 'operation', type: 'string', required: true, description: 'Operation name' },
      { name: 'std_hr', type: 'number', required: true, description: 'Standard units per hour' },
    ],
  },
];

export interface DatasetMapping {
  entity_set: string;
  /** null = no watermark; the collector uses time-window mode on the primary timestamp. */
  watermark_field: string | null;
  /** Source field names that form the natural key. */
  key: string[];
  /** target field name -> source field name (or null when not available). */
  fields: Record<string, string | null>;
  /**
   * The natural keys this dataset had before `key`, oldest first (`MappingKeyHistory`). Not saved
   * with the mapping: the collector adds them when it loads it (`withPreviousKeys`).
   */
  previous_keys?: string[][];
}

export interface MappingConfig {
  work_orders: DatasetMapping;
  unit_steps: DatasetMapping;
  defects: DatasetMapping | null;
  operators: DatasetMapping | null;
  routes: DatasetMapping | null;
  standards: DatasetMapping | null;
}

/**
 * Datasets whose rows are stored by natural key: `unit_steps` and `defects` are upserted on
 * (natural_key, start_ts / found_ts) (spec 6.1). The others are stored by their own columns (job
 * number, operator, product and operation), so their key only names rows in the raw payload archive.
 */
export const NATURAL_KEY_DATASETS = ['unit_steps', 'defects'] as const satisfies readonly DatasetName[];

/** Settings key of the `MappingKeyHistory`. */
export const MAPPING_KEY_HISTORY = 'mapping_key_history';

/**
 * The natural keys a dataset stored by natural key had before its current one, oldest first. The
 * API adds the old key whenever a saved mapping changes it or stops using the dataset. Rows stay
 * stored under the key they were written with; the collector also reads these fields and, when it
 * reads a row again, replaces the copy stored under an old key, so changing the key does not store
 * the row twice (docs/MAPPING.md, "Changing the natural key").
 */
export type MappingKeyHistory = Partial<Record<DatasetName, string[][]>>;

function isKey(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((field) => typeof field === 'string' && field.length > 0);
}

function sameKey(a: string[], b: string[] | null): boolean {
  return b !== null && a.length === b.length && a.every((field, i) => field === b[i]);
}

/** A stored `mapping_key_history` value: the well-formed keys of the datasets stored by natural key. */
export function parseMappingKeyHistory(value: unknown): MappingKeyHistory {
  const history: MappingKeyHistory = {};
  if (!value || typeof value !== 'object') return history;
  for (const dataset of NATURAL_KEY_DATASETS) {
    const keys = (value as Record<string, unknown>)[dataset];
    const valid = Array.isArray(keys) ? keys.filter(isKey) : [];
    if (valid.length > 0) history[dataset] = valid;
  }
  return history;
}

/**
 * `history` once `next` is saved over `prev`: a dataset stored by natural key keeps the key it had
 * when the new mapping gives it another one or stops using it. The key in use is never listed.
 */
export function nextMappingKeyHistory(history: MappingKeyHistory, prev: MappingConfig | null, next: MappingConfig): MappingKeyHistory {
  const out: MappingKeyHistory = {};
  for (const dataset of NATURAL_KEY_DATASETS) {
    // `prev` is the stored value as it is, which may predate today's schema.
    const before = prev?.[dataset]?.key;
    const current = next[dataset]?.key ?? null;
    const keys = [...(history[dataset] ?? []), ...(isKey(before) ? [before] : [])]
      .filter((key) => !sameKey(key, current))
      .filter((key, i, all) => all.findIndex((other) => sameKey(other, key)) === i);
    if (keys.length > 0) out[dataset] = keys;
  }
  return out;
}

/** `mapping` with the keys in `history` as the `previous_keys` of its datasets. */
export function withPreviousKeys(mapping: MappingConfig, history: MappingKeyHistory): MappingConfig {
  const out = { ...mapping };
  for (const dataset of NATURAL_KEY_DATASETS) {
    const current = out[dataset];
    const keys = history[dataset];
    if (current && keys) out[dataset] = { ...current, previous_keys: keys };
  }
  return out;
}

/** Illustrative default mapping (spec 4.8). Real names come from $metadata. */
export const EXAMPLE_MAPPING: MappingConfig = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: {
      job_number: 'WorkOrderNumber',
      product_number: 'PartNumber',
      product_name: 'PartDescription',
      qty_released: 'QuantityReleased',
      qty_complete: 'QuantityComplete',
      status: 'Status',
      created_at: 'CreatedDate',
      modified_at: 'ModifiedDate',
    },
  },
  unit_steps: {
    entity_set: 'UnitProcessHistory',
    watermark_field: 'CompletedDate',
    key: ['UnitSerial', 'WorkOrderNumber', 'OperationName', 'StartedDate'],
    fields: {
      unit_id: 'UnitSerial',
      job_number: 'WorkOrderNumber',
      product_number: 'PartNumber',
      operation: 'OperationName',
      operation_seq: 'OperationSequence',
      operator: 'OperatorName',
      start_ts: 'StartedDate',
      complete_ts: 'CompletedDate',
      result: 'Result',
      rework_flag: null,
      modified_at: null,
    },
  },
  defects: {
    entity_set: 'Defects',
    watermark_field: 'ModifiedDate',
    key: ['DefectId'],
    fields: {
      unit_id: 'UnitSerial',
      job_number: 'WorkOrderNumber',
      operation: 'OperationName',
      operator: 'OperatorName',
      defect_code: 'DefectCode',
      description: 'DefectDescription',
      found_ts: 'FoundDate',
      status: 'Status',
      modified_at: 'ModifiedDate',
    },
  },
  operators: null,
  routes: null,
  standards: null,
};

/** Entity set + fields discovered from $metadata. */
export interface ODataEntityField {
  name: string;
  /** EDM type, e.g. Edm.String, Edm.DateTimeOffset, Edm.Int32 */
  edm_type: string;
  /** Simplified classification used by the wizard for type-checking. */
  kind: FieldType | 'other';
  nullable: boolean;
}

export interface ODataEntitySet {
  name: string;
  entity_type: string;
  fields: ODataEntityField[];
}

export interface ODataMetadata {
  version: string | null;
  entity_sets: ODataEntitySet[];
  fetched_at: number;
}

export function edmTypeToKind(edm: string): FieldType | 'other' {
  const t = edm.replace(/^Edm\./, '');
  if (t === 'String' || t === 'Guid') return 'string';
  if (t === 'DateTimeOffset' || t === 'DateTime' || t === 'Date') return 'timestamp';
  if (t === 'Boolean') return 'boolean';
  if (['Int16', 'Int32', 'Int64', 'Decimal', 'Double', 'Single', 'Byte', 'SByte'].includes(t)) return 'number';
  return 'other';
}
