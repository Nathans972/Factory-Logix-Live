import { Navigate, Route, Routes } from 'react-router-dom';
import { TvPage } from './pages/tv/TvPage';
import { LoginPage } from './pages/auth/LoginPage';
import { SetupPage } from './pages/auth/SetupPage';
import { PortalLayout } from './pages/portal/PortalLayout';
import { HomePage } from './pages/portal/HomePage';
import { ShiftPage } from './pages/portal/ShiftPage';
import { TvJobsPage } from './pages/portal/TvJobsPage';
import { FloorPage } from './pages/portal/FloorPage';
import { OperatorsPage } from './pages/portal/OperatorsPage';
import { OperatorPage } from './pages/portal/OperatorPage';
import { JobsPage } from './pages/portal/JobsPage';
import { JobPage } from './pages/portal/JobPage';
import { ProductsPage } from './pages/portal/ProductsPage';
import { ProductPage } from './pages/portal/ProductPage';
import { AdminLayout, SettingsIndex } from './pages/admin/AdminLayout';
import { DisplaysPage } from './pages/admin/DisplaysPage';
import { ShiftsPage } from './pages/admin/ShiftsPage';
import { BreaksPage } from './pages/admin/BreaksPage';
import { ConnectionPage } from './pages/admin/ConnectionPage';
import { MappingPage } from './pages/admin/MappingPage';
import { StandardsPage } from './pages/admin/StandardsPage';
import { EnginePage } from './pages/admin/EnginePage';
import { UsersPage } from './pages/admin/UsersPage';
import { SyncPage } from './pages/admin/SyncPage';
import { AuditPage } from './pages/admin/AuditPage';
import { RequireAuth } from './auth/RequireAuth';
import { DemoBadge } from './ui/DemoBadge';

/**
 * Route map (spec 8.1, 9.1, 10):
 *   /tv                     TV display (unauthenticated by design)
 *   /login, /setup          auth + first-run wizard
 *   /                       Home (landing); old `/?date=…` shift-view links forward to /shift
 *   /shift                  portal shift view
 *   /floor, /operators/:id, /jobs/:job, /products/:z
 *   /displays               TV displays: change the job on each TV (manager+)
 *   /admin/*                Settings area (admin role; standards + sync health allow manager)
 */
export function App() {
  return (
    <>
      <DemoBadge />
      <Routes>
        <Route path="/tv" element={<TvPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />

        <Route
          element={
            <RequireAuth minRole="viewer">
              <PortalLayout />
            </RequireAuth>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="/shift" element={<ShiftPage />} />
          <Route path="/floor" element={<FloorPage />} />
          <Route path="/operators" element={<OperatorsPage />} />
          <Route path="/operators/:id" element={<OperatorPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:job" element={<JobPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:z" element={<ProductPage />} />
          <Route path="/displays" element={<TvJobsPage />} />
        </Route>

        <Route
          path="/admin"
          element={
            <RequireAuth minRole="manager">
              <AdminLayout />
            </RequireAuth>
          }
        >
          <Route index element={<SettingsIndex />} />
          <Route path="displays" element={<DisplaysPage />} />
          <Route path="shifts" element={<ShiftsPage />} />
          <Route path="breaks" element={<BreaksPage />} />
          <Route path="connection" element={<ConnectionPage />} />
          <Route path="mapping" element={<MappingPage />} />
          <Route path="standards" element={<StandardsPage />} />
          <Route path="engine" element={<EnginePage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="sync" element={<SyncPage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
