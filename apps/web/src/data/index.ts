import type { DataSource } from './DataSource';
import { ApiDataSource } from './api/ApiDataSource';
import { MockDataSource } from './mock/MockDataSource';

export const IS_MOCK = import.meta.env.VITE_DATA_SOURCE === 'mock';

/** Chosen once at startup (spec 12.2). */
export function createDataSource(): DataSource {
  if (IS_MOCK) return new MockDataSource();
  return new ApiDataSource('/api');
}

export type { DataSource } from './DataSource';
export { DataSourceError } from './DataSource';
