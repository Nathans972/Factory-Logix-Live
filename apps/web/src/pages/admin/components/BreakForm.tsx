/** Break add/edit form (spec 10.3). Validation mirrors `breakWriteSchema`. */
import { useMemo, useState, type FormEvent } from 'react';
import type { BreakDef, BreakWrite, ShiftDef } from '@fld/shared';
import { Button, Checkbox, DaysPicker, Field, Input, Select } from '../../../ui';
import { formatIsoDate } from '../../../lib/format';
import { usePlantTz } from '../../../lib/usePlantTz';
import { ApiError, FieldBlock } from './common';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function BreakForm({
  initial,
  shifts,
  onSubmit,
  onCancel,
  submitting,
  error,
  submitLabel,
}: {
  initial?: BreakDef | null;
  shifts: ShiftDef[];
  onSubmit: (v: BreakWrite) => void;
  onCancel?: () => void;
  submitting?: boolean;
  error?: unknown;
  submitLabel?: string;
}) {
  const tz = usePlantTz();
  const today = useMemo(() => formatIsoDate(Date.now(), tz), [tz]);

  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(initial?.start_local ?? '14:00');
  const [duration, setDuration] = useState(String(initial?.duration_minutes ?? 15));
  const [days, setDays] = useState<number[]>(initial?.days_of_week ?? [1, 2, 3, 4, 5]);
  const [appliesToAll, setAppliesToAll] = useState(initial ? initial.shift_ids == null : true);
  const [shiftIds, setShiftIds] = useState<number[]>(initial?.shift_ids ?? []);
  const [from, setFrom] = useState(initial?.effective_from ?? today);
  const [to, setTo] = useState(initial?.effective_to ?? '');
  const [touched, setTouched] = useState(false);

  const durationNum = Number(duration);
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Required';
  else if (name.trim().length > 80) errors.name = 'Maximum 80 characters';
  if (!TIME_RE.test(start)) errors.start = 'Expected HH:MM';
  if (!duration.trim() || !Number.isFinite(durationNum) || !Number.isInteger(durationNum))
    errors.duration = 'Whole number of minutes';
  else if (durationNum < 1 || durationNum > 480) errors.duration = 'Between 1 and 480 minutes';
  if (days.length === 0) errors.days = 'Pick at least one day';
  if (!appliesToAll && shiftIds.length === 0) errors.shifts = 'Pick at least one shift';
  if (!DATE_RE.test(from)) errors.from = 'Expected YYYY-MM-DD';
  if (to && !DATE_RE.test(to)) errors.to = 'Expected YYYY-MM-DD';
  if (to && DATE_RE.test(to) && DATE_RE.test(from) && to < from) errors.to = 'Must not be before the effective-from date';
  const valid = Object.keys(errors).length === 0;
  const show = (k: string) => (touched ? errors[k] : undefined);

  const toggleShift = (id: number) =>
    setShiftIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].sort((a, b) => a - b)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      start_local: start,
      duration_minutes: durationNum,
      days_of_week: [...days].sort((a, b) => a - b),
      shift_ids: appliesToAll ? null : [...shiftIds],
      effective_from: from,
      effective_to: to ? to : null,
    });
  };

  return (
    <form onSubmit={submit}>
      <p className="hint-line">
        A break removes its minutes from the charged time of every operator whose work window overlaps it.
      </p>

      <div className="form-grid">
        <div className="field-wide">
          <Field label="Name" error={show('name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Afternoon break"
              autoFocus
            />
          </Field>
        </div>
        <Field label="Start (plant local)" error={show('start')}>
          <Input type="time" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
        </Field>
        <Field label="Duration (minutes)" error={show('duration')}>
          <Input
            type="number"
            min={1}
            max={480}
            step={1}
            value={duration}
            onChange={(e) => setDuration(e.currentTarget.value)}
          />
        </Field>
        <FieldBlock label="Days of week" wide error={show('days')}>
          <DaysPicker value={days} onChange={setDays} />
        </FieldBlock>

        <Field label="Applies to">
          <Select value={appliesToAll ? 'all' : 'some'} onChange={(e) => setAppliesToAll(e.currentTarget.value === 'all')}>
            <option value="all">All shifts</option>
            <option value="some">Selected shifts</option>
          </Select>
        </Field>
        {!appliesToAll && (
          <FieldBlock label="Shifts" wide error={show('shifts')}>
            <div className="picker-list">
              {shifts.length === 0 && <div className="opt muted">No shifts defined yet.</div>}
              {shifts.map((s) => (
                <div className="opt" key={s.id}>
                  <Checkbox
                    label={`${s.name} · ${s.start_local}–${s.end_local}`}
                    checked={shiftIds.includes(s.id)}
                    onChange={() => toggleShift(s.id)}
                  />
                </div>
              ))}
            </div>
          </FieldBlock>
        )}

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
          {submitLabel ?? (initial ? 'Save break' : 'Add break')}
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
