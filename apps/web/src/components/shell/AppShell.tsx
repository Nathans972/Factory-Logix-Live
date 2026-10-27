/**
 * The shell around every signed-in page (docs/DESIGN.md, principle 2): 56 px top bar + 232 px
 * rail + routed page. Production pages get the production rail; the Settings area (/admin/*)
 * gets its own rail with a way back. The top-bar menu button collapses the rail on desktop
 * and slides it in over the page on narrow screens.
 */
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import '../../styles/portal.css';
import '../../styles/admin.css';

/** Keep in step with the breakpoint in global.css ("2. app shell"). */
const NARROW = '(max-width: 900px)';

function isNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
}

export interface AppShellProps {
  /** which area the routed page belongs to; picks the rail and sets the `data-section` hook */
  section: 'portal' | 'admin';
}

export function AppShell({ section }: AppShellProps) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // A link in the slide-in rail was followed: put the rail away.
  useEffect(() => setMobileOpen(false), [pathname]);

  const toggle = () => (isNarrow() ? setMobileOpen((o) => !o) : setCollapsed((c) => !c));

  const cls = `app-shell${collapsed ? ' rail-collapsed' : ''}${mobileOpen ? ' rail-open' : ''}`;
  return (
    <div className={cls} data-section={section}>
      <TopBar onMenu={toggle} />
      <Rail variant={section === 'admin' ? 'settings' : 'production'} />
      {mobileOpen && <div className="rail-scrim" onClick={() => setMobileOpen(false)} />}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
