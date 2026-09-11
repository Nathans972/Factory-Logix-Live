/** Username/password sign-in (spec 9.1). Redirects to ?next or the portal landing page. */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Button, Field, Input, Note, Spinner } from '../../ui';

export function LoginPage() {
  const { user, loading, needsSetup, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rawNext = params.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-page">
        <Spinner />
      </div>
    );
  }
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to={next} replace />;

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <div className="auth-brand">
          <span className="brand-tile">FL</span>
          FactoryLogix Live
        </div>
        <h1>Sign in</h1>
        <p className="auth-lede">Use your plant portal account.</p>
        {error && <Note tone="error" title="Sign in failed">{error}</Note>}
        <Field label="User name">
          <Input value={username} autoFocus autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="btn-block" loading={busy} disabled={!username || !password}>
          Sign in
        </Button>
      </form>
      <div className="auth-foot">FactoryLogix Live · read-only production dashboard</div>
    </div>
  );
}
