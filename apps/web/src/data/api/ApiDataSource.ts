// PLACEHOLDER — replaced by the web data-layer implementation (REST + SSE client per docs/API.md).
import type { DataSource } from '../DataSource';

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;
  constructor(public baseUrl: string) {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return (target as unknown as Record<PropertyKey, unknown>)[prop];
        return () => Promise.reject(new Error(`ApiDataSource.${String(prop)} not implemented`));
      },
    }) as unknown as ApiDataSource;
  }
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ApiDataSource extends DataSource {}
