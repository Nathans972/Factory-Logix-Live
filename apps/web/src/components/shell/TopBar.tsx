/**
 * Application top bar (docs/DESIGN.md, principle 2): brand, plant name, global search,
 * freshness pill and the user menu. 56 px tall, sticky, on every portal and admin page.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../data/DataSourceContext';
import { useAuth } from '../../auth/AuthContext';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { initials } from '../../ui';
import { FreshnessPill } from './FreshnessPill';

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function TopBar() {
  const ds = useDataSource();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Close the user menu on Escape or a click outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

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
      <Link to="/" className="topbar-brand">
        <span className="brand-tile">FL</span>
        FactoryLogix Live
      </Link>

      {health?.plant_name ? <div className="topbar-plant">{health.plant_name}</div> : null}

      <form className="topbar-search" onSubmit={onSearch} role="search">
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search jobs, operators, products…"
          aria-label="Search"
        />
        <kbd>Ctrl K</kbd>
      </form>

      <div className="topbar-spacer" />

      <FreshnessPill />

      <div className="user-menu" ref={menuRef}>
        <button
          type="button"
          className="avatar"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={user?.username ?? 'Account'}
        >
          {initials(user?.username ?? '?')}
        </button>
        {menuOpen && (
          <div className="menu" role="menu">
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
          </div>
        )}
      </div>
    </header>
  );
}
