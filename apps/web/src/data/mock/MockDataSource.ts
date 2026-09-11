// PLACEHOLDER — replaced by the in-browser simulator + engine implementation (spec section 12).
import type { DataSource } from '../DataSource';

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return (target as unknown as Record<PropertyKey, unknown>)[prop];
        return () => Promise.reject(new Error(`MockDataSource.${String(prop)} not implemented`));
      },
    }) as unknown as MockDataSource;
  }
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MockDataSource extends DataSource {}
