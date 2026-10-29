/**
 * Shift add/edit form (spec 10.2). Validation mirrors `shiftWriteSchema`.
 *
 * Rendered inside the 440 px drawer on `/admin/shifts` (the drawer footer submits it through
 * `form={id}`) and inline in the first-run wizard, where it keeps its own "Add shift" button and the
 * wizard footer's "Save and continue" submits it too.
 */
import { useMemo, useState, type FormEvent } from 'react';
import type { ShiftDef, ShiftWrite } from '@fld/shared';
import { Button, DaysPicker, Field, Input, Note } from '../../../ui';
import { formatIsoDate } from '../../../lib/format';
import { usePlantTz } from '../../../lib/usePlantTz';
import { ApiError, FieldBlock, submittedFromFooter } from './common';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function crossesMidnight(start: string, end: string): boolean {
  return TIME_RE.test(start) && TIME_RE.test(end) && end <= start;
}

function inEffectOn(shift: ShiftDef, date: string): boolean {
  return shift.effective_from <= date && (shift.effective_to === null || date <= shift.effective_to);
}

export function ShiftForm({
  id,
  initial,
  onSubmit,
  onNothingToSave,
  onCancel,
  submitting,
  error,
  submitLabel,
  hideActions,
}: {
  id?: string;
  initial?: ShiftDef | null;
  /** `fromFooter`: a button outside the form submitted it (`submittedFromFooter`), not its own. */
  onSubmit: (v: ShiftWrite, fromFooter: boolean) => void;
  /** Called instead of validating when a footer submits the form with nothing changed in it. */
  onNothingToSave?: () => void;
  onCancel?: () => void;
  submitting?: boolean;
  error?: unknown;
  submitLabel?: string;
  hideActions?: boolean;
}) {
  const tz = usePlantTz();
  const today = useMemo(() => formatIsoDate(Date.now(), tz), [tz]);
  // Days already recorded keep the version in effect then, so an edit of the one in effect today defaults
  // to a new version from today (the API refuses its new times or days without a later date).
  const current = initial && inEffectOn(initial, today) ? initial : null;

  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(initial?.start_local ?? '07:00');
  const [end, setEnd] = useState(initial?.end_local ?? '19:00');
  const [days, setDays] = useState<number[]>(initial?.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]);
  const [from, setFrom] = useState(current ? today : (initial?.effective_from ?? today));
  const [to, setTo] = useState(initial?.effective_to ?? '');
  const [touched, setTouched] = useState(false);
  const values = JSON.stringify([name, start, end, days, from, to]);
  const [opened] = useState(values); // what the form opened with: useState keeps the first value

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

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The wizard footer stays enabled while this saves: a second press must not add the shift twice.
    if (submitting) return;
    const fromFooter = submittedFromFooter(e);
    if (fromFooter && values === opened && onNothingToSave) {
      onNothingToSave();
      return;
    }
    setTouched(true);
    if (!valid) return;
    onSubmit(
      {
        name: name.trim(),
        start_local: start,
        end_local: end,
        days_of_week: [...days].sort((a, b) => a - b),
        effective_from: from,
        effective_to: to ? to : null,
      },
      fromFooter,
    );
  };

  return (
    <form id={id} onSubmit={submit}>
      <Note tone="info" title="Editing creates a new version">
        Days already recorded keep the definition that was in effect then, starting from the effective-from date.
      </Note>

      <Field label="Name" error={show('name')}>
        <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Day" autoFocus />
      </Field>

      <div className="grid-2col">
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
      </div>

      <FieldBlock label="Days of week" hint="The local day the shift starts on." error={show('days')}>
        <DaysPicker value={days} onChange={setDays} />
      </FieldBlock>

      <div className="grid-2col">
        <Field
          label="Effective from"
          hint={current ? `The current version started ${current.effective_from}.` : undefined}
          error={show('from')}
        >
          <Input type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        </Field>
        <Field label="Effective to" hint="Blank = no end date." error={show('to')}>
          <Input type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </Field>
      </div>

      {error != null && <ApiError error={error} title="Could not save this shift" />}

      {!hideActions && (
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={submitting}>
            {submitLabel ?? (initial ? 'Save shift' : 'Add shift')}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
