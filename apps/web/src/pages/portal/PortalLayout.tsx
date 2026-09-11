/** Manager portal shell: sidebar nav + freshness strip + routed page (spec 9.1). */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { Button } from '../../ui';
import { FreshnessIndicator } from './components/FreshnessIndicator';
import '../../styles/portal.css';

const navClass = ({ isActive }: { isActive: boolean }) => `nav${isActive ? ' active' : ''}`;

export function PortalLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">FactoryLogix Live</div>
        <NavLink to="/" end className={navClass}>
          Shift view
        </NavLink>
        <NavLink to="/floor" className={navClass}>
          Floor
        </NavLink>
        <NavLink to="/jobs" className={navClass}>
          Jobs
        </NavLink>
        <NavLink to="/operators" className={navClass}>
          Operators
        </NavLink>
        <NavLink to="/products" className={navClass}>
          Products
        </NavLink>

        {hasRole(user, 'manager') && (
          <>
            <div className="nav-section">Admin</div>
            <NavLink to="/admin" className={navClass}>
              Admin area
            </NavLink>
          </>
        )}

        <div className="sidebar-foot">
          <span className="who">{user?.username ?? 'Not signed in'}</span>
          <span className="role">{user?.role ?? ''}</span>
          <Button size="sm" variant="ghost" onClick={() => void onLogout()}>
            Log out
          </Button>
        </div>
      </nav>

      <main className="main">
        <div className="top-strip">
          <FreshnessIndicator />
        </div>
        <Outlet />
      </main>
    </div>
  );
}
