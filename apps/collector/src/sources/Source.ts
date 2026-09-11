/**
 * Pluggable data source abstraction (spec 4.2): the poller/backfill only know this interface,
 * so a FileDropSource (watch a folder, parse CSV/XLSX) can be added later without touching
 * anything downstream.
 */
import type { ODataMetadata } from '@fld/shared';
import type { LiteralValue } from '../odata/literals.js';

export interface SourcePage {
  rows: Record<string, unknown>[];
  /** Server-driven paging link; when present the caller must follow it instead of using $skip. */
  nextLink: string | null;
}

export interface SourceRequest {
  entitySet: string;
  filter?: string | null;
  orderBy?: string | null;
  select?: string[] | null;
  top?: number | null;
  skip?: number | null;
  /** Follow this link instead of building a query. */
  nextLink?: string | null;
}

export interface Source {
  readonly kind: 'odata' | 'filedrop';
  /** Prepare the source (fetch + cache $metadata). Must be safe to call repeatedly. */
  init(force?: boolean): Promise<void>;
  getMetadata(): ODataMetadata | null;
  /** Service version string ("4.0", "2.0", ...) or null when unknown. */
  version(): string | null;
  /** EDM type of a mapped field, or null when unknown. */
  edmType(entitySet: string, field: string): string | null;
  /** Format a value as a $filter literal using the field's EDM type. */
  literal(entitySet: string, field: string, value: LiteralValue): string;
  /** Describe a request for logging / preview. */
  describe(req: SourceRequest): string;
  fetchPage(req: SourceRequest): Promise<SourcePage>;
  close(): Promise<void>;
}
