/**
 * The simulated world for the GitHub Pages demo (spec 12.3).
 *
 * Fictional contract electronics manufacturer "Northbridge Circuit Assembly".
 * Nothing here resembles real customer data: product numbers, job numbers and operator
 * names all use formats that differ from the customer's.
 */
import type { BreakDef, ODataMetadata, ShiftDef, SyncLogEntry, User, WorkOrder } from '@fld/shared';

export const COMPANY_NAME = 'Northbridge Circuit Assembly';
export const PLANT_TZ = 'America/New_York';

/** Master seed: every generated artefact derives from this so reloads are identical. */
export const WORLD_SEED = 0x4e4243; // "NBC"

/** Days of simulated history generated at startup. */
export const HISTORY_DAYS = 30;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const OPERATIONS = [
  'SMT Placement',
  'Reflow',
  'AOI',
  'Selective Solder - Top',
  'Selective Solder - Bottom',
  'ICT',
  'Functional Test',
  'Conformal Coat',
  'Final Inspection',
  'Pack',
] as const;

export type OperationName = (typeof OPERATIONS)[number];

/** Base units/hour for an operator with speed factor 1.0 (spec 12.3). */
export const BASE_RATES: Record<string, number> = {
  'SMT Placement': 45,
  Reflow: 50,
  AOI: 40,
  'Selective Solder - Top': 30,
  'Selective Solder - Bottom': 28,
  ICT: 24,
  'Functional Test': 12,
  'Conformal Coat': 20,
  'Final Inspection': 36,
  Pack: 60,
};

/**
 * FactoryLogix's own StdHr numbers (fallback only). Deliberately a little off the
 * computed values so the product page shows a meaningful comparison.
 */
export const FL_STD_HR: Record<string, number> = {
  'SMT Placement': 48,
  Reflow: 55,
  AOI: 42,
  'Selective Solder - Top': 32,
  'Selective Solder - Bottom': 30,
  ICT: 25,
  'Functional Test': 14,
  'Conformal Coat': 22,
  'Final Inspection': 40,
  Pack: 64,
};

/** Operations where the simulator logs defects (spec 12.4). */
export const DEFECT_OPERATIONS = ['AOI', 'ICT'];

export const DEFECT_CODES: { code: string; description: string }[] = [
  { code: 'SOLD-BRIDGE', description: 'Solder bridge between adjacent pads' },
  { code: 'COMP-MISS', description: 'Missing component' },
  { code: 'COMP-SKEW', description: 'Component skew beyond tolerance' },
  { code: 'SOLD-INSUF', description: 'Insufficient solder' },
  { code: 'ICT-OPEN', description: 'Open circuit detected at test point' },
  { code: 'ICT-SHORT', description: 'Short circuit detected' },
  { code: 'COAT-VOID', description: 'Conformal coat void' },
];

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface DemoProduct {
  product_number: string;
  name: string;
  route: string[];
}

export const PRODUCTS: DemoProduct[] = [
  {
    product_number: 'PB-2200',
    name: 'Controller Board',
    route: [
      'SMT Placement',
      'Reflow',
      'AOI',
      'Selective Solder - Top',
      'Selective Solder - Bottom',
      'ICT',
      'Functional Test',
      'Conformal Coat',
      'Final Inspection',
      'Pack',
    ],
  },
  {
    product_number: 'IO-410',
    name: 'Interface Board',
    route: [
      'SMT Placement',
      'Reflow',
      'AOI',
      'Selective Solder - Top',
      'ICT',
      'Final Inspection',
      'Pack',
    ],
  },
  {
    product_number: 'PS-900',
    name: 'Power Module',
    route: [
      'SMT Placement',
      'Reflow',
      'AOI',
      'Selective Solder - Bottom',
      'Functional Test',
      'Conformal Coat',
      'Pack',
    ],
  },
];

export const PRODUCT_BY_NUMBER = new Map(PRODUCTS.map((p) => [p.product_number, p]));

export function routeFor(product_number: string): string[] {
  return PRODUCT_BY_NUMBER.get(product_number)?.route ?? [];
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export interface DemoOperator {
  operator_id: string;
  display_name: string;
  /** Multiplier on the operation base rate. The population median is ~1.0 so computed
   *  standards land close to BASE_RATES. */
  speed: number;
  /** Home shift used by the history generator. */
  shift: 'day' | 'night';
}

export const OPERATORS: DemoOperator[] = [
  { operator_id: 'JRivera', display_name: 'Jasmine Rivera', speed: 1.18, shift: 'day' },
  { operator_id: 'MChen', display_name: 'Marcus Chen', speed: 0.97, shift: 'day' },
  { operator_id: 'TOkafor', display_name: 'Tunde Okafor', speed: 0.8, shift: 'day' },
  { operator_id: 'LNguyen', display_name: 'Linh Nguyen', speed: 0.62, shift: 'day' },
  { operator_id: 'SPatel', display_name: 'Sanjay Patel', speed: 1.02, shift: 'day' },
  { operator_id: 'AKowalski', display_name: 'Anna Kowalski', speed: 0.97, shift: 'day' },
  { operator_id: 'DMorales', display_name: 'Diego Morales', speed: 1.05, shift: 'day' },
  { operator_id: 'KYamada', display_name: 'Kenji Yamada', speed: 0.99, shift: 'night' },
  { operator_id: 'RSingh', display_name: 'Ravi Singh', speed: 1.03, shift: 'night' },
  { operator_id: 'EBrooks', display_name: 'Elena Brooks', speed: 0.95, shift: 'night' },
  { operator_id: 'FHaddad', display_name: 'Farid Haddad', speed: 1.01, shift: 'night' },
  { operator_id: 'NIvanova', display_name: 'Nadia Ivanova', speed: 0.98, shift: 'night' },
  { operator_id: 'BOsei', display_name: 'Benjamin Osei', speed: 1.04, shift: 'night' },
  { operator_id: 'CDubois', display_name: 'Camille Dubois', speed: 0.96, shift: 'night' },
];

export const OPERATOR_BY_ID = new Map(OPERATORS.map((o) => [o.operator_id, o]));

export const OPERATOR_NAMES: Record<string, string | null> = Object.fromEntries(
  OPERATORS.map((o) => [o.operator_id, o.display_name]),
);

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export interface DemoJob {
  job_number: string;
  product_number: string;
  qty_released: number;
  /** Days before "now" the job started on the floor. */
  start_days_ago: number;
  /** Days before "now" the job finished; null => still running. */
  end_days_ago: number | null;
  /**
   * Fraction of qty_released the *generic* 30-day generator should build.
   * Jobs that also have scripted live actors keep this small so the scripted window
   * does not push a route operation past qty_released.
   */
  progress: number;
  status: string;
}

/** The job both demo TVs show (spec 12.4). */
export const FEATURED_JOB = 'J00004728-0000';
/** Second job used by the "display job changed" scenario and the half-hour switcher. */
export const SECONDARY_JOB = 'J00004715-0000';
/** The visitor's own job. */
export const VISITOR_HOME_JOB = 'J00004702-0000';
/** Just-released job (a handful of units only). */
export const NEW_JOB = 'J00004733-0000';

const FILLER_PRODUCTS = ['PB-2200', 'IO-410', 'PS-900'];

/** Demo job numbers use the J########-#### shape (invented sequence numbers, no real data). */
export function jobNumber(seq: number): string {
  return 'J' + String(seq).padStart(8, '0') + '-0000';
}

/** 14 older, completed jobs carrying the bulk of the 30 days of history. */
function fillerJobs(): DemoJob[] {
  const numbers = [4601, 4605, 4609, 4613, 4617, 4621, 4626, 4630, 4634, 4638, 4643, 4647, 4651, 4655];
  const qtys = [520, 380, 610, 450, 300, 760, 410, 540, 260, 680, 350, 470, 590, 320];
  return numbers.map((n, i) => {
    const start = 31 - i * 1.9;
    return {
      job_number: jobNumber(n),
      product_number: FILLER_PRODUCTS[i % 3]!,
      qty_released: qtys[i]!,
      start_days_ago: start,
      end_days_ago: Math.max(1.2, start - 7.5),
      progress: 1,
      status: 'Closed',
    };
  });
}

export const JOBS: DemoJob[] = [
  ...fillerJobs(),
  {
    job_number: 'J00004673-0000',
    product_number: 'PB-2200',
    qty_released: 600,
    start_days_ago: 12,
    end_days_ago: 2.5,
    progress: 1,
    status: 'Closed',
  },
  {
    job_number: 'J00004681-0000',
    product_number: 'IO-410',
    qty_released: 450,
    start_days_ago: 9,
    end_days_ago: 1.3,
    progress: 1,
    status: 'Closed',
  },
  {
    job_number: 'J00004690-0000',
    product_number: 'PS-900',
    qty_released: 800,
    start_days_ago: 2.5,
    end_days_ago: null,
    progress: 0.15,
    status: 'In Process',
  },
  {
    job_number: VISITOR_HOME_JOB,
    product_number: 'IO-410',
    qty_released: 800,
    start_days_ago: 1.2,
    end_days_ago: null,
    progress: 0.08,
    status: 'In Process',
  },
  {
    job_number: SECONDARY_JOB,
    product_number: 'PB-2200',
    qty_released: 400,
    start_days_ago: 5,
    end_days_ago: null,
    progress: 0.38,
    status: 'In Process',
  },
  {
    job_number: FEATURED_JOB,
    product_number: 'PB-2200',
    qty_released: 800,
    start_days_ago: 1.6,
    end_days_ago: null,
    progress: 0.08,
    status: 'In Process',
  },
  {
    job_number: NEW_JOB,
    product_number: 'PS-900',
    qty_released: 600,
    start_days_ago: 0.55,
    end_days_ago: null,
    progress: 0.02,
    status: 'In Process',
  },
];

export const JOB_BY_NUMBER = new Map(JOBS.map((j) => [j.job_number, j]));

/** Work order DTOs. `qty_complete` is null on purpose so the derived path is exercised. */
export function buildWorkOrders(now: number): WorkOrder[] {
  const DAY = 86_400_000;
  return JOBS.map((j) => {
    const product = PRODUCT_BY_NUMBER.get(j.product_number)!;
    return {
      job_number: j.job_number,
      product_number: j.product_number,
      product_name: product.name,
      qty_released: j.qty_released,
      qty_complete: null,
      status: j.status,
      fl_created_at: Math.round(now - (j.start_days_ago + 1.5) * DAY),
      fl_modified_at: Math.round(now - (j.end_days_ago ?? 0) * DAY),
    };
  });
}

// ---------------------------------------------------------------------------
// Shifts and breaks (spec 12.3)
// ---------------------------------------------------------------------------

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const EFFECTIVE_FROM = '2026-01-01';

export const DAY_SHIFT_ID = 1;
export const NIGHT_SHIFT_ID = 2;

export function initialShifts(): ShiftDef[] {
  return [
    {
      id: DAY_SHIFT_ID,
      name: 'Day',
      start_local: '07:00',
      end_local: '19:00',
      days_of_week: [...ALL_DAYS],
      effective_from: EFFECTIVE_FROM,
      effective_to: null,
    },
    {
      id: NIGHT_SHIFT_ID,
      name: 'Night',
      start_local: '19:00',
      end_local: '07:00',
      days_of_week: [...ALL_DAYS],
      effective_from: EFFECTIVE_FROM,
      effective_to: null,
    },
  ];
}

export function initialBreaks(): BreakDef[] {
  const mk = (
    id: number,
    name: string,
    start_local: string,
    duration_minutes: number,
    shift_ids: number[],
  ): BreakDef => ({
    id,
    name,
    start_local,
    duration_minutes,
    days_of_week: [...ALL_DAYS],
    shift_ids,
    effective_from: EFFECTIVE_FROM,
    effective_to: null,
  });
  return [
    mk(1, 'Morning break', '09:30', 15, [DAY_SHIFT_ID]),
    mk(2, 'Lunch', '12:00', 30, [DAY_SHIFT_ID]),
    mk(3, 'Afternoon break', '14:00', 15, [DAY_SHIFT_ID]),
    mk(4, 'Evening break', '17:30', 15, [DAY_SHIFT_ID]),
    mk(5, 'Evening break', '21:30', 15, [NIGHT_SHIFT_ID]),
    mk(6, 'Night lunch', '00:00', 30, [NIGHT_SHIFT_ID]),
    mk(7, 'Early break', '02:00', 15, [NIGHT_SHIFT_ID]),
    mk(8, 'Morning break', '05:30', 15, [NIGHT_SHIFT_ID]),
  ];
}

// ---------------------------------------------------------------------------
// Canned admin content
// ---------------------------------------------------------------------------

export const DEMO_CONNECTION = {
  base_url: 'http://factorylogix.northbridge.local:6065/odata',
  username: 'dashboard_ro',
  has_password: true,
};

export function initialUsers(now: number): User[] {
  const DAY = 86_400_000;
  return [
    {
      id: 1,
      username: 'demo',
      role: 'admin',
      active: true,
      created_at: Math.round(now - 210 * DAY),
      last_login_at: Math.round(now - 3 * 60_000),
    },
    {
      id: 2,
      username: 'kpatterson',
      role: 'manager',
      active: true,
      created_at: Math.round(now - 180 * DAY),
      last_login_at: Math.round(now - 5 * 3_600_000),
    },
    {
      id: 3,
      username: 'floorlead',
      role: 'viewer',
      active: true,
      created_at: Math.round(now - 96 * DAY),
      last_login_at: Math.round(now - 26 * 3_600_000),
    },
  ];
}

function field(
  name: string,
  edm_type: string,
  kind: 'string' | 'number' | 'timestamp' | 'boolean' | 'other',
  nullable = true,
): { name: string; edm_type: string; kind: 'string' | 'number' | 'timestamp' | 'boolean' | 'other'; nullable: boolean } {
  return { name, edm_type, kind, nullable };
}

/** Canned `$metadata` for the mapping wizard and the connection test. */
export function demoMetadata(now: number): ODataMetadata {
  return {
    version: '4.0',
    fetched_at: now,
    entity_sets: [
      {
        name: 'WorkOrders',
        entity_type: 'Northbridge.FactoryLogix.WorkOrder',
        fields: [
          field('WorkOrderNumber', 'Edm.String', 'string', false),
          field('PartNumber', 'Edm.String', 'string', false),
          field('PartDescription', 'Edm.String', 'string'),
          field('QuantityReleased', 'Edm.Int32', 'number', false),
          field('QuantityComplete', 'Edm.Int32', 'number'),
          field('Status', 'Edm.String', 'string'),
          field('CreatedDate', 'Edm.DateTimeOffset', 'timestamp'),
          field('ModifiedDate', 'Edm.DateTimeOffset', 'timestamp'),
          field('PlannedStartDate', 'Edm.DateTimeOffset', 'timestamp'),
          field('LineName', 'Edm.String', 'string'),
        ],
      },
      {
        name: 'UnitProcessHistory',
        entity_type: 'Northbridge.FactoryLogix.UnitProcessHistory',
        fields: [
          field('UnitSerial', 'Edm.String', 'string', false),
          field('WorkOrderNumber', 'Edm.String', 'string', false),
          field('PartNumber', 'Edm.String', 'string'),
          field('OperationName', 'Edm.String', 'string', false),
          field('OperationSequence', 'Edm.Int32', 'number'),
          field('OperatorName', 'Edm.String', 'string', false),
          field('StartedDate', 'Edm.DateTimeOffset', 'timestamp', false),
          field('CompletedDate', 'Edm.DateTimeOffset', 'timestamp'),
          field('Result', 'Edm.String', 'string'),
          field('StationName', 'Edm.String', 'string'),
          field('ProcessId', 'Edm.Guid', 'string'),
        ],
      },
      {
        name: 'Defects',
        entity_type: 'Northbridge.FactoryLogix.Defect',
        fields: [
          field('DefectId', 'Edm.Guid', 'string', false),
          field('UnitSerial', 'Edm.String', 'string', false),
          field('WorkOrderNumber', 'Edm.String', 'string', false),
          field('OperationName', 'Edm.String', 'string', false),
          field('OperatorName', 'Edm.String', 'string'),
          field('DefectCode', 'Edm.String', 'string'),
          field('DefectDescription', 'Edm.String', 'string'),
          field('FoundDate', 'Edm.DateTimeOffset', 'timestamp', false),
          field('Status', 'Edm.String', 'string'),
          field('ModifiedDate', 'Edm.DateTimeOffset', 'timestamp'),
        ],
      },
      {
        name: 'Users',
        entity_type: 'Northbridge.FactoryLogix.User',
        fields: [
          field('UserName', 'Edm.String', 'string', false),
          field('DisplayName', 'Edm.String', 'string'),
          field('IsActive', 'Edm.Boolean', 'boolean'),
          field('Department', 'Edm.String', 'string'),
        ],
      },
      {
        name: 'ProductRoutes',
        entity_type: 'Northbridge.FactoryLogix.ProductRoute',
        fields: [
          field('PartNumber', 'Edm.String', 'string', false),
          field('OperationName', 'Edm.String', 'string', false),
          field('Sequence', 'Edm.Int32', 'number', false),
          field('ProcessName', 'Edm.String', 'string'),
        ],
      },
      {
        name: 'ProductStandards',
        entity_type: 'Northbridge.FactoryLogix.ProductStandard',
        fields: [
          field('PartNumber', 'Edm.String', 'string', false),
          field('OperationName', 'Edm.String', 'string', false),
          field('StandardUnitsPerHour', 'Edm.Double', 'number'),
          field('EffectiveDate', 'Edm.DateTimeOffset', 'timestamp'),
        ],
      },
    ],
  };
}

export function demoSyncLog(now: number): SyncLogEntry[] {
  const MIN = 60_000;
  const rows: SyncLogEntry[] = [];
  const sources = ['unit_steps', 'work_orders', 'defects', 'unit_steps', 'unit_steps'];
  let id = 480;
  for (let i = 0; i < 12; i++) {
    const started = Math.round(now - (i * 1.5 + 0.4) * MIN);
    const source = sources[i % sources.length]!;
    const failed = i === 4;
    rows.push({
      id: id--,
      source,
      started_at: started,
      finished_at: started + (failed ? 20_100 : 900 + i * 37),
      rows: failed ? null : source === 'unit_steps' ? 40 + i * 7 : i % 3,
      status: failed ? 'error' : 'ok',
      error: failed ? 'Request timed out after 20000 ms (retrying with backoff)' : null,
    });
  }
  return rows;
}
