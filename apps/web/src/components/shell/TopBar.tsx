/**
 * Application top bar (docs/DESIGN.md, principle 2), laid out like the company portal:
 * menu button and brand on the left, search centered, then the freshness pill, help, the
 * Settings gear (manager+) and the user menu (avatar + name). 56 px tall, sticky.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../data/DataSourceContext';
import { useAuth } from '../../auth/AuthContext';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { initials } from '../../ui';
import { FreshnessPill } from './FreshnessPill';
import { Icon } from './icons';
import { settingsHome } from './nav';

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Closes a popover menu on Escape or a click outside `ref`. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, ref, setOpen]);
}

function Popover({ open, children }: { open: boolean; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="menu" role="menu">
      {children}
    </div>
  );
}

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const ds = useDataSource();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const settingsTo = settingsHome(user);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => ds.health(),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  // Ctrl/Cmd+K focuses the search box from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useDismiss(menuOpen, menuRef, setMenuOpen);
  useDismiss(helpOpen, helpRef, setHelpOpen);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    navigate(text ? `/jobs?q=${encodeURIComponent(text)}` : '/jobs');
    searchRef.current?.blur();
  };

  const onLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="icon-btn" onClick={onMenu} aria-label="Toggle navigation" title="Menu">
          <Icon name="menu" size={20} />
        </button>
        <Link to="/" className="topbar-brand">
          <span className="brand-tile">FL</span>
          <span className="brand-text">
            FactoryLogix Live
            {health?.plant_name ? <span className="topbar-plant">{health.plant_name}</span> : null}
          </span>
        </Link>
      </div>

      <form className="topbar-search" onSubmit={onSearch} role="search">
        <Icon name="search" />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search jobs, operators, products…"
          aria-label="Search"
        />
        <kbd>Ctrl K</kbd>
      </form>

      <div className="topbar-right">
        <FreshnessPill />

        <div className="user-menu" ref={helpRef}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setHelpOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={helpOpen}
            aria-label="Help"
            title="Help"
          >
            <Icon name="help" size={20} />
          </button>
          <Popover open={helpOpen}>
            <div className="menu-label">Help</div>
            <div className="menu-text">
              Press <kbd>Ctrl K</kbd> to search jobs, operators and products.
            </div>
            <div className="menu-text">Start from Home: every page is one click away.</div>
            <div className="menu-sep" />
            <a className="menu-item" role="menuitem" href={`${import.meta.env.BASE_URL}tv`} target="_blank" rel="noreferrer">
              Open a TV page in a new tab
            </a>
          </Popover>
        </div>

        {settingsTo && (
          <Link
            to={settingsTo}
            className={`icon-btn${pathname.startsWith('/admin') ? ' on' : ''}`}
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="gear" size={20} />
          </Link>
        )}

        <div className="user-menu" ref={menuRef}>
          <button
            type="button"
            className="user-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={user?.username ?? 'Account'}
          >
            <span className="avatar">{initials(user?.username ?? '?')}</span>
            <span className="user-name">{user?.username ?? 'Account'}</span>
            <Icon name="chevron-down" size={14} />
          </button>
          <Popover open={menuOpen}>
            <div className="menu-head">
              <div className="who">{user?.username ?? 'Not signed in'}</div>
              <div className="role">{user?.role ?? ''}</div>
            </div>
            <div className="menu-label">Theme</div>
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === t.value}
                className={`menu-item${theme === t.value ? ' on' : ''}`}
                onClick={() => setTheme(t.value)}
              >
                {t.label}
              </button>
            ))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={() => void onLogout()}>
              Log out
            </button>
          </Popover>
        </div>
      </div>
    </header>
  );
}
