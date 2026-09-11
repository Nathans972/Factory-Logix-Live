/**
 * Placeholder for the scheduled-template-export fallback (spec 4.2).
 * The abstraction exists in v1; the implementation does not.
 */
import type { ODataMetadata } from '@fld/shared';
import type { LiteralValue } from '../odata/literals.js';
import type { Source, SourcePage, SourceRequest } from './Source.js';

const NOT_IMPLEMENTED = 'FileDropSource is not implemented in v1';

export interface FileDropSourceOptions {
  directory: string;
}

export class FileDropSource implements Source {
  readonly kind = 'filedrop' as const;
  readonly directory: string;

  constructor(opts: FileDropSourceOptions) {
    this.directory = opts.directory;
  }

  async init(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  getMetadata(): ODataMetadata | null {
    return null;
  }

  version(): string | null {
    return null;
  }

  edmType(): string | null {
    return null;
  }

  literal(_entitySet: string, _field: string, _value: LiteralValue): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  describe(_req: SourceRequest): string {
    return `filedrop:${this.directory}`;
  }

  async fetchPage(_req: SourceRequest): Promise<SourcePage> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}
