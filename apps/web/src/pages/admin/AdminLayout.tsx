/** Settings area shell (spec 10): reached from the top-bar gear, with its own rail and a way back
    to production. Per-page manager/admin gating stays inside the admin pages. */
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AppShell } from '../../components/shell/AppShell';
import { settingsHome } from '../../components/shell/nav';

export function AdminLayout() {
  return <AppShell section="admin" />;
}

/** `/admin` lands on the first Settings page the user can open (Displays for admins, Standards for managers). */
export function SettingsIndex() {
  const { user } = useAuth();
  return <Navigate to={settingsHome(user) ?? '/'} replace />;
}
