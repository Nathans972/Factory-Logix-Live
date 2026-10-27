/**
 * Left navigation rail (docs/DESIGN.md, principle 2), styled like the company portal: a colored
 * header band, then the links, then Dark mode and the version pinned to the bottom.
 *
 * - `production`: Home plus a collapsible Production group (TV displays for manager+).
 * - `settings`: "← Back to production" plus only the Settings pages this user's role can open,
 *   so there are no lock icons — managers see Standards and Sync health, admins see everything.
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useDataSource } from '../../data/DataSourceContext';
import { useTheme } from '../../lib/theme';
import { usePlantTz } from '../../lib/usePlantTz';
import { Icon, type IconName } from './icons';
import { PRODUCTION_NAV, SETTINGS_NAV, visibleNav } from './nav';

const GROUP_KEY = 'fld_rail_production_open';

function readGroupOpen(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0';
  } catch {
    return true;
  }
}

function RailLink({ to, label, icon, end, sub }: { to: string; label: string; icon?: IconName; end?: boolean; sub?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `rail-link${sub ? ' rail-sub' : ''}${isActive ? ' active' : ''}`}>
      {icon && <Icon name={icon} />}
      {label}
    </NavLink>
  );
}

function RailFoot() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const { resolved, setTheme } = useTheme();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => ds.health(), refetchInterval: 60_000, staleTime: 55_000 });
  const version = health?.version && /^\d/.test(health.version) ? health.version : '1.0';
  const dark = resolved === 'dark';

  return (
    <div className="rail-foot">
      <button
        type="button"
        className="rail-link rail-theme"
        role="switch"
        aria-checked={dark}
        onClick={() => setTheme(dark ? 'light' : 'dark')}
      >
        <Icon name={dark ? 'sun' : 'moon'} />
        {dark ? 'Light mode' : 'Dark mode'}
      </button>
      <div className="rail-version">
        v{version} · {tz}
      </div>
    </div>
  );
}

export function Rail({ variant }: { variant: 'production' | 'settings' }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(readGroupOpen);

  const toggleGroup = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(GROUP_KEY, o ? '0' : '1');
      } catch {
        /* private mode: remember for this page only */
      }
      return !o;
    });
  };

  if (variant === 'settings') {
    return (
      <nav className="rail" aria-label="Settings">
        <div className="rail-band">Settings</div>
        <div className="rail-links">
          <RailLink to="/" label="Back to production" icon="arrow-left" end />
          <div className="rail-group">Settings</div>
          {visibleNav(SETTINGS_NAV, user).map((i) => (
            <RailLink key={i.to} to={i.to} label={i.label} icon={i.icon} />
          ))}
        </div>
        <RailFoot />
      </nav>
    );
  }

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-band">Production</div>
      <div className="rail-links">
        <RailLink to="/" label="Home" icon="home" end />
        <button type="button" className="rail-link rail-toggle" aria-expanded={open} onClick={toggleGroup}>
          <Icon name="factory" />
          Production
          <Icon name="chevron-down" className={`rail-chevron${open ? ' open' : ''}`} />
        </button>
        {open &&
          visibleNav(PRODUCTION_NAV, user).map((i) => <RailLink key={i.to} to={i.to} label={i.label} sub />)}
      </div>
      <RailFoot />
    </nav>
  );
}
