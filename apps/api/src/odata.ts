/**
 * OData helpers: `$metadata` (EDMX) parsing, preview query building and the derived checks shown by
 * the mapping wizard (spec 10.7 step 4).
 */
import http from 'node:http';
import https from 'node:https';
import { localToUtc } from '@fld/engine';
import { XMLParser } from 'fast-xml-parser';
import {
  DATASET_SPECS,
  describeFetchError,
  edmTypeToKind,
  type DatasetMapping,
  type DatasetName,
  type FlTimestampMode,
  type MappingPreviewResult,
  type ODataEntityField,
  type ODataEntitySet,
  type ODataMetadata,
} from '@fld/shared';

// ---------------------------------------------------------------------------
// $metadata
// ---------------------------------------------------------------------------

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
});

// Parsed EDMX has no fixed shape; every read below is optional-chained and checked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlNode = Record<string, any>;

/** The `<edmx:Edmx>` root of a parsed document, or null when it is something else (an HTML page, an OData error, JSON). */
function edmxRoot(doc: XmlNode): XmlNode | null {
  const edmx: unknown = doc?.Edmx ?? doc?.['edmx:Edmx'];
  return edmx !== null && typeof edmx === 'object' ? (edmx as XmlNode) : null;
}

/** Parse an EDMX document into the entity sets + fields the mapping wizard needs. */
export function parseEdmx(xml: string, fetchedAt = Date.now()): ODataMetadata {
  return readEdmx(edmxRoot(parser.parse(xml) as XmlNode) ?? {}, fetchedAt);
}

function readEdmx(edmx: XmlNode, fetchedAt: number): ODataMetadata {
  const dataServices: XmlNode = edmx?.DataServices ?? {};
  const schemas = toArray<XmlNode>(dataServices?.Schema);

  const version: string | null =
    (edmx?.['@_Version'] as string | undefined) ??
    (dataServices?.['@_DataServiceVersion'] as string | undefined) ??
    (dataServices?.['@_MaxDataServiceVersion'] as string | undefined) ??
    null;

  // entity type (short name) -> fields
  const fieldsByType = new Map<string, ODataEntityField[]>();
  for (const schema of schemas) {
    for (const entityType of toArray<XmlNode>(schema?.EntityType)) {
      const typeName = String(entityType?.['@_Name'] ?? '');
      if (!typeName) continue;
      const fields: ODataEntityField[] = [];
      for (const prop of toArray<XmlNode>(entityType?.Property)) {
        const name = String(prop?.['@_Name'] ?? '');
        if (!name) continue;
        const edmType = String(prop?.['@_Type'] ?? 'Edm.String');
        const nullableAttr = prop?.['@_Nullable'];
        fields.push({
          name,
          edm_type: edmType,
          kind: edmTypeToKind(edmType),
          nullable: nullableAttr === undefined ? true : String(nullableAttr) !== 'false',
        });
      }
      fieldsByType.set(typeName, fields);
    }
  }

  const entitySets: ODataEntitySet[] = [];
  for (const schema of schemas) {
    for (const container of toArray<XmlNode>(schema?.EntityContainer)) {
      for (const set of toArray<XmlNode>(container?.EntitySet)) {
        const name = String(set?.['@_Name'] ?? '');
        if (!name) continue;
        const qualified = String(set?.['@_EntityType'] ?? '');
        const shortType = qualified.includes('.') ? qualified.slice(qualified.lastIndexOf('.') + 1) : qualified;
        entitySets.push({
          name,
          entity_type: qualified || shortType,
          fields: fieldsByType.get(shortType) ?? [],
        });
      }
    }
  }

  entitySets.sort((a, b) => a.name.localeCompare(b.name));
  return { version, entity_sets: entitySets, fetched_at: fetchedAt };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export interface ODataCredentials {
  base_url: string;
  username: string;
  password: string;
}

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  content_type: string | null;
  latency_ms: number;
}

/**
 * `fetch`, but it also reaches the ports fetch turns down. Node's fetch keeps the Fetch standard's "bad port"
 * list (1, 5060, 6000, 6665-6669, 10080 and about 70 more, a browser's guard against cross-protocol requests)
 * and rejects them at once with "fetch failed", cause "bad port", without connecting: a FactoryLogix on one
 * could never be reached, and one that is down there would never read as refused. Those requests go out
 * through node:http(s) instead (the GETs here have no body; a redirect is not followed and shows as its HTTP
 * status), and fail the way fetch does: with the signal's reason when it fires, else a "fetch failed" with
 * Node's error as `cause`, which describeFetchError reads.
 */
async function fetchAnyPort(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!(err instanceof TypeError) || (err.cause as Error | undefined)?.message !== 'bad port') throw err;
  }
  const signal = init.signal ?? undefined;
  try {
    const target = new URL(url);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      // The body is read as it comes, so ask for it without a content coding (fetch would undo one).
      const headers = { ...Object.fromEntries(new Headers(init.headers)), 'accept-encoding': 'identity' };
      const client = target.protocol === 'https:' ? https : http;
      const req = client.request(target, { method: init.method ?? 'GET', headers, signal }, resolve);
      req.on('error', reject);
      req.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    const status = res.statusCode ?? 0;
    // A Response with one of these statuses may not have a body, even an empty one.
    const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
    return new Response(body, { status, statusText: res.statusMessage, headers });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw new TypeError('fetch failed', { cause: err });
  }
}

async function request(url: string, creds: ODataCredentials, timeoutMs: number, accept: string): Promise<FetchResult<string>> {
  const started = Date.now();
  try {
    const res = await fetchAnyPort(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(creds.username, creds.password),
        Accept: accept,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type');
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 400)}` : ''}`,
        content_type: contentType,
        latency_ms: Date.now() - started,
      };
    }
    return { ok: true, status: res.status, data: text, error: null, content_type: contentType, latency_ms: Date.now() - started };
  } catch (err) {
    const message =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `request timed out after ${timeoutMs} ms`
        : describeFetchError(err);
    return { ok: false, status: 0, data: null, error: message, content_type: null, latency_ms: Date.now() - started };
  }
}

export async function fetchMetadata(
  creds: ODataCredentials,
  timeoutMs = 20_000,
): Promise<{ metadata: ODataMetadata | null; error: string | null; latency_ms: number }> {
  const res = await request(joinUrl(creds.base_url, '$metadata'), creds, timeoutMs, 'application/xml');
  if (!res.ok || !res.data) return { metadata: null, error: res.error ?? 'no response', latency_ms: res.latency_ms };
  try {
    // A login page, a web server's default page or an OData error document can answer 200 too.
    const edmx = edmxRoot(parser.parse(res.data) as XmlNode);
    if (!edmx) {
      const got = res.content_type?.split(';')[0].trim() || 'no Content-Type';
      return {
        metadata: null,
        error: `the address answered, but not with OData $metadata (got ${got}); check that it is the OData service root`,
        latency_ms: res.latency_ms,
      };
    }
    return { metadata: readEdmx(edmx, Date.now()), error: null, latency_ms: res.latency_ms };
  } catch (err) {
    return {
      metadata: null,
      error: `could not parse $metadata: ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: res.latency_ms,
    };
  }
}

/** OData v4 (`value`) and v3 (`d.results`) JSON payloads. */
export function extractRows(body: string): Record<string, unknown>[] {
  const parsed = JSON.parse(body) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj?.value)) return obj.value as Record<string, unknown>[];
  const d = obj?.d as Record<string, unknown> | undefined;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && Array.isArray(d.results)) return d.results as Record<string, unknown>[];
  return [];
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Target field used for ordering when the dataset has no watermark. */
export function primaryTimestampField(dataset: DatasetName, mapping: DatasetMapping): string | null {
  const f = mapping.fields ?? {};
  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const src = f[n];
      if (src) return src;
    }
    return null;
  };
  switch (dataset) {
    case 'unit_steps':
      return pick('complete_ts', 'start_ts', 'modified_at');
    case 'work_orders':
      return pick('modified_at', 'created_at');
    case 'defects':
      return pick('found_ts', 'modified_at');
    default:
      return pick('modified_at');
  }
}

export function selectedSourceFields(mapping: DatasetMapping): string[] {
  const out: string[] = [];
  for (const src of Object.values(mapping.fields ?? {})) {
    if (src && !out.includes(src)) out.push(src);
  }
  for (const key of mapping.key ?? []) {
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** `EntitySet?$select=...&$top=50&$orderby=<watermark|primary ts> desc` */
export function buildPreviewPath(dataset: DatasetName, mapping: DatasetMapping, top = 50): string {
  const select = selectedSourceFields(mapping);
  const params: string[] = [];
  if (select.length > 0) params.push(`$select=${select.join(',')}`);
  params.push(`$top=${top}`);
  const orderBy = mapping.watermark_field ?? primaryTimestampField(dataset, mapping);
  if (orderBy) params.push(`$orderby=${orderBy} desc`);
  return `${mapping.entity_set}?${params.join('&')}`;
}

export function buildPreviewUrl(baseUrl: string, dataset: DatasetName, mapping: DatasetMapping, top = 50): string {
  return joinUrl(baseUrl, buildPreviewPath(dataset, mapping, top));
}

/**
 * `fl_timestamp_mode` + plant zone (spec 5.5), so the checks read FactoryLogix timestamps the way the
 * collector does: an offset-less value is plant wall-clock time in `local_no_offset` mode, else UTC.
 */
export interface PreviewTimestampOptions {
  mode?: FlTimestampMode;
  timezone?: string;
}

const NAIVE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,7}))?)?)?$/;
const OFFSET_RE = /(?:Z|z|[+-]\d{2}:?\d{2})$/;

/** The instant an offset-less value names; `wallMs` is its wall-clock time counted as if it were UTC. */
function wallClockToUtc(wallMs: number, opts: PreviewTimestampOptions): number | null {
  if (opts.mode !== 'local_no_offset' || !opts.timezone) return wallMs;
  const d = new Date(wallMs);
  if (Number.isNaN(d.getTime())) return null;
  const local = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
  return localToUtc(opts.timezone, local) + d.getUTCMilliseconds();
}

function parseTs(value: unknown, opts: PreviewTimestampOptions): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const raw = String(value).trim();
  // OData v2/v3 "/Date(1700000000000)/"; with no offset the number is the wall clock counted as if it were UTC
  const legacy = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/.exec(raw);
  if (legacy) return legacy[2] ? Number(legacy[1]) : wallClockToUtc(Number(legacy[1]), opts);
  if (OFFSET_RE.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  // Not Date.parse: it reads an offset-less date-time in the API process's own zone.
  const naive = NAIVE_RE.exec(raw);
  if (naive) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', frac = ''] = naive;
    const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
    const wallMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms);
    return wallClockToUtc(wallMs, opts);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function pct(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Derived checks listed in `MappingPreviewResult.checks`. Pure, so it is unit-testable. */
export function computePreviewChecks(
  dataset: DatasetName,
  mapping: DatasetMapping,
  rows: Record<string, unknown>[],
  now: number,
  timestamps: PreviewTimestampOptions = {},
): MappingPreviewResult['checks'] {
  const warnings: string[] = [];
  const f = mapping.fields ?? {};
  const total = rows.length;

  const distinct = (sourceField: string | null | undefined): number | null => {
    if (!sourceField) return null;
    const set = new Set<string>();
    for (const row of rows) {
      const v = row[sourceField];
      if (isPresent(v)) set.add(String(v));
    }
    return set.size;
  };

  const distinct_jobs = distinct(f.job_number);
  const distinct_operators = dataset === 'unit_steps' || dataset === 'defects' ? distinct(f.operator) : null;

  let start_present_pct: number | null = null;
  let complete_present_pct: number | null = null;
  const sample_durations_minutes: number[] = [];

  if (dataset === 'unit_steps') {
    const startField = f.start_ts;
    const completeField = f.complete_ts;
    let startPresent = 0;
    let completePresent = 0;
    for (const row of rows) {
      const startRaw = startField ? row[startField] : null;
      const completeRaw = completeField ? row[completeField] : null;
      if (isPresent(startRaw)) startPresent += 1;
      if (isPresent(completeRaw)) completePresent += 1;
      const start = parseTs(startRaw, timestamps);
      const complete = parseTs(completeRaw, timestamps);
      if (start !== null && complete !== null && complete >= start && sample_durations_minutes.length < 20) {
        sample_durations_minutes.push(Math.round(((complete - start) / 60_000) * 100) / 100);
      }
    }
    start_present_pct = pct(startPresent, total);
    complete_present_pct = pct(completePresent, total);
    if (total > 0 && (complete_present_pct ?? 0) < 50) {
      warnings.push('fewer than half of the sampled rows have a complete timestamp');
    }
    if (total > 0 && (distinct_operators ?? 0) <= 1) {
      warnings.push('the sample contains at most one distinct operator; check the operator field');
    }
  }

  // Timestamp skew: max timestamp in the sample vs the server clock.
  const tsField = mapping.watermark_field ?? primaryTimestampField(dataset, mapping);
  let timestamp_skew_minutes: number | null = null;
  if (tsField) {
    let max: number | null = null;
    let unparsed = 0;
    for (const row of rows) {
      const v = row[tsField];
      if (!isPresent(v)) continue;
      const ms = parseTs(v, timestamps);
      if (ms === null) {
        unparsed += 1;
        continue;
      }
      if (max === null || ms > max) max = ms;
    }
    if (max !== null) timestamp_skew_minutes = Math.round(((now - max) / 60_000) * 10) / 10;
    if (unparsed > 0) warnings.push(`${unparsed} row(s) had an unparsable ${tsField} value`);
    if (timestamp_skew_minutes !== null && Math.abs(timestamp_skew_minutes) > 90) {
      warnings.push(
        `newest ${tsField} in the sample is ${timestamp_skew_minutes} minutes from the server clock; check the timestamp mode`,
      );
    }
  }

  if (total === 0) warnings.push('the query returned no rows');

  // Mapped source fields that never appear in the payload.
  if (total > 0) {
    const present = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) present.add(k);
    const spec = DATASET_SPECS.find((s) => s.name === dataset);
    for (const [target, source] of Object.entries(f)) {
      if (!source || present.has(source)) continue;
      const required = spec?.fields.find((x) => x.name === target)?.required ?? false;
      warnings.push(`${required ? 'required ' : ''}field ${target} -> ${source} is missing from the returned rows`);
    }
  }

  return {
    distinct_operators,
    distinct_jobs,
    start_present_pct,
    complete_present_pct,
    timestamp_skew_minutes,
    sample_durations_minutes,
    warnings,
  };
}

export async function runPreview(
  creds: ODataCredentials,
  dataset: DatasetName,
  mapping: DatasetMapping,
  timestamps: PreviewTimestampOptions,
  timeoutMs = 20_000,
  now = Date.now(),
): Promise<MappingPreviewResult> {
  const url = buildPreviewUrl(creds.base_url, dataset, mapping);
  const res = await request(url, creds, timeoutMs, 'application/json');
  if (!res.ok || !res.data) {
    return {
      dataset,
      ok: false,
      error: res.error ?? 'no response',
      query: url,
      rows: [],
      checks: {
        distinct_operators: null,
        distinct_jobs: null,
        start_present_pct: null,
        complete_present_pct: null,
        timestamp_skew_minutes: null,
        sample_durations_minutes: [],
        warnings: [],
      },
    };
  }
  let rows: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    rows = extractRows(res.data);
  } catch (err) {
    error = `could not parse the response as JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    dataset,
    ok: error === null,
    error,
    query: url,
    rows,
    checks: computePreviewChecks(dataset, mapping, rows, now, timestamps),
  };
}
