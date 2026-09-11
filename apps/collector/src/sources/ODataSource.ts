/** OData implementation of the Source abstraction. */
import type { ODataMetadata } from '@fld/shared';
import { ODataClient, type FetchLike } from '../odata/client.js';
import { edmTypeOf } from '../odata/metadata.js';
import { formatLiteral, type LiteralValue } from '../odata/literals.js';
import type { Source, SourcePage, SourceRequest } from './Source.js';

const METADATA_TTL_MS = 6 * 60 * 60 * 1000;
/** Shorter retry when $metadata could not be read at all. */
const METADATA_RETRY_MS = 15 * 60 * 1000;

export interface ODataSourceOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutSeconds: number;
  fetchImpl?: FetchLike;
  /** Called once if $metadata cannot be read; the source then falls back to v4 literal syntax. */
  onMetadataError?: (err: unknown) => void;
}

export class ODataSource implements Source {
  readonly kind = 'odata' as const;
  private readonly client: ODataClient;
  private readonly onMetadataError?: (err: unknown) => void;
  private metadata: ODataMetadata | null = null;
  private metadataAt = 0;

  constructor(opts: ODataSourceOptions) {
    this.client = new ODataClient({
      baseUrl: opts.baseUrl,
      username: opts.username,
      password: opts.password,
      timeoutSeconds: opts.timeoutSeconds,
      fetchImpl: opts.fetchImpl,
    });
    this.onMetadataError = opts.onMetadataError;
  }

  setTimeoutSeconds(seconds: number): void {
    this.client.timeoutSeconds = seconds;
  }

  async init(force = false): Promise<void> {
    const age = Date.now() - this.metadataAt;
    const ttl = this.metadata ? METADATA_TTL_MS : METADATA_RETRY_MS;
    if (!force && this.metadataAt > 0 && age < ttl) return;
    try {
      this.metadata = await this.client.fetchMetadata(true);
    } catch (err) {
      // $metadata is an optimisation (EDM types for literals); polling still works without it.
      this.onMetadataError?.(err);
    } finally {
      this.metadataAt = Date.now();
    }
  }

  getMetadata(): ODataMetadata | null {
    return this.metadata;
  }

  version(): string | null {
    return this.metadata?.version ?? null;
  }

  edmType(entitySet: string, field: string): string | null {
    return edmTypeOf(this.metadata, entitySet, field);
  }

  literal(entitySet: string, field: string, value: LiteralValue): string {
    return formatLiteral(value, this.edmType(entitySet, field), this.version());
  }

  describe(req: SourceRequest): string {
    if (req.nextLink) return req.nextLink;
    return this.client.buildUrl(req.entitySet, {
      filter: req.filter ?? null,
      orderby: req.orderBy ?? null,
      top: req.top ?? null,
      skip: req.skip ?? null,
      select: req.select ?? null,
    });
  }

  async fetchPage(req: SourceRequest): Promise<SourcePage> {
    if (req.nextLink) return this.client.fetchLink(req.nextLink);
    return this.client.fetchPage(req.entitySet, {
      filter: req.filter ?? null,
      orderby: req.orderBy ?? null,
      top: req.top ?? null,
      skip: req.skip ?? null,
      select: req.select ?? null,
    });
  }

  async close(): Promise<void> {
    this.client.clearMetadataCache();
  }
}
