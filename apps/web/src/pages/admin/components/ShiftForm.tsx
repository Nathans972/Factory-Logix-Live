/** Shift add/edit form (spec 10.2). Validation mirrors `shiftWriteSchema`. */
import { useMemo, useState, type FormEvent } from 'react';
import type { ShiftDef, ShiftWrite } from '@fld/shared';
import { Button, DaysPicker, Field, Input } from '../../../ui';
import { formatIsoDate } from '../../../lib/format';
import { usePlantTz } from '../../../lib/usePlantTz';
import { ApiError, FieldBlock } from './common';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function crossesMidnight(start: string, end: string): boolean {
  return TIME_RE.test(start) && TIME_RE.test(end) && end <= start;
}

export function ShiftForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
  error,
  submitLabel,
}: {
  initial?: ShiftDef | null;
  onSubmit: (v: ShiftWrite) => void;
  onCancel?: () => void;
  submitting?: boolean;
  error?: unknown;
  submitLabel?: string;
}) {
  const tz = usePlantTz();
  const today = useMemo(() => formatIsoDate(Date.now(), tz), [tz]);

  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(initial?.start_local ?? '07:00');
  const [end, setEnd] = useState(initial?.end_local ?? '19:00');
  const [days, setDays] = useState<number[]>(initial?.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]);
  const [from, setFrom] = useState(initial?.effective_from ?? today);
  const [to, setTo] = useState(initial?.effective_to ?? '');
  const [touched, setTouched] = useState(false);

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Required';
  else if (name.trim().length > 80) errors.name = 'Maximum 80 characters';
  if (!TIME_RE.test(start)) errors.start = 'Expected HH:MM';
  if (!TIME_RE.test(end)) errors.end = 'Expected HH:MM';
  if (TIME_RE.test(start) && TIME_RE.test(end) && start === end) errors.end = 'Start and end cannot be identical';
  if (days.length === 0) errors.days = 'Pick at least one day';
  if (!DATE_RE.test(from)) errors.from = 'Expected YYYY-MM-DD';
  if (to && !DATE_RE.test(to)) errors.to = 'Expected YYYY-MM-DD';
  if (to && DATE_RE.test(to) && DATE_RE.test(from) && to < from) errors.to = 'Must not be before the effective-from date';
  const valid = Object.keys(errors).length === 0;
  const show = (k: string) => (touched ? errors[k] : undefined);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      start_local: start,
      end_local: end,
      days_of_week: [...days].sort((a, b) => a - b),
      effective_from: from,
      effective_to: to ? to : null,
    });
  };

  return (
    <form onSubmit={submit}>
      <p className="hint-line">
        Shifts are plant-wide. Editing creates a new version from the effective-from date — past days keep the
        definition that was in effect then.
      </p>

      <div className="form-grid">
        <div className="field-wide">
          <Field label="Name" error={show('name')}>
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Day" autoFocus />
          </Field>
        </div>
        <Field label="Start (plant local)" error={show('start')}>
          <Input type="time" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
        </Field>
        <Field
          label="End (plant local)"
          hint={crossesMidnight(start, end) ? 'Ends the next day.' : undefined}
          error={show('end')}
        >
          <Input type="time" value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
        </Field>
        <FieldBlock label="Days of week" wide hint="The local day the shift starts on." error={show('days')}>
          <DaysPicker value={days} onChange={setDays} />
        </FieldBlock>
        <Field label="Effective from" error={show('from')}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        </Field>
        <Field label="Effective to" hint="Blank = no end date." error={show('to')}>
          <Input type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </Field>
      </div>

      {error != null && <ApiError error={error} />}

      <div className="sticky-actions">
        <Button type="submit" variant="primary" loading={submitting} disabled={touched && !valid}>
          {submitLabel ?? (initial ? 'Save shift' : 'Add shift')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
