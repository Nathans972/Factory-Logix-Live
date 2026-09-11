import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Role, User } from '@fld/shared';
import { useDataSource } from '../data/DataSourceContext';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, manager: 2, admin: 3 };

export function hasRole(user: User | null | undefined, min: Role): boolean {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[min];
}

interface AuthState {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const ds = useDataSource();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [me, setup] = await Promise.all([ds.me(), ds.setupStatus().catch(() => ({ needs_setup: false }))]);
      setUser(me.user);
      setNeedsSetup(setup.needs_setup);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [ds]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const me = await ds.login({ username, password });
      if (!me.user) throw new Error('Login failed');
      setUser(me.user);
      setNeedsSetup(false);
      return me.user;
    },
    [ds],
  );

  const logout = useCallback(async () => {
    await ds.logout();
    setUser(null);
  }, [ds]);

  const value = useMemo(() => ({ user, loading, needsSetup, login, logout, refresh }), [user, loading, needsSetup, login, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
