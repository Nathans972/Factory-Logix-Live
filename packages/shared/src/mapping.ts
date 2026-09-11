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
}

export interface MappingConfig {
  work_orders: DatasetMapping;
  unit_steps: DatasetMapping;
  defects: DatasetMapping | null;
  operators: DatasetMapping | null;
  routes: DatasetMapping | null;
  standards: DatasetMapping | null;
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
