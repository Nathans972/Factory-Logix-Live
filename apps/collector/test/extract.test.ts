import { describe, expect, it } from 'vitest';
import { EXAMPLE_MAPPING, type DatasetMapping } from '@fld/shared';
import {
  TimestampResolver,
  buildNaturalKey,
  extractRecord,
  getField,
  selectFieldsFor,
  storableText,
  toBooleanValue,
  toNumberValue,
  toStringValue,
} from '../src/mapping/extract.js';

const utcResolver = () => new TimestampResolver({ mode: 'utc', timezone: 'America/New_York' });

describe('field extraction', () => {
  it('maps every target field and leaves unmapped/missing ones null', () => {
    const row = {
      UnitSerial: 'SN-1',
      WorkOrderNumber: 'J-100',
      PartNumber: 'Z-9',
      OperationName: 'Selective Solder - Top',
      OperationSequence: '30',
      OperatorName: 'jdoe',
      StartedDate: '2025-01-02T15:00:00Z',
      CompletedDate: '2025-01-02T15:06:00Z',
    };
    const rec = extractRecord('unit_steps', row, EXAMPLE_MAPPING.unit_steps, { timestamps: utcResolver() });

    expect(rec.values.unit_id).toBe('SN-1');
    expect(rec.values.job_number).toBe('J-100');
    expect(rec.values.product_number).toBe('Z-9');
    expect(rec.values.operation_seq).toBe(30);
    expect(rec.values.start_ts).toBe(Date.parse('2025-01-02T15:00:00Z'));
    expect(rec.values.complete_ts).toBe(Date.parse('2025-01-02T15:06:00Z'));
    // `result` is mapped but absent from the row, `rework_flag` / `modified_at` are not mapped at all.
    expect(rec.values.result).toBeNull();
    expect(rec.values.rework_flag).toBeNull();
    expect(rec.values.modified_at).toBeNull();
  });

  it('treats empty strings as null and parses numeric strings', () => {
    const row = { WorkOrderNumber: 'J-1', PartNumber: 'Z-1', QuantityReleased: '1,250', QuantityComplete: '', Status: '  Open  ' };
    const rec = extractRecord('work_orders', row, EXAMPLE_MAPPING.work_orders, { timestamps: utcResolver() });
    expect(rec.values.qty_released).toBe(1250);
    expect(rec.values.qty_complete).toBeNull();
    expect(rec.values.status).toBe('Open');
    expect(rec.values.product_name).toBeNull();
  });

  it('reads fields case-insensitively and through navigation paths', () => {
    expect(getField({ unitserial: 'x' }, 'UnitSerial')).toBe('x');
    expect(getField({ Operator: { Name: 'jdoe' } }, 'Operator/Name')).toBe('jdoe');
    expect(getField({ a: 1 }, 'missing')).toBeUndefined();
  });

  it('coerces booleans and numbers defensively', () => {
    expect(toBooleanValue('Y')).toBe(true);
    expect(toBooleanValue('no')).toBe(false);
    expect(toBooleanValue('maybe')).toBeNull();
    expect(toNumberValue('12.5')).toBe(12.5);
    expect(toNumberValue('abc')).toBeNull();
  });

  it('drops NUL and turns half of a surrogate pair into U+FFFD, which PostgreSQL can store', () => {
    expect(storableText('Bracket\u0000\u0000')).toBe('Bracket');
    expect(storableText('Scratch \ud83d')).toBe('Scratch \u{FFFD}');
    expect(storableText('\ude2c Scratch')).toBe('\u{FFFD} Scratch');
    expect(storableText('Scratch 😬')).toBe('Scratch 😬');
    expect(toStringValue(' Bracket \u0000')).toBe('Bracket');
    expect(toStringValue('\u0000\u0000')).toBeNull();
  });
});

describe('natural keys', () => {
  it('joins the mapped key fields with a pipe', () => {
    const row = { UnitSerial: 'SN-1', WorkOrderNumber: 'J-100', OperationName: 'AOI', StartedDate: '2025-01-02T15:00:00Z' };
    expect(buildNaturalKey(row, EXAMPLE_MAPPING.unit_steps.key)).toBe('SN-1|J-100|AOI|2025-01-02T15:00:00Z');
  });

  it('uses an empty segment for missing key values', () => {
    expect(buildNaturalKey({ A: 'x' }, ['A', 'B'])).toBe('x|');
  });

  it('keeps only text PostgreSQL can store', () => {
    expect(buildNaturalKey({ A: 'J-1 \u0000', B: 'Solder \ud83d' }, ['A', 'B'])).toBe('J-1|Solder \u{FFFD}');
  });

  it('collects select fields from mapped + key + watermark fields', () => {
    const mapping: DatasetMapping = {
      entity_set: 'Things',
      watermark_field: 'ModifiedDate',
      key: ['Id'],
      fields: { unit_id: 'Serial', job_number: null },
    };
    expect(selectFieldsFor(mapping).sort()).toEqual(['Id', 'ModifiedDate', 'Serial']);
  });
});
