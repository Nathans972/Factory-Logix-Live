/**
 * Declarative editor for rows of the `settings` table (spec 11).
 * Validation mirrors `settingsSchema` client-side; only changed keys are sent as a patch.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LocalTime, Settings, SettingsPatch } from '@fld/shared';
import { Button, Checkbox, Field, Input, Select } from '../../../ui';
import { ApiError } from './common';

export type SettingsFieldKind = 'int' | 'int-nullable' | 'number' | 'percent' | 'boolean' | 'time' | 'text' | 'select';

export interface SettingsFieldDef {
  key: keyof Settings;
  /** for object-valued settings (`backfill_window`) */
  sub?: 'start' | 'end';
  label: string;
  kind: SettingsFieldKind;
  hint?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string; hint?: string }[];
  /** id of a <datalist> to attach (plant time zone) */
  list?: string;
  /** rendered inside the collapsed "Advanced" section */
  advanced?: boolean;
  /** extra client-side check; return an error message or null */
  validate?: (raw: string) => string | null;
  wide?: boolean;
}

type Raw = string | boolean;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function fieldId(f: SettingsFieldDef): string {
  return f.sub ? `${f.key}.${f.sub}` : f.key;
}

function readRaw(settings: Settings, f: SettingsFieldDef): Raw {
  if (f.sub) {
    const w = settings[f.key] as unknown as { start: LocalTime; end: LocalTime } | undefined;
    return w ? w[f.sub] : '';
  }
  const v = settings[f.key] as unknown;
  if (f.kind === 'boolean') return v === true;
  if (v == null) return '';
  if (f.kind === 'percent') return String(Math.round(Number(v) * 1000) / 10);
  return String(v);
}

function parseField(f: SettingsFieldDef, raw: Raw): { value: unknown } | { error: string } {
  if (f.kind === 'boolean') return { value: raw === true };
  const s = String(raw).trim();

  if (f.kind === 'int-nullable') {
    if (s === '') return { value: null };
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'Whole number or blank' };
    if (f.min != null && n < f.min) return { error: `Minimum ${f.min}` };
    if (f.max != null && n > f.max) return { error: `Maximum ${f.max}` };
    return { value: n };
  }

  if (s === '') return { error: 'Required' };

  if (f.kind === 'int' || f.kind === 'number' || f.kind === 'percent') {
    const n = Number(s);
    if (!Number.isFinite(n)) return { error: 'Must be a number' };
    if (f.kind === 'int' && !Number.isInteger(n)) return { error: 'Must be a whole number' };
    const value = f.kind === 'percent' ? n / 100 : n;
    if (f.min != null && value < f.min) return { error: `Minimum ${f.kind === 'percent' ? `${f.min * 100}%` : f.min}` };
    if (f.max != null && value > f.max) return { error: `Maximum ${f.kind === 'percent' ? `${f.max * 100}%` : f.max}` };
    return { value };
  }

  if (f.kind === 'time') {
    if (!TIME_RE.test(s)) return { error: 'Expected HH:MM (24 h)' };
    return { value: s };
  }

  const custom = f.validate?.(s);
  if (custom) return { error: custom };
  return { value: s };
}

export function SettingsForm({
  settings,
  fields,
  onSave,
  saving,
  error,
  saveLabel = 'Save settings',
  children,
}: {
  settings: Settings;
  fields: SettingsFieldDef[];
  onSave: (patch: SettingsPatch) => void;
  saving?: boolean;
  error?: unknown;
  saveLabel?: string;
  /** extra content rendered above the buttons */
  children?: ReactNode;
}) {
  const initial = useMemo(() => {
    const d: Record<string, Raw> = {};
    for (const f of fields) d[fieldId(f)] = readRaw(settings, f);
    return d;
  }, [settings, fields]);

  const [draft, setDraft] = useState<Record<string, Raw>>(initial);
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setDraft(JSON.parse(initialKey) as Record<string, Raw>);
  }, [initialKey]);

  const { patch, errors } = useMemo(() => {
    const errs: Record<string, string> = {};
    const out: Record<string, unknown> = {};
    const groups = new Map<string, SettingsFieldDef[]>();
    for (const f of fields) {
      const list = groups.get(f.key) ?? [];
      list.push(f);
      groups.set(f.key, list);
    }

    for (const [key, group] of groups) {
      if (group[0]?.sub) {
        // object-valued setting: rebuild the whole object from its parts
        const obj: Record<string, unknown> = { ...((settings[key as keyof Settings] as unknown as object) ?? {}) };
        let bad = false;
        for (const f of group) {
          const res = parseField(f, draft[fieldId(f)] ?? '');
          if ('error' in res) {
            errs[fieldId(f)] = res.error;
            bad = true;
          } else obj[f.sub as string] = res.value;
        }
        if (!bad && JSON.stringify(obj) !== JSON.stringify(settings[key as keyof Settings])) out[key] = obj;
        continue;
      }
      const f = group[0];
      if (!f) continue;
      const res = parseField(f, draft[fieldId(f)] ?? '');
      if ('error' in res) {
        errs[fieldId(f)] = res.error;
        continue;
      }
      if (!Object.is(res.value, settings[key as keyof Settings])) out[key] = res.value;
    }
    return { patch: out as SettingsPatch, errors: errs };
  }, [draft, fields, settings]);

  const changedCount = Object.keys(patch).length;
  const errorCount = Object.keys(errors).length;

  const set = (id: string, v: Raw) => setDraft((d) => ({ ...d, [id]: v }));

  const render = (f: SettingsFieldDef) => {
    const id = fieldId(f);
    const raw = draft[id];
    const err = errors[id];
    const selected = f.options?.find((o) => o.value === String(raw));
    const hint = (
      <>
        {f.hint}
        {selected?.hint && (
          <>
            {f.hint ? ' ' : ''}
            {selected.hint}
          </>
        )}
      </>
    );

    if (f.kind === 'boolean') {
      return (
        <div className={`field${f.wide ? ' field-wide' : ''}`} key={id}>
          <Checkbox label={f.label} checked={raw === true} onChange={(e) => set(id, e.currentTarget.checked)} />
          {f.hint && <span className="field-hint">{f.hint}</span>}
        </div>
      );
    }

    return (
      <div key={id} className={f.wide ? 'field-wide' : undefined}>
        <Field label={f.label} hint={hint} error={err}>
          {f.kind === 'select' ? (
            <Select value={String(raw ?? '')} onChange={(e) => set(id, e.currentTarget.value)}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={f.kind === 'time' ? 'time' : f.kind === 'text' ? 'text' : 'number'}
              inputMode={f.kind === 'text' || f.kind === 'time' ? undefined : 'decimal'}
              step={f.step ?? (f.kind === 'int' || f.kind === 'int-nullable' ? 1 : 'any')}
              list={f.list}
              value={String(raw ?? '')}
              onChange={(e) => set(id, e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
    );
  };

  const plain = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (errorCount || !changedCount) return;
        onSave(patch);
      }}
    >
      <div className="form-grid">{plain.map(render)}</div>

      {advanced.length > 0 && (
        <details className="collapse">
          <summary>Advanced</summary>
          <div className="collapse-body form-grid">{advanced.map(render)}</div>
        </details>
      )}

      {children}
      {error != null && <ApiError error={error} />}

      <div className="sticky-actions">
        <Button type="submit" variant="primary" loading={saving} disabled={errorCount > 0 || changedCount === 0}>
          {saveLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={changedCount === 0}
          onClick={() => setDraft(JSON.parse(initialKey) as Record<string, Raw>)}
        >
          Reset
        </Button>
        <span className="muted small">
          {errorCount > 0
            ? `${errorCount} field${errorCount === 1 ? '' : 's'} need attention`
            : changedCount === 0
              ? 'No changes'
              : `${changedCount} change${changedCount === 1 ? '' : 's'} pending`}
        </span>
      </div>
    </form>
  );
}
