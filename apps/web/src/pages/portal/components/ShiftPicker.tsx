/** Date + shift selector used by the shift view and the operator detail range picker (spec 9.2). */
import type { ShiftDef } from '@fld/shared';
import { Field, Input, Select } from '../../../ui';

export function ShiftPicker({
  date,
  shiftId,
  shifts,
  onChange,
  disabled,
}: {
  date: string;
  shiftId: number | null;
  shifts: ShiftDef[];
  onChange: (date: string, shiftId: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Field label="Date">
        <Input type="date" value={date} disabled={disabled} onChange={(e) => onChange(e.target.value, shiftId)} />
      </Field>
      <Field label="Shift">
        <Select
          value={shiftId == null ? '' : String(shiftId)}
          disabled={disabled}
          onChange={(e) => onChange(date, e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">(current)</option>
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.start_local}–{s.end_local})
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
