/**
 * FactoryLogix OData connection form (spec 10.4). Reused by the first-run wizard (10.10),
 * where the wizard footer owns the primary button (`formId` + `hideActions`).
 *
 * "Test connection" always uses the values currently in the form, saved or not.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionTestResult, FlConnection } from '@fld/shared';
import { useDataSource } from '../../../data/DataSourceContext';
import { Button, Field, Input, Note, Spinner } from '../../../ui';
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

/** Same URL and user name as saved. The API only sends the stored password with those. */
function sameConnection(baseUrl: string, username: string, saved: FlConnection): boolean {
  return baseUrl.trim() === saved.base_url.trim() && username.trim() === saved.username.trim();
}

/** "Connected in 155 ms" + version + entity sets, exactly as in docs/design/setup.html. */
export function ConnectionTestNote({ test }: { test: ConnectionTestResult }) {
  if (!test.ok) {
    return (
      <Note tone="error" title="Could not connect">
        {test.error ?? 'unknown error'}
      </Note>
    );
  }
  const sets = test.metadata?.entity_sets ?? [];
  const names = sets.slice(0, 8).map((e) => e.name);
  return (
    <Note
      tone="success"
      title={test.latency_ms == null ? 'Connected' : `Connected in ${Math.round(test.latency_ms)} ms`}
    >
      FactoryLogix OData {test.metadata?.version ?? 'version unknown'} · {sets.length} entity set
      {sets.length === 1 ? '' : 's'} found
      {names.length > 0 ? `: ${names.join(', ')}${sets.length > names.length ? ', …' : '.'}` : '.'}
    </Note>
  );
}

export function ConnectionForm({
  onSaved,
  formId,
  hideActions,
}: {
  onSaved?: () => void;
  /** id given to the <form> so an outside footer can submit it */
  formId?: string;
  /** hide the built-in Save button (the wizard footer provides it) */
  hideActions?: boolean;
}) {
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
  // Saved under another ENCRYPTION_KEY (a backup restored from another install): it cannot be kept.
  const unreadable = !!saved?.password_unreadable;
  const keepsPassword = !!saved?.has_password && !unreadable && sameConnection(baseUrl, username, saved);
  const passwordHint = keepsPassword
    ? 'A password is stored — leave blank to keep it.'
    : saved?.has_password && !unreadable
      ? 'The stored password is only sent with the saved URL and user name. Enter the password again to change them.'
      : 'Stored encrypted at rest.';
  const passwordErr =
    unreadable && !password
      ? "The stored password cannot be decrypted with this server's ENCRYPTION_KEY: it was saved under another key, as when a backup from another install is restored. Enter it again."
      : null;

  return (
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!canSubmit) return;
        saveM.mutate();
      }}
    >
      <Flash message={flash.message} />

      <Field
        label="Server URL"
        hint="Usually http://<server>:6065/odata. Open /$metadata in a browser to confirm it responds."
        error={urlErr}
      >
        <Input
          className="mono"
          value={baseUrl}
          placeholder="http://factorylogix.example.local:6065/odata"
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
          onBlur={() => setTouched(true)}
        />
      </Field>

      <div className="grid-2col">
        <Field label="User name" error={userErr}>
          <Input
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.currentTarget.value)}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <Field label="Password" hint={passwordHint} error={passwordErr}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={keepsPassword ? '•••••••••••• (unchanged)' : ''}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </Field>
      </div>

      <div className="form-actions mb">
        <Button type="button" loading={testM.isPending} disabled={!canSubmit} onClick={() => testM.mutate()}>
          Test connection
        </Button>
        {!hideActions && (
          <>
            <span className="spacer" />
            <Button type="submit" variant="primary" loading={saveM.isPending} disabled={!canSubmit}>
              Save
            </Button>
          </>
        )}
      </div>

      {saveM.isError && <ApiError error={saveM.error} />}
      {testM.isError && <ApiError error={testM.error} title="Test failed" />}
      {test && <ConnectionTestNote test={test} />}
    </form>
  );
}
