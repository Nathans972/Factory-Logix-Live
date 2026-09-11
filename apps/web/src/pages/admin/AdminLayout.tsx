/** Admin area shell (spec 10). Administration is a rail group inside the one shell, not a
    separate app; per-page manager/admin gating stays inside the admin pages. */
import { AppShell } from '../../components/shell/AppShell';

export function AdminLayout() {
  return <AppShell section="admin" />;
}
