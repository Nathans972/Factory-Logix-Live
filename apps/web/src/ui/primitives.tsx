import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { CellColor } from '@fld/shared';

// ---------- Buttons ----------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button className={`btn btn-${variant} btn-${size}${className ? ' ' + className : ''}`} disabled={disabled || loading} {...rest}>
      {loading ? '…' : children}
    </button>
  );
}

// ---------- Layout ----------

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel${className ? ' ' + className : ''}`}>
      {(title || actions) && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          <div className="panel-actions">{actions}</div>
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, color, hint }: { label: ReactNode; value: ReactNode; color?: CellColor; hint?: ReactNode }) {
  return (
    <div className={`stat${color ? ' stat-' + color : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="banner banner-error">{msg}</div>;
}

export function Empty({ children = 'Nothing here yet.' }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ---------- Color chips ----------

export function ColorChip({ color, children, title }: { color: CellColor; children?: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${color}`} title={title}>
      {children ?? color}
    </span>
  );
}

export function PaceChip({ pace, color }: { pace: number | null; color: CellColor }) {
  return <ColorChip color={color}>{pace == null ? '—' : `${Math.round(pace * 100)}%`}</ColorChip>;
}

// ---------- Forms ----------

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ' ' + className : ''}`} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input${className ? ' ' + className : ''}`} {...props} />;
}

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function DaysPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <div className="days-picker">
      {names.map((n, i) => (
        <button
          type="button"
          key={n}
          className={`day${value.includes(i) ? ' on' : ''}`}
          onClick={() => onChange(value.includes(i) ? value.filter((d) => d !== i) : [...value, i].sort())}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab${t.value === value ? ' on' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
