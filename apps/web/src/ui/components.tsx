/**
 * Design-system components (docs/DESIGN.md "Components").
 *
 * Everything here is plain CSS + the class names defined in styles/global.css.
 * The older primitives in ./primitives.tsx stay exported for pages that have not been
 * migrated yet; new pages should prefer these.
 */
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CellColor } from '@fld/shared';

// ---------------------------------------------------------------- KPI tile

export type Accent = 'red' | 'amber' | 'green' | 'blue' | 'none';

export function KpiTile({ label, value, hint, accent = 'none' }: { label: ReactNode; value: ReactNode; hint?: ReactNode; accent?: Accent }) {
  return (
    <div className={`kpi${accent === 'none' ? '' : ` kpi-${accent}`}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint != null && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

/** Grid wrapper for a row of KPI tiles. */
export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="kpi-row">{children}</div>;
}

// -------------------------------------------------------------------- card

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`card${className ? ' ' + className : ''}`}>{children}</section>;
}

export function CardHeader({ title, subtitle, badges, actions }: { title: ReactNode; subtitle?: ReactNode; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="card-head">
      <h3 className="card-title">{title}</h3>
      {subtitle != null && <span className="card-sub">{subtitle}</span>}
      {badges}
      {actions != null && <div className="card-actions">{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------ status badge

export type BadgeTone = 'ok' | 'off' | 'warn' | 'info' | 'neutral';

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

// -------------------------------------------------------- segmented control

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  full,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  full?: boolean;
}) {
  return (
    <div className={`seg${full ? ' seg-full' : ''}`} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={`seg-btn${o.value === value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ switch

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }) {
  const knob = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof label === 'string' ? label : undefined}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
  if (label == null && hint == null) return knob;
  return (
    <label className="switch-row">
      <span>
        <span className="switch-label">{label}</span>
        {hint != null && <small className="switch-hint">{hint}</small>}
      </span>
      {knob}
    </label>
  );
}

// ----------------------------------------------------- progress + sparkline

export function ProgressBar({ value, width }: { value: number; width?: number | string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span className="progress" style={width == null ? undefined : { width }} title={`${Math.round(pct * 100)}%`}>
      <i style={{ width: `${pct * 100}%` }} />
    </span>
  );
}

export function Sparkline({ values, height = 18 }: { values: number[]; height?: number }) {
  const max = Math.max(1, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  return (
    <span className="sparkline" style={{ height }} aria-hidden="true">
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(2, ((Number.isFinite(v) ? v : 0) / max) * height)}px` }} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ drawer

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer" style={{ width }} role="dialog" aria-modal="true">
        <header className="drawer-head">
          <h3>{title}</h3>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer != null && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  );
}

// ----------------------------------------------------------------- stepper

export type StepState = 'done' | 'current' | 'todo';

export function Stepper({ steps }: { steps: { label: ReactNode; state: StepState }[] }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <span key={i} className={`step${s.state === 'current' ? ' on' : s.state === 'done' ? ' done' : ''}`}>
          <span className="n">{s.state === 'done' ? '✓' : i + 1}</span>
          {s.label}
        </span>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- note panel

export type NoteTone = 'success' | 'error' | 'info' | 'warn';

const NOTE_GLYPH: Record<NoteTone, string> = { success: '✓', error: '!', info: 'i', warn: '!' };

export function Note({ tone, title, children }: { tone: NoteTone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`note note-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <i className="note-icon">{NOTE_GLYPH[tone]}</i>
      <div>
        {title != null && <span className="note-title">{title}</span>}
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- empty state

export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {hint != null && <div className="empty-hint">{hint}</div>}
      {action}
    </div>
  );
}

// ------------------------------------------------------------- breadcrumbs

export function Breadcrumbs({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> / </span>}
          {it.to ? <Link to={it.to}>{it.label}</Link> : <b>{it.label}</b>}
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------- hourly grid cell

export function HourCellBox({ units, color, current, title }: { units: number | null; color: CellColor; current?: boolean; title?: string }) {
  return (
    <span className={`cell c-${color}${current ? ' now' : ''}`} title={title}>
      {color === 'blank' || units == null ? '' : units}
    </span>
  );
}

// ------------------------------------------------------------------ avatar

/** "JRivera" → "JR", "nathan sessions" → "NS". */
export function initials(name: string): string {
  const clean = (name ?? '').trim();
  if (!clean) return '?';
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const w = words[0]!;
  const caps = w.replace(/[^A-Z]/g, '');
  if (caps.length >= 2) return caps.slice(0, 2);
  return w.slice(0, 2).toUpperCase();
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" title={name}>
      {initials(name)}
    </span>
  );
}
