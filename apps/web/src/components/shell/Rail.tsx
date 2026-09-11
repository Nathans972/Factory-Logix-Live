/**
 * Left navigation rail (docs/DESIGN.md, principle 2): 232 px, two groups.
 * Administration is rendered for manager+ only; admin-only destinations show a lock
 * glyph for managers (the pages themselves still do the real gating).
 */
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';

type IconName =
  | 'shift'
  | 'floor'
  | 'jobs'
  | 'operators'
  | 'products'
  | 'displays'
  | 'shifts'
  | 'breaks'
  | 'connection'
  | 'mapping'
  | 'standards'
  | 'engine'
  | 'users'
  | 'sync'
  | 'audit';

const PATHS: Record<IconName, string> = {
  shift: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v4h-7zM3 13h7v8H3zM14 17h7v4h-7z',
  floor: 'M3 4h18v6H3zM3 14h8v6H3zM14 14h7v6h-7z',
  jobs: 'M4 4h12l4 4v12H4zM16 4v4h4',
  operators: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1',
  products: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  displays: 'M3 4h18v12H3zM9 20h6M12 16v4',
  shifts: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2',
  breaks: 'M4 9h13v5a5 5 0 01-5 5H9a5 5 0 01-5-5zM17 10h2a2.5 2.5 0 010 5h-2M6 3v2M10 3v2M14 3v2',
  connection: 'M9 7V4h6v3M8 7h8v5a4 4 0 01-8 0zM12 16v5',
  mapping: 'M3 5h6v4H3zM15 15h6v4h-6zM9 7h3a2 2 0 012 2v8',
  standards: 'M3 9h18v6H3zM7 9v3M11 9v3M15 9v3M19 9v3',
  engine: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4',
  users: 'M9 12a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20v-1a5 5 0 015-5h4a5 5 0 015 5v1M17 6.2a3.5 3.5 0 010 6.6M18 14h1a4 4 0 014 4v2',
  sync: 'M3 12a9 9 0 0115-6.7L21 8M21 12a9 9 0 01-15 6.7L3 16M21 4v4h-4M3 20v-4h4',
  audit: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3',
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

function Lock() {
  return (
    <svg className="lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  );
}

interface Item {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /** admin-only destinations show a lock for managers */
  adminOnly?: boolean;
}

const OPERATIONS: Item[] = [
  { to: '/', label: 'Shift view', icon: 'shift', end: true },
  { to: '/floor', label: 'Floor', icon: 'floor' },
  { to: '/jobs', label: 'Jobs', icon: 'jobs' },
  { to: '/operators', label: 'Operators', icon: 'operators' },
  { to: '/products', label: 'Products', icon: 'products' },
];

const ADMINISTRATION: Item[] = [
  { to: '/admin/displays', label: 'Displays', icon: 'displays', adminOnly: true },
  { to: '/admin/shifts', label: 'Shifts', icon: 'shifts', adminOnly: true },
  { to: '/admin/breaks', label: 'Breaks', icon: 'breaks', adminOnly: true },
  { to: '/admin/connection', label: 'FactoryLogix', icon: 'connection', adminOnly: true },
  { to: '/admin/mapping', label: 'Mapping', icon: 'mapping', adminOnly: true },
  { to: '/admin/standards', label: 'Standards', icon: 'standards' },
  { to: '/admin/engine', label: 'Engine', icon: 'engine', adminOnly: true },
  { to: '/admin/users', label: 'Users', icon: 'users', adminOnly: true },
  { to: '/admin/sync', label: 'Sync health', icon: 'sync' },
  { to: '/admin/audit', label: 'Audit', icon: 'audit', adminOnly: true },
];

function RailLink({ item, locked }: { item: Item; locked: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}
      title={locked ? 'Admin role required' : undefined}
    >
      <Icon name={item.icon} />
      {item.label}
      {locked && <Lock />}
    </NavLink>
  );
}

export function Rail() {
  const { user } = useAuth();
  const ds = useDataSource();
  const tz = usePlantTz();
  const isManager = hasRole(user, 'manager');
  const isAdmin = hasRole(user, 'admin');
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => ds.health(), refetchInterval: 60_000, staleTime: 55_000 });
  const version = health?.version && /^\d/.test(health.version) ? health.version : '1.0';

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-group">Operations</div>
      {OPERATIONS.map((i) => (
        <RailLink key={i.to} item={i} locked={false} />
      ))}

      {isManager && (
        <>
          <div className="rail-group">Administration</div>
          {ADMINISTRATION.map((i) => (
            <RailLink key={i.to} item={i} locked={!isAdmin && !!i.adminOnly} />
          ))}
        </>
      )}

      <div className="rail-foot">
        v{version} · {tz}
      </div>
    </nav>
  );
}
