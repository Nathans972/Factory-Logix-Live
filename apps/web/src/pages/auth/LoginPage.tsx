/** Username/password sign-in (spec 9.1). Redirects to ?next or the portal landing page. */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Banner, Button, Field, Input, Spinner } from '../../ui';

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
        <h1>FactoryLogix Live</h1>
        {error && <Banner kind="error">{error}</Banner>}
        <Field label="Username">
          <Input value={username} autoFocus autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!username || !password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
