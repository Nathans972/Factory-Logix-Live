/**
 * The one shell used by every portal and admin page (docs/DESIGN.md, principle 2):
 * 56 px top bar + 232 px rail + routed page. Admin is a rail group, not a separate app.
 */
import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import '../../styles/portal.css';
import '../../styles/admin.css';

export interface AppShellProps {
  /** which area the routed page belongs to; used for the `data-section` hook */
  section: 'portal' | 'admin';
}

export function AppShell({ section }: AppShellProps) {
  return (
    <div className="app-shell" data-section={section}>
      <TopBar />
      <Rail />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
