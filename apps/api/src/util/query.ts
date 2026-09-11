import type { ZodTypeAny, z } from 'zod';
import { badRequest } from '../errors.js';

export function parseWith<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest('validation failed', result.error.issues);
  return result.data;
}

export function qStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(Array.isArray(value) ? value[0] : value).trim();
  return s.length > 0 ? s : null;
}

export function qBool(value: unknown, fallback = false): boolean {
  const s = qStr(value);
  if (s === null) return fallback;
  return s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'yes';
}

export function qNum(value: unknown): number | null {
  const s = qStr(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function qInt(value: unknown, opts: { min?: number; max?: number; fallback?: number } = {}): number | null {
  const n = qNum(value);
  if (n === null) return opts.fallback ?? null;
  let out = Math.trunc(n);
  if (opts.min !== undefined) out = Math.max(opts.min, out);
  if (opts.max !== undefined) out = Math.min(opts.max, out);
  return out;
}

export function requireIdParam(value: unknown, what = 'id'): number {
  const n = qNum(value);
  if (n === null || !Number.isInteger(n) || n <= 0) throw badRequest(`invalid ${what}`);
  return n;
}
