/** Admin shell: sub-nav + routed page (spec 10). Managers only reach Standards and Sync health. */
import { Link, NavLink, Outlet } from 'react-router-dom';
import { hasRole, useAuth } from '../../auth/AuthContext';
import '../../styles/admin.css';

const NAV: { to: string; label: string; managerOk?: boolean }[] = [
  { to: '/admin/displays', label: 'Displays' },
  { to: '/admin/shifts', label: 'Shifts' },
  { to: '/admin/breaks', label: 'Breaks' },
  { to: '/admin/connection', label: 'Connection' },
  { to: '/admin/mapping', label: 'Mapping' },
  { to: '/admin/standards', label: 'Standards', managerOk: true },
  { to: '/admin/engine', label: 'Engine' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/sync', label: 'Sync health', managerOk: true },
  { to: '/admin/audit', label: 'Audit' },
];

export function AdminLayout() {
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">FactoryLogix Live</div>
        <Link to="/" className="nav back-link">
          ← Portal
        </Link>
        <div className="nav-section">Admin</div>
        {NAV.map((n) => {
          const locked = !isAdmin && !n.managerOk;
          return (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `nav${isActive ? ' active' : ''}${locked ? ' locked' : ''}`}
              title={locked ? 'Admin role required' : undefined}
            >
              {n.label}
            </NavLink>
          );
        })}
        <div className="sidebar-foot">
          <span className="who">{user?.username ?? 'Not signed in'}</span>
          <span className="role">{user?.role ?? ''}</span>
        </div>
      </nav>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
