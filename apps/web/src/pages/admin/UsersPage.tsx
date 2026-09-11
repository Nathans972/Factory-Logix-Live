/** Users admin (spec 10.8). Password hashes are never sent to the client. */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserRequest, Role, User } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useAuth } from '../../auth/AuthContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime } from '../../lib/format';
import { Button, DataTable, Field, Input, Modal, PageHeader, Select, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, useFlash } from './components/common';

const ROLES: Role[] = ['admin', 'manager', 'viewer'];
const USERNAME_RE = /^[a-zA-Z0-9._@-]+$/;

export function UsersPage() {
  return (
    <AdminOnly title="Users">
      <UsersPageInner />
    </AdminOnly>
  );
}

function UsersPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();
  const { user: me } = useAuth();

  const usersQ = useQuery({ queryKey: ['users'], queryFn: () => ds.users() });

  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);

  const [cUsername, setCUsername] = useState('');
  const [cPassword, setCPassword] = useState('');
  const [cRole, setCRole] = useState<Role>('viewer');
  const [newPassword, setNewPassword] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });

  const createM = useMutation({
    mutationFn: (req: CreateUserRequest) => ds.createUser(req),
    onSuccess: (u) => {
      void invalidate();
      setCreating(false);
      setCUsername('');
      setCPassword('');
      setCRole('viewer');
      flash.show(`Created ${u.username}.`);
    },
  });

  const updateM = useMutation({
    mutationFn: (v: { id: number; req: { role?: Role; active?: boolean; password?: string } }) =>
      ds.updateUser(v.id, v.req),
    onSuccess: (_u, v) => {
      void invalidate();
      setResetting(null);
      setToggling(null);
      setNewPassword('');
      flash.show(v.req.password ? 'Password reset.' : 'User updated.');
    },
  });

  const usernameError =
    cUsername && (cUsername.length < 2 || cUsername.length > 60 || !USERNAME_RE.test(cUsername))
      ? '2–60 characters; letters, digits and . _ @ - only'
      : undefined;
  const passwordError = cPassword && cPassword.length < 8 ? 'At least 8 characters' : undefined;
  const canCreate = !!cUsername && !!cPassword && !usernameError && !passwordError;

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    createM.mutate({ username: cUsername.trim(), password: cPassword, role: cRole });
  };

  const columns: Column<User>[] = [
    {
      key: 'username',
      header: 'User name',
      render: (u) => (
        <>
          {u.username}
          {me?.id === u.id && <span className="muted small"> (you)</span>}
        </>
      ),
      value: (u) => u.username,
    },
    {
      key: 'role',
      header: 'Role',
      render: (u) => (
        <Select
          value={u.role}
          disabled={updateM.isPending}
          onChange={(e) => updateM.mutate({ id: u.id, req: { role: e.currentTarget.value as Role } })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      ),
      value: (u) => u.role,
    },
    { key: 'active', header: 'Active', render: (u) => (u.active ? 'Yes' : 'No'), value: (u) => (u.active ? 1 : 0) },
    { key: 'created', header: 'Created', render: (u) => formatDateTime(u.created_at, tz), value: (u) => u.created_at },
    {
      key: 'last_login',
      header: 'Last login',
      render: (u) => formatDateTime(u.last_login_at, tz),
      value: (u) => u.last_login_at ?? 0,
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      render: (u) => (
        <span className="row-actions">
          <Button
            size="sm"
            onClick={() => {
              setNewPassword('');
              updateM.reset();
              setResetting(u);
            }}
          >
            Reset password
          </Button>
          <Button size="sm" variant={u.active ? 'danger' : 'secondary'} disabled={me?.id === u.id} onClick={() => setToggling(u)}>
            {u.active ? 'Deactivate' : 'Activate'}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Admins manage everything; managers see the portal and standards; viewers are read-only."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              createM.reset();
              setCreating(true);
            }}
          >
            Create user
          </Button>
        }
      />

      <Flash message={flash.message} />
      {usersQ.isError && <ApiError error={usersQ.error} />}
      {updateM.isError && <ApiError error={updateM.error} />}
      {usersQ.isLoading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={usersQ.data ?? []}
          rowKey={(u) => u.id}
          exportName="users"
          defaultSort={{ key: 'username', dir: 'asc' }}
          emptyMessage="No users."
        />
      )}

      <Modal
        open={creating}
        title="Create user"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-user-form" loading={createM.isPending} disabled={!canCreate}>
              Create
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={submitCreate}>
          {createM.isError && <ApiError error={createM.error} />}
          <Field label="User name" error={usernameError}>
            <Input autoFocus value={cUsername} onChange={(e) => setCUsername(e.currentTarget.value)} />
          </Field>
          <Field label="Password" hint="At least 8 characters." error={passwordError}>
            <Input type="password" autoComplete="new-password" value={cPassword} onChange={(e) => setCPassword(e.currentTarget.value)} />
          </Field>
          <Field label="Role">
            <Select value={cRole} onChange={(e) => setCRole(e.currentTarget.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>

      <Modal
        open={!!resetting}
        title={`Reset password for ${resetting?.username ?? ''}`}
        onClose={() => setResetting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={updateM.isPending}
              disabled={newPassword.length < 8}
              onClick={() => resetting && updateM.mutate({ id: resetting.id, req: { password: newPassword } })}
            >
              Reset
            </Button>
          </>
        }
      >
        {updateM.isError && <ApiError error={updateM.error} />}
        <Field label="New password" hint="At least 8 characters. The user is not notified automatically.">
          <Input type="password" autoComplete="new-password" autoFocus value={newPassword} onChange={(e) => setNewPassword(e.currentTarget.value)} />
        </Field>
      </Modal>

      <ConfirmModal
        open={!!toggling}
        title={toggling?.active ? 'Deactivate user' : 'Activate user'}
        danger={toggling?.active}
        confirmLabel={toggling?.active ? 'Deactivate' : 'Activate'}
        busy={updateM.isPending}
        error={updateM.error}
        onClose={() => setToggling(null)}
        onConfirm={() => toggling && updateM.mutate({ id: toggling.id, req: { active: !toggling.active } })}
        body={
          <p>
            {toggling?.active
              ? `${toggling?.username} will no longer be able to sign in. Their audit history is kept.`
              : `${toggling?.username} will be able to sign in again.`}
          </p>
        }
      />
    </>
  );
}
