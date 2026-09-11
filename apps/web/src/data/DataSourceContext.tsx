import { createContext, useContext, type ReactNode } from 'react';
import type { DataSource } from './DataSource';

const Ctx = createContext<DataSource | null>(null);

export function DataSourceProvider({ value, children }: { value: DataSource; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDataSource(): DataSource {
  const ds = useContext(Ctx);
  if (!ds) throw new Error('useDataSource must be used inside DataSourceProvider');
  return ds;
}
