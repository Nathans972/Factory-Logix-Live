/**
 * Small helpers shared by the admin pages and the first-run wizard (spec 10):
 * role gating, success flashes, confirm dialogs, the clickable stepper and error formatting.
 *
 * Everything renders with the wave-1 design system (`src/ui`) — no page-specific chrome.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackfillProgress } from '@fld/shared';
import { hasRole, useAuth } from '../../../auth/AuthContext';
import { DataSourceError } from '../../../data/DataSource';
import { formatDateTime } from '../../../lib/format';
import { Button, Card, CardHeader, Modal, Note, PageHeader, ProgressBar, StatusBadge, type BadgeTone } from '../../../ui';

/** Wraps an admin-only page body; managers get a "Not allowed" note (spec 10 / 9 role gating). */
export function AdminOnly({ title, children }: { title: string; children: ReactNode }) {
  const { user } = useAuth();
  if (!hasRole(user, 'admin')) {
    return (
      <>
        <PageHeader title={title} subtitle="This page needs the admin role." />
        <Note tone="warn" title="Not allowed">
          Your role is {user?.role ?? 'unknown'}. Managers can open <strong>Standards</strong> and{' '}
          <strong>Sync health</strong>.
        </Note>
      </>
    );
  }
  return <>{children}</>;
}

/** Success message that clears itself after a few seconds (docs/DESIGN.md: auto-dismiss success). */
export function useFlash(ms = 4000): { message: string | null; show: (m: string) => void; clear: () => void } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMessage(null);
  }, []);

  const show = useCallback(
    (m: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(m);
      timer.current = setTimeout(() => setMessage(null), ms);
    },
    [ms],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { message, show, clear };
}

/** Renders the auto-dismissing success note when there is one. */
export function Flash({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb">
      <Note tone="success">{message}</Note>
    </div>
  );
}

/** Debounce a fast-changing value (search boxes). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Confirmations stay modals; create/edit forms use the drawer (docs/DESIGN.md "Components"). */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error != null && <ApiError error={error} />}
      {body}
    </Modal>
  );
}

/** Error note that also surfaces structured API validation details when present. */
export function ApiError({ error, title }: { error: unknown; title?: ReactNode }) {
  if (error == null) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof DataSourceError ? error.details : undefined;
  return (
    <Note tone="error" title={title}>
      <div>{message}</div>
      {details != null && <pre className="json-block mt">{safeJson(details)}</pre>}
    </Note>
  );
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface StepDef {
  label: string;
  done?: boolean;
}

/**
 * The design-system `Stepper` pills plus click-to-jump. Identical markup and classes to
 * `ui/components.tsx` `Stepper`; only the buttons are interactive.
 */
export function StepPills({
  steps,
  current,
  onSelect,
}: {
  steps: StepDef[];
  current: number;
  onSelect?: (i: number) => void;
}) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <button
          key={s.label}
          type="button"
          disabled={!onSelect}
          className={`step${i === current ? ' on' : ''}${s.done && i !== current ? ' done' : ''}`}
          onClick={onSelect ? () => onSelect(i) : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="n">{s.done && i !== current ? '✓' : i + 1}</span>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Like `Field` from the ui kit but rendered as a div, for composite controls
 * (day pickers, job pickers, segmented controls) that must not sit inside a <label>.
 */
export function FieldBlock({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      {label != null && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function OnlineBadge({ online }: { online: boolean }) {
  return <StatusBadge tone={online ? 'ok' : 'off'}>{online ? 'Online' : 'Offline'}</StatusBadge>;
}

const BACKFILL_TONE: Record<BackfillProgress['status'], BadgeTone> = {
  idle: 'neutral',
  scheduled: 'info',
  running: 'info',
  paused: 'warn',
  done: 'ok',
  error: 'off',
};

/** Backfill progress readout shared by the Connection, Sync health and setup pages (spec 10.4 / 10.9). */
export function BackfillBar({ backfill, tz }: { backfill: BackfillProgress | null; tz: string }) {
  if (!backfill) return <p className="muted">No backfill has been scheduled.</p>;
  const pct = backfill.days_total > 0 ? Math.min(1, backfill.days_done / backfill.days_total) : 0;
  return (
    <div className="stack-sm">
      <div className="row">
        <StatusBadge tone={BACKFILL_TONE[backfill.status]}>{backfill.status}</StatusBadge>
        <ProgressBar value={pct} width={220} />
        <span className="muted small">
          {backfill.days_done} of {backfill.days_total} days
          {backfill.current_day ? ` · working on ${backfill.current_day}` : ''}
        </span>
      </div>
      <dl className="kv">
        <dt>Started</dt>
        <dd>{formatDateTime(backfill.started_at, tz)}</dd>
        <dt>Finished</dt>
        <dd>{formatDateTime(backfill.finished_at, tz)}</dd>
        {backfill.error && (
          <>
            <dt>Error</dt>
            <dd className="field-error">{backfill.error}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** A card whose body is a plain block — the shape every admin settings section uses. */
export function SectionCard({
  title,
  subtitle,
  actions,
  badges,
  children,
  bodyless,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
  /** skip the padded body (tables render flush) */
  bodyless?: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} badges={badges} actions={actions} />
      {bodyless ? children : <div className="card-body">{children}</div>}
    </Card>
  );
}

/** Common IANA zones offered as a datalist on plant time zone inputs. */
export const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Europe/Bucharest',
  'Europe/Istanbul',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

/** Mirrors `ianaTimeZoneSchema` client-side so typos are caught before the round trip. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TIMEZONE_DATALIST_ID = 'fld-tz-list';

export function TimeZoneDatalist() {
  return (
    <datalist id={TIMEZONE_DATALIST_ID}>
      {COMMON_TIMEZONES.map((tz) => (
        <option key={tz} value={tz} />
      ))}
    </datalist>
  );
}
