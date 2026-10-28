/**
 * Minimal OData client (spec 4.1): Basic auth, $filter/$orderby/$top/$skip/$select,
 * hard request timeout, tolerant response parsing (v4 `value`, v2/v3 `d.results` / `d`)
 * and `@odata.nextLink` / `__next` server-driven paging.
 */
import http from 'node:http';
import https from 'node:https';
import { describeFetchError, type ODataMetadata } from '@fld/shared';
import { parseEdmx } from './metadata.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch`, but it also reaches the ports fetch turns down. Node's fetch keeps the Fetch standard's "bad port"
 * list (1, 5060, 6000, 6665-6669, 10080 and about 70 more, a browser's guard against cross-protocol requests)
 * and rejects them at once with "fetch failed", cause "bad port", without connecting: a FactoryLogix on one
 * could never be polled, and one that is down there would never read as refused. Those requests go out
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

export interface ODataClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutSeconds: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

export class ODataError extends Error {
  readonly status: number | null;
  readonly isTimeout: boolean;
  readonly isAuth: boolean;
  readonly url: string;
  readonly body: string | null;

  constructor(message: string, opts: { status?: number | null; isTimeout?: boolean; url: string; body?: string | null; cause?: unknown }) {
    super(message);
    this.name = 'ODataError';
    this.status = opts.status ?? null;
    this.isTimeout = opts.isTimeout ?? false;
    this.isAuth = this.status === 401 || this.status === 403;
    this.url = opts.url;
    this.body = opts.body ?? null;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export interface QueryParams {
  filter?: string | null;
  orderby?: string | null;
  top?: number | null;
  skip?: number | null;
  select?: string[] | null;
  count?: boolean;
}

export interface ODataPage {
  rows: Record<string, unknown>[];
  nextLink: string | null;
}

/** encodeURIComponent, but keep commas readable inside $select/$orderby. */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/%2C/g, ',');
}

export function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  if (params.filter) parts.push(`$filter=${enc(params.filter)}`);
  if (params.orderby) parts.push(`$orderby=${enc(params.orderby)}`);
  if (params.top !== null && params.top !== undefined) parts.push(`$top=${params.top}`);
  if (params.skip) parts.push(`$skip=${params.skip}`);
  if (params.select && params.select.length > 0) parts.push(`$select=${enc(params.select.join(','))}`);
  if (params.count) parts.push('$count=true');
  return parts.join('&');
}

export function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.value)) return obj.value as Record<string, unknown>[];
  const d = obj.d;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === 'object') {
    const results = (d as Record<string, unknown>).results;
    if (Array.isArray(results)) return results as Record<string, unknown>[];
    return [d as Record<string, unknown>];
  }
  return [];
}

export function extractNextLink(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const v4 = obj['@odata.nextLink'] ?? obj['odata.nextLink'];
  if (typeof v4 === 'string' && v4.length > 0) return v4;
  const d = obj.d;
  if (d && typeof d === 'object') {
    const next = (d as Record<string, unknown>).__next;
    if (typeof next === 'string' && next.length > 0) return next;
  }
  return null;
}

export class ODataClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private metadataCache: ODataMetadata | null = null;
  timeoutSeconds: number;

  constructor(opts: ODataClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')}`;
    this.timeoutSeconds = opts.timeoutSeconds;
    this.fetchImpl = opts.fetchImpl ?? fetchAnyPort;
    this.userAgent = opts.userAgent ?? 'fld-collector/1.0';
  }

  buildUrl(entitySet: string, params: QueryParams = {}): string {
    const qs = buildQueryString(params);
    const path = `${this.baseUrl}/${encodeURI(entitySet)}`;
    return qs ? `${path}?${qs}` : path;
  }

  /** Resolve an absolute or relative nextLink against the service root. */
  resolveLink(link: string): string {
    if (/^https?:\/\//i.test(link)) return link;
    try {
      return new URL(link, `${this.baseUrl}/`).toString();
    } catch {
      return `${this.baseUrl}/${link.replace(/^\/+/, '')}`;
    }
  }

  private async request(url: string, accept: string): Promise<{ text: string; contentType: string }> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: accept,
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(Math.max(1, this.timeoutSeconds) * 1000),
      });
      // Reading the body fails the same ways: undici's bare "terminated" when the connection drops
      // halfway, or the timeout firing while the answer is still coming in.
      text = await res.text();
    } catch (err) {
      const name = (err as Error)?.name ?? '';
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      throw new ODataError(
        timeout ? `OData request timed out after ${this.timeoutSeconds}s` : `OData request failed: ${describeFetchError(err)}`,
        { isTimeout: timeout, url, cause: err },
      );
    }
    if (!res.ok) {
      throw new ODataError(`OData request failed with HTTP ${res.status} ${res.statusText ?? ''}`.trim(), {
        status: res.status,
        url,
        body: text.slice(0, 500),
      });
    }
    return { text, contentType: res.headers?.get?.('content-type') ?? '' };
  }

  private async getJson(url: string): Promise<unknown> {
    const { text } = await this.request(url, 'application/json;odata.metadata=minimal');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ODataError('OData response was not JSON (is the URL the OData service root?)', { url, body: text.slice(0, 300) });
    }
  }

  async fetchPage(entitySet: string, params: QueryParams = {}): Promise<ODataPage> {
    const json = await this.getJson(this.buildUrl(entitySet, params));
    return { rows: extractRows(json), nextLink: extractNextLink(json) };
  }

  async fetchLink(link: string): Promise<ODataPage> {
    const json = await this.getJson(this.resolveLink(link));
    return { rows: extractRows(json), nextLink: extractNextLink(json) };
  }

  async fetchMetadata(force = false): Promise<ODataMetadata> {
    if (!force && this.metadataCache) return this.metadataCache;
    const url = `${this.baseUrl}/$metadata`;
    const { text } = await this.request(url, 'application/xml,application/xml;q=0.9,*/*;q=0.8');
    const metadata = parseEdmx(text);
    this.metadataCache = metadata;
    return metadata;
  }

  getCachedMetadata(): ODataMetadata | null {
    return this.metadataCache;
  }

  clearMetadataCache(): void {
    this.metadataCache = null;
  }
}
