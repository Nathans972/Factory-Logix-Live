import { z } from 'zod';
import { DATASET_SPECS } from './mapping.js';

export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const daysOfWeekSchema = z.array(z.number().int().min(0).max(6)).min(1);

export const ianaTimeZoneSchema = z.string().min(1).refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid IANA time zone' },
);

export const settingsSchema = z.object({
  plant_name: z.string().max(120).nullable(),
  plant_timezone: ianaTimeZoneSchema,
  fl_timestamp_mode: z.enum(['offset_present', 'utc', 'local_no_offset']),
  poll_interval_seconds: z.number().int().min(30).max(600),
  poll_page_size: z.number().int().min(50).max(5000),
  poll_overlap_minutes: z.number().int().min(0).max(240),
  late_data_hours: z.number().int().min(0).max(168),
  odata_timeout_seconds: z.number().int().min(5).max(300),
  breaker_failure_threshold: z.number().int().min(1).max(20),
  breaker_max_backoff_minutes: z.number().int().min(1).max(120),
  backfill_days: z.number().int().min(0).max(3650),
  backfill_pause_seconds: z.number().int().min(0).max(600),
  backfill_window: z.object({ start: localTimeSchema, end: localTimeSchema }),
  eligibility_minutes: z.number().min(0).max(60),
  neutral_minutes: z.number().min(0).max(60),
  idle_timeout_minutes: z.number().min(1).max(480),
  count_work_during_breaks: z.boolean(),
  color_red_below: z.number().min(0).max(2),
  color_yellow_below: z.number().min(0).max(2),
  color_blue_above: z.number().min(0).max(3),
  std_lookback_days: z.number().int().min(1).max(3650),
  std_min_units: z.number().int().min(1),
  std_min_operators: z.number().int().min(1),
  std_max_unit_minutes: z.number().min(1),
  session_gap_minutes: z.number().min(0),
  std_recompute_time: localTimeSchema,
  floor_idle_flag_minutes: z.number().min(1),
  retention_days_raw_events: z.number().int().min(1).nullable(),
});

export const settingsPatchSchema = settingsSchema.partial();

export const datasetMappingSchema = z.object({
  entity_set: z.string().min(1),
  watermark_field: z.string().min(1).nullable(),
  key: z.array(z.string().min(1)).min(1),
  fields: z.record(z.string().min(1).nullable()),
});

export const mappingConfigSchema = z
  .object({
    work_orders: datasetMappingSchema,
    unit_steps: datasetMappingSchema,
    defects: datasetMappingSchema.nullable(),
    operators: datasetMappingSchema.nullable(),
    routes: datasetMappingSchema.nullable(),
    standards: datasetMappingSchema.nullable(),
  })
  .superRefine((m, ctx) => {
    for (const spec of DATASET_SPECS) {
      const ds = (m as Record<string, unknown>)[spec.name] as z.infer<typeof datasetMappingSchema> | null;
      if (!ds) {
        if (spec.required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${spec.name} mapping is required`, path: [spec.name] });
        continue;
      }
      for (const f of spec.fields) {
        if (f.required && !ds.fields[f.name]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${spec.name}.${f.name} is required`, path: [spec.name, 'fields', f.name] });
        }
      }
    }
  });

export const shiftWriteSchema = z.object({
  name: z.string().min(1).max(80),
  start_local: localTimeSchema,
  end_local: localTimeSchema,
  days_of_week: daysOfWeekSchema,
  effective_from: localDateSchema,
  effective_to: localDateSchema.nullable(),
});

export const breakWriteSchema = z.object({
  name: z.string().min(1).max(80),
  start_local: localTimeSchema,
  duration_minutes: z.number().int().min(1).max(480),
  days_of_week: daysOfWeekSchema,
  shift_ids: z.array(z.number().int()).nullable(),
  effective_from: localDateSchema,
  effective_to: localDateSchema.nullable(),
});

export const claimDisplaySchema = z.object({
  pairing_code: z.string().regex(/^\d{4}$/),
  name: z.string().min(1).max(80),
  job_number: z.string().min(1).nullable().optional(),
  group_operators: z.boolean().optional(),
  show_std_day: z.boolean().optional(),
  show_gauge: z.boolean().optional(),
  shift_length_hours: z.number().min(1).max(24).optional(),
});

export const updateDisplaySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  job_number: z.string().min(1).nullable().optional(),
  group_operators: z.boolean().optional(),
  show_std_day: z.boolean().optional(),
  show_gauge: z.boolean().optional(),
  shift_length_hours: z.number().min(1).max(24).optional(),
});

export const repairDisplaySchema = z.object({ pairing_code: z.string().regex(/^\d{4}$/) });

export const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const passwordSchema = z.string().min(8).max(200);

export const createUserSchema = z.object({
  username: z.string().min(2).max(60).regex(/^[a-zA-Z0-9._@-]+$/),
  password: passwordSchema,
  role: z.enum(['admin', 'manager', 'viewer']),
});

export const updateUserSchema = z.object({
  role: z.enum(['admin', 'manager', 'viewer']).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

export const createAdjustmentSchema = z
  .object({
    scope: z.enum(['global', 'product', 'operation', 'product_operation']),
    product_number: z.string().min(1).nullable().optional(),
    operation: z.string().min(1).nullable().optional(),
    percent: z.number().min(-90).max(300),
    note: z.string().min(1).max(500),
  })
  .superRefine((a, ctx) => {
    if ((a.scope === 'product' || a.scope === 'product_operation') && !a.product_number)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'product_number required', path: ['product_number'] });
    if ((a.scope === 'operation' || a.scope === 'product_operation') && !a.operation)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operation required', path: ['operation'] });
  });

export const createOverrideSchema = z
  .object({
    scope: z.enum(['product', 'product_operation']),
    product_number: z.string().min(1),
    operation: z.string().min(1).nullable().optional(),
    std_hr: z.number().positive().max(100000),
    note: z.string().min(1).max(500),
  })
  .superRefine((o, ctx) => {
    if (o.scope === 'product_operation' && !o.operation)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operation required', path: ['operation'] });
  });

export const createPinSchema = z.object({
  operator_id: z.string().min(1),
  job_number: z.string().min(1),
  operation: z.string().min(1).nullable().optional(),
  mode: z.enum(['force_eligible', 'force_visitor']),
  expires_at: z.number().nullable().optional(),
});

export const connectionWriteSchema = z.object({
  base_url: z.string().url(),
  username: z.string().min(1),
  password: z.string().optional(),
});

export const setupAdminSchema = z.object({
  username: z.string().min(2).max(60).regex(/^[a-zA-Z0-9._@-]+$/),
  password: passwordSchema,
});

export const tvRegisterSchema = z.object({ device_token: z.string().uuid() });
