/**
 * First-run setup wizard (spec 10.10).
 * Admin user → plant time zone → FactoryLogix connection → mapping → shifts → breaks → backfill.
 * Every step can be skipped; `setupStatus()` decides which steps are already done.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BreakWrite, SetupStatus, ShiftWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { formatDays } from '../../lib/format';
import { browserTz, usePlantTz } from '../../lib/usePlantTz';
import { Banner, Button, Field, Input, Spinner } from '../../ui';
import {
  ApiError,
  BackfillBar,
  Flash,
  Stepper,
  TIMEZONE_DATALIST_ID,
  TimeZoneDatalist,
  isValidTimeZone,
  useFlash,
} from '../admin/components/common';
import { ConnectionForm } from '../admin/components/ConnectionForm';
import { MappingWizard } from '../admin/components/MappingWizard';
import { ShiftForm } from '../admin/components/ShiftForm';
import { BreakForm } from '../admin/components/BreakForm';
import '../../styles/admin.css';

type StepKey = keyof SetupStatus['steps'];

const STEPS: { key: StepKey; label: string; title: string; blurb: string }[] = [
  {
    key: 'admin_user',
    label: 'Admin user',
    title: 'Create the administrator',
    blurb: 'This account can configure everything else. You can add more users later.',
  },
  {
    key: 'timezone',
    label: 'Time zone',
    title: 'Plant time zone',
    blurb: 'Hour boundaries, shifts, breaks and the TV clock are all evaluated in this zone.',
  },
  {
    key: 'connection',
    label: 'Connection',
    title: 'FactoryLogix connection',
    blurb: 'Point the collector at the OData service and check that it answers.',
  },
  {
    key: 'mapping',
    label: 'Mapping',
    title: 'Field mapping',
    blurb: 'Tell the collector which entity sets and fields hold jobs, unit events and defects.',
  },
  { key: 'shifts', label: 'Shifts', title: 'Shifts', blurb: 'At least one shift is needed for the shift view and StdDay.' },
  { key: 'breaks', label: 'Breaks', title: 'Breaks', blurb: 'Break minutes are removed from charged time.' },
  {
    key: 'backfill',
    label: 'Backfill',
    title: 'Historical backfill',
    blurb: 'Standards need history. Backfill can run tonight in the off-shift window or start right now.',
  },
];

export function SetupPage() {
  const ds = useDataSource();
  const navigate = useNavigate();
  const { user, loading, needsSetup: authNeedsSetup } = useAuth();

  const statusQ = useQuery({ queryKey: ['setupStatus'], queryFn: () => ds.setupStatus(), retry: false });

  const [step, setStep] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const s = statusQ.data;
    if (!s || started.current) return;
    started.current = true;
    const first = STEPS.findIndex((x) => !s.steps[x.key]);
    setStep(first === -1 ? STEPS.length - 1 : first);
  }, [statusQ.data]);

  if (loading || statusQ.isLoading) return <Spinner />;

  const needsSetup = statusQ.data?.needs_setup ?? authNeedsSetup;
  if (!needsSetup) {
    if (!user) return <Navigate to="/login" replace />;
    if (!hasRole(user, 'admin')) return <Navigate to="/" replace />;
  }

  const done = statusQ.data?.steps;
  const cur = STEPS[step] ?? STEPS[0];
  if (!cur) return null;
  const isLast = step === STEPS.length - 1;
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const finish = () => navigate('/', { replace: true });

  return (
    <div className="setup-page">
      <div className="setup-inner">
        <div className="setup-brand">FactoryLogix Live</div>
        <h1 className="page-title">First-run setup</h1>
        <p className="page-subtitle mb">
          Seven steps. Each one saves on its own, and anything skipped can be finished later in the admin area.
        </p>

        <Stepper
          steps={STEPS.map((s) => ({ label: s.label, done: !!done?.[s.key] }))}
          current={step}
          onSelect={setStep}
        />

        <div className="setup-card">
          <h2>
            Step {step + 1} · {cur.title}
          </h2>
          <p className="muted mb">{cur.blurb}</p>

          {statusQ.isError && <ApiError error={statusQ.error} />}

          {cur.key === 'admin_user' && <AdminStep done={!!done?.admin_user} onDone={next} />}
          {cur.key === 'timezone' && <TimezoneStep onDone={next} />}
          {cur.key === 'connection' && <ConnectionForm onSaved={next} />}
          {cur.key === 'mapping' && <MappingWizard embedded onSaved={next} />}
          {cur.key === 'shifts' && <ShiftsStep />}
          {cur.key === 'breaks' && <BreaksStep />}
          {cur.key === 'backfill' && <BackfillStep onDone={() => undefined} />}

          <div className="setup-foot">
            <Button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Back
            </Button>
            <span className="spacer" />
            {!isLast && (
              <Button variant="ghost" onClick={next}>
                Skip for now
              </Button>
            )}
            {isLast ? (
              <Button variant="primary" onClick={finish}>
                Finish
              </Button>
            ) : (
              <Button onClick={next}>Next →</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- step 1: admin ----------

function AdminStep({ done, onDone }: { done: boolean; onDone: () => void }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const createM = useMutation({
    mutationFn: () => ds.setupAdmin({ username: username.trim(), password }),
    onSuccess: async () => {
      await refresh();
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      onDone();
    },
  });

  if (done) {
    return <Banner kind="success">An administrator already exists. Continue to the next step.</Banner>;
  }

  const userError =
    username && (username.length < 2 || username.length > 60 || !/^[a-zA-Z0-9._@-]+$/.test(username))
      ? '2–60 characters; letters, digits and . _ @ - only'
      : undefined;
  const passError = password && password.length < 8 ? 'At least 8 characters' : undefined;
  const matchError = confirm && confirm !== password ? 'Passwords do not match' : undefined;
  const valid = !!username && password.length >= 8 && confirm === password && !userError;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) createM.mutate();
  };

  return (
    <form className="setup-narrow" onSubmit={submit}>
      {createM.isError && <ApiError error={createM.error} />}
      <Field label="User name" error={userError}>
        <Input autoFocus value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      </Field>
      <Field label="Password" hint="At least 8 characters." error={passError}>
        <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
      </Field>
      <Field label="Confirm password" error={matchError}>
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
      </Field>
      <Button type="submit" variant="primary" loading={createM.isPending} disabled={!valid}>
        Create administrator
      </Button>
    </form>
  );
}

// ---------- step 2: time zone ----------

function TimezoneStep({ onDone }: { onDone: () => void }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();
  const plantTz = usePlantTz();
  const [tz, setTz] = useState(plantTz || browserTz());

  const saveM = useMutation({
    mutationFn: () => ds.updateSettings({ plant_timezone: tz.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Time zone saved.');
      onDone();
    },
  });

  const valid = isValidTimeZone(tz);

  return (
    <form
      className="setup-narrow"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) saveM.mutate();
      }}
    >
      <Flash message={flash.message} />
      <TimeZoneDatalist />
      {saveM.isError && <ApiError error={saveM.error} />}
      <Field
        label="Plant time zone"
        hint={`IANA name. This browser reports ${browserTz()}.`}
        error={tz && !valid ? 'Not a valid IANA time zone' : undefined}
      >
        <Input list={TIMEZONE_DATALIST_ID} value={tz} autoFocus onChange={(e) => setTz(e.currentTarget.value)} />
      </Field>
      <div className="row">
        <Button type="submit" variant="primary" loading={saveM.isPending} disabled={!valid}>
          Save time zone
        </Button>
        <Button type="button" variant="ghost" onClick={() => setTz(browserTz())}>
          Use {browserTz()}
        </Button>
      </div>
    </form>
  );
}

// ---------- step 5: shifts ----------

function ListPanel({ children }: { children: ReactNode }) {
  return <div className="picker-list mb">{children}</div>;
}

function ShiftsStep() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();
  const [formKey, setFormKey] = useState(0);

  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => ds.shifts() });

  const createM = useMutation({
    mutationFn: (v: ShiftWrite) => ds.createShift(v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Shift added.');
      setFormKey((k) => k + 1);
    },
  });

  const shifts = shiftsQ.data ?? [];

  return (
    <>
      <Flash message={flash.message} />
      {shiftsQ.isError && <ApiError error={shiftsQ.error} />}
      <ListPanel>
        {shifts.length === 0 && <div className="opt muted">No shifts yet.</div>}
        {shifts.map((s) => (
          <div className="opt" key={s.id}>
            {s.name}
            <span className="sub">
              {s.start_local}–{s.end_local} · {formatDays(s.days_of_week)} · from {s.effective_from}
            </span>
          </div>
        ))}
      </ListPanel>
      <ShiftForm
        key={formKey}
        onSubmit={(v) => createM.mutate(v)}
        submitting={createM.isPending}
        error={createM.error}
        submitLabel="Add shift"
      />
    </>
  );
}

// ---------- step 6: breaks ----------

function BreaksStep() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();
  const [formKey, setFormKey] = useState(0);

  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => ds.shifts() });
  const breaksQ = useQuery({ queryKey: ['breaks'], queryFn: () => ds.breaks() });

  const createM = useMutation({
    mutationFn: (v: BreakWrite) => ds.createBreak(v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['breaks'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Break added.');
      setFormKey((k) => k + 1);
    },
  });

  const breaks = breaksQ.data ?? [];

  return (
    <>
      <Flash message={flash.message} />
      {breaksQ.isError && <ApiError error={breaksQ.error} />}
      <ListPanel>
        {breaks.length === 0 && <div className="opt muted">No breaks yet.</div>}
        {breaks.map((b) => (
          <div className="opt" key={b.id}>
            {b.name}
            <span className="sub">
              {b.start_local} · {b.duration_minutes} min · {formatDays(b.days_of_week)} ·{' '}
              {b.shift_ids == null ? 'all shifts' : `${b.shift_ids.length} shift(s)`}
            </span>
          </div>
        ))}
      </ListPanel>
      <BreakForm
        key={formKey}
        shifts={shiftsQ.data ?? []}
        onSubmit={(v) => createM.mutate(v)}
        submitting={createM.isPending}
        error={createM.error}
        submitLabel="Add break"
      />
    </>
  );
}

// ---------- step 7: backfill ----------

function BackfillStep({ onDone }: { onDone: () => void }) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();
  const [scheduled, setScheduled] = useState(false);

  const healthQ = useQuery({ queryKey: ['syncHealth'], queryFn: () => ds.syncHealth(), refetchInterval: 15_000 });

  const runM = useMutation({
    mutationFn: () => ds.runBackfill(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['syncHealth'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Backfill started.');
      onDone();
    },
  });

  return (
    <>
      <Flash message={flash.message} />
      {runM.isError && <ApiError error={runM.error} />}
      {scheduled && (
        <Banner kind="info">
          The backfill will start automatically inside the configured off-shift window. You can change the window and
          trigger it manually on the Connection page.
        </Banner>
      )}
      <div className="row mb">
        <Button onClick={() => setScheduled(true)}>Schedule for the off-shift window</Button>
        <Button variant="primary" loading={runM.isPending} onClick={() => runM.mutate()}>
          Run now
        </Button>
      </div>
      <p className="muted small">
        Live polling starts as soon as the mapping is saved. Standards appear after the backfill and the first nightly
        recompute — or after a manual recompute on the Standards page.
      </p>
      {healthQ.data && <BackfillBar backfill={healthQ.data.backfill} tz={tz} />}
    </>
  );
}
