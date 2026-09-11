/**
 * FactoryLogix OData connection form (spec 10.4). Reused by the first-run wizard (10.10).
 * "Test connection" always uses the values currently in the form, saved or not.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionTestResult, FlConnection } from '@fld/shared';
import { useDataSource } from '../../../data/DataSourceContext';
import { Banner, Button, Field, Input, Spinner } from '../../../ui';
import { ApiError, Flash, useFlash } from './common';

function urlError(v: string): string | null {
  if (!v.trim()) return 'Required';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Must start with http:// or https://';
    return null;
  } catch {
    return 'Not a valid URL';
  }
}

export function ConnectionForm({ onSaved }: { onSaved?: () => void }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();

  const connQ = useQuery({ queryKey: ['connection'], queryFn: () => ds.connection() });
  const saved = connQ.data?.connection;

  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  const savedKey = saved ? `${saved.base_url}|${saved.username}|${saved.has_password ? 1 : 0}` : '';
  useEffect(() => {
    if (!saved) return;
    setBaseUrl(saved.base_url ?? '');
    setUsername(saved.username ?? '');
    setPassword('');
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const payload = (): FlConnection => ({
    base_url: baseUrl.trim(),
    username: username.trim(),
    ...(password ? { password } : {}),
  });

  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const testM = useMutation({
    mutationFn: () => ds.testConnection(payload()),
    onSuccess: (r) => setTest(r),
  });

  const saveM = useMutation({
    mutationFn: () => ds.updateConnection(payload()),
    onSuccess: () => {
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['connection'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Connection saved.');
      onSaved?.();
    },
  });

  if (connQ.isLoading) return <Spinner />;
  if (connQ.isError) return <ApiError error={connQ.error} />;

  const urlErr = touched ? urlError(baseUrl) : null;
  const userErr = touched && !username.trim() ? 'Required' : null;
  const canSubmit = !urlError(baseUrl) && !!username.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!canSubmit) return;
        saveM.mutate();
      }}
    >
      <Flash message={flash.message} />

      <div className="form-grid">
        <div className="field-wide">
          <Field
            label="Server URL"
            hint="Base URL of the FactoryLogix OData service, e.g. https://fl.example.com/odata"
            error={urlErr}
          >
            <Input
              value={baseUrl}
              placeholder="https://factorylogix.example.com/odata"
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              onBlur={() => setTouched(true)}
            />
          </Field>
        </div>
        <Field label="User name" error={userErr}>
          <Input value={username} onChange={(e) => setUsername(e.currentTarget.value)} onBlur={() => setTouched(true)} />
        </Field>
        <Field
          label="Password"
          hint={saved?.has_password ? 'A password is stored. Leave blank to keep it.' : 'Stored encrypted at rest.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={saved?.has_password ? '•••••••• (unchanged)' : ''}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </Field>
      </div>

      {saveM.isError && <ApiError error={saveM.error} />}
      {testM.isError && <ApiError error={testM.error} />}

      {test && (
        <div className="mt mb">
          {test.ok ? (
            <Banner kind="success">
              Connected. OData version {test.metadata?.version ?? 'unknown'} ·{' '}
              {test.metadata?.entity_sets.length ?? 0} entity sets found ·{' '}
              {test.latency_ms == null ? 'latency unknown' : `${Math.round(test.latency_ms)} ms`}
            </Banner>
          ) : (
            <Banner kind="error">Connection failed: {test.error ?? 'unknown error'}</Banner>
          )}
        </div>
      )}

      <div className="sticky-actions">
        <Button type="submit" variant="primary" loading={saveM.isPending} disabled={!canSubmit}>
          Save connection
        </Button>
        <Button type="button" loading={testM.isPending} disabled={!canSubmit} onClick={() => testM.mutate()}>
          Test connection
        </Button>
        <span className="muted small">Test uses the values in this form, saved or not.</span>
      </div>
    </form>
  );
}
