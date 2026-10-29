/**
 * First-run setup wizard (spec 10.10), matching docs/design/setup.html: the top bar only (no
 * rail) above a centered 760 px card with the stepper.
 *
 * Admin user → plant time zone → FactoryLogix connection → mapping → shifts → breaks → backfill.
 * Every step saves on its own and can be skipped; `setupStatus()` decides which are already done.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BreakWrite, SetupStatus, ShiftWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { IS_MOCK } from '../../data';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { formatDays } from '../../lib/format';
import { browserTz, usePlantTz } from '../../lib/usePlantTz';
import { Button, Field, Input, Note, Spinner, Stepper } from '../../ui';
import {
  ApiError,
  BackfillBar,
  Flash,
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

/** `primary: 'submit'` wires the footer button to the step's own <form id="setup-step-form">. */
const STEP_FORM = 'setup-step-form';

const STEPS: { key: StepKey; label: string; title: string; blurb: string; primary: 'submit' | 'next' }[] = [
  {
    key: 'admin_user',
    label: 'Admin user',
    title: 'Create the administrator',
    blurb: 'This account can configure everything else. You can add more users later.',
    primary: 'submit',
  },
  {
    key: 'timezone',
    label: 'Time zone',
    title: 'Plant time zone',
    blurb: 'Hour boundaries, shifts, breaks and the TV clock are all evaluated in this zone.',
    primary: 'submit',
  },
  {
    key: 'connection',
    label: 'Connection',
    title: 'Connect to FactoryLogix',
    blurb:
      'Enter the OData endpoint hosted by the Report Scheduler Service and a read-only FactoryLogix account. Nothing is ever written back.',
    primary: 'submit',
  },
  {
    key: 'mapping',
    label: 'Mapping',
    title: 'Field mapping',
    blurb: 'Tell the collector which entity sets and fields hold jobs, unit events and defects.',
    primary: 'submit',
  },
  {
    key: 'shifts',
    label: 'Shifts',
    title: 'Shifts',
    blurb: 'At least one shift is needed for the shift view and the StdDay column.',
    primary: 'submit',
  },
  {
    key: 'breaks',
    label: 'Breaks',
    title: 'Breaks',
    blurb: 'Break minutes are removed from charged time for every operator whose window overlaps them.',
    primary: 'submit',
  },
  {
    key: 'backfill',
    label: 'Backfill',
    title: 'Historical backfill',
    blurb: 'Standards need history. Backfill can run tonight in the off-shift window or start right now.',
    primary: 'next',
  },
];

export function SetupPage() {
  const ds = useDataSource();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, loading, needsSetup: authNeedsSetup } = useAuth();

  /** Demo-only: `/setup?preview=1` opens the wizard even when setup is finished (mock build). */
  const preview = IS_MOCK && params.get('preview') === '1';

  const statusQ = useQuery({ queryKey: ['setupStatus'], queryFn: () => ds.setupStatus(), retry: false });

  const [step, setStep] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const s = statusQ.data;
    if (!s || started.current) return;
    started.current = true;
    const forced = Number(params.get('step'));
    if (preview && Number.isInteger(forced) && forced >= 0 && forced < STEPS.length) {
      setStep(forced);
      return;
    }
    const first = STEPS.findIndex((x) => !s.steps[x.key]);
    setStep(preview && first === -1 ? 0 : first === -1 ? STEPS.length - 1 : first);
  }, [statusQ.data, preview, params]);

  if (loading || statusQ.isLoading) return <Spinner />;

  const needsSetup = statusQ.data?.needs_setup ?? authNeedsSetup;
  if (!needsSetup && !preview) {
    if (!user) return <Navigate to="/login" replace />;
    if (!hasRole(user, 'admin')) return <Navigate to="/" replace />;
  }

  const done = statusQ.data?.steps;
  const cur = STEPS[step] ?? STEPS[0];
  if (!cur) return null;
  const isLast = step === STEPS.length - 1;
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const finish = () => navigate('/', { replace: true });

  // An already-completed "submit" step has nothing to submit — fall back to Next.
  const primaryKind = cur.primary === 'submit' && cur.key === 'admin_user' && done?.admin_user ? 'next' : cur.primary;

  return (
    <div className="setup-page">
      <header className="setup-top">
        <span className="brand">
          <span className="brand-tile">FL</span>
          FactoryLogix Live
        </span>
        <span className="spacer" />
        <span className="who">First-run setup · {user ? `signed in as ${user.username}` : 'not signed in'}</span>
      </header>

      <div className="setup-center">
        <div className="setup-card">
          <h1>Set up FactoryLogix Live</h1>
          <p className="lede">
            Seven short steps. Each one saves on its own, and anything you skip can be finished later in
            Administration.
          </p>

          <Stepper
            steps={STEPS.map((s, i) => ({
              label: s.label,
              state: i === step ? 'current' : done?.[s.key] ? 'done' : 'todo',
            }))}
          />

          <h2>{cur.title}</h2>
          <p className="help">{cur.blurb}</p>

          {statusQ.isError && <ApiError error={statusQ.error} />}

          <div className="setup-body">
            {cur.key === 'admin_user' && <AdminStep done={!!done?.admin_user} onDone={next} />}
            {cur.key === 'timezone' && <TimezoneStep onDone={next} />}
            {cur.key === 'connection' && <ConnectionForm formId={STEP_FORM} hideActions onSaved={next} />}
            {cur.key === 'mapping' && <MappingWizard embedded formId={STEP_FORM} onSaved={next} />}
            {cur.key === 'shifts' && <ShiftsStep onDone={next} />}
            {cur.key === 'breaks' && <BreaksStep onDone={next} />}
            {cur.key === 'backfill' && <BackfillStep />}
          </div>

          <div className="setup-foot">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
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
                Finish setup
              </Button>
            ) : primaryKind === 'submit' ? (
              <Button variant="primary" type="submit" form={STEP_FORM}>
                Save and continue
              </Button>
            ) : (
              <Button variant="primary" onClick={next}>
                Save and continue
              </Button>
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
    return <Note tone="success" title="An administrator already exists">Continue to the next step.</Note>;
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
    <form id={STEP_FORM} className="setup-narrow" onSubmit={submit}>
      {createM.isError && <ApiError error={createM.error} />}
      <Field label="User name" error={userError}>
        <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      </Field>
      <Field label="Password" hint="At least 8 characters." error={passError}>
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </Field>
      <Field label="Confirm password" error={matchError}>
        <Input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
        />
      </Field>
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
      id={STEP_FORM}
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
      <Button type="button" variant="ghost" onClick={() => setTz(browserTz())}>
        Use {browserTz()}
      </Button>
    </form>
  );
}

// ---------- step 5: shifts ----------

// "Add shift" saves and stays for the next one. The footer's "Save and continue" saves the shift being
// typed and moves on; with nothing typed it moves on once a shift exists, else the form says what it needs.
function ShiftsStep({ onDone }: { onDone: () => void }) {
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
      <div className="picker-list">
        {shifts.length === 0 && <div className="opt muted">No shifts yet.</div>}
        {shifts.map((s) => (
          <div className="opt" key={s.id}>
            {s.name}
            <span className="sub">
              {s.start_local}–{s.end_local} · {formatDays(s.days_of_week)} · from {s.effective_from}
            </span>
          </div>
        ))}
      </div>
      <ShiftForm
        key={formKey}
        id={STEP_FORM}
        onSubmit={(v, fromFooter) => createM.mutate(v, { onSuccess: fromFooter ? onDone : undefined })}
        onNothingToSave={shifts.length > 0 ? onDone : undefined}
        submitting={createM.isPending}
        error={createM.error}
        submitLabel="Add shift"
      />
    </>
  );
}

// ---------- step 6: breaks ----------

// "Add break" and the footer's "Save and continue" work as on the shifts step.
function BreaksStep({ onDone }: { onDone: () => void }) {
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
      <div className="picker-list">
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
      </div>
      <BreakForm
        key={formKey}
        id={STEP_FORM}
        shifts={shiftsQ.data ?? []}
        onSubmit={(v, fromFooter) => createM.mutate(v, { onSuccess: fromFooter ? onDone : undefined })}
        onNothingToSave={breaks.length > 0 ? onDone : undefined}
        submitting={createM.isPending}
        error={createM.error}
        submitLabel="Add break"
      />
    </>
  );
}

// ---------- step 7: backfill ----------

function BackfillStep() {
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
    },
  });

  return (
    <>
      <Flash message={flash.message} />
      {runM.isError && <ApiError error={runM.error} />}
      {scheduled && (
        <Note tone="info" title="Scheduled">
          The backfill starts automatically inside the configured off-shift window. You can change the window and
          trigger it manually on the FactoryLogix page.
        </Note>
      )}
      <div className="row">
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
