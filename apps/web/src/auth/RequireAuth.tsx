import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@fld/shared';
import { hasRole, useAuth } from './AuthContext';
import { Spinner } from '../ui/primitives';

/** Redirects to /setup (first run), /login (anonymous) or shows a 403 message when the role is insufficient. */
export function RequireAuth({ minRole, children }: { minRole: Role; children: ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!hasRole(user, minRole)) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Not allowed</h1>
          <p className="muted">
            Your role ({user.role}) cannot open this page. Ask an administrator for {minRole} access.
          </p>
          <Link to="/">Back to Home</Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
