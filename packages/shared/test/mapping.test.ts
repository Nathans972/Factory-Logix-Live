import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_MAPPING,
  edmTypeToKind,
  nextMappingKeyHistory,
  parseMappingKeyHistory,
  withPreviousKeys,
  type MappingConfig,
} from '../src/mapping.js';

/** EXAMPLE_MAPPING with the given natural keys on unit_steps and defects (null = dataset not used). */
function mappingWith(steps: string[], defects: string[] | null): MappingConfig {
  return {
    ...EXAMPLE_MAPPING,
    unit_steps: { ...EXAMPLE_MAPPING.unit_steps, key: steps },
    defects: defects === null ? null : { ...EXAMPLE_MAPPING.defects!, key: defects },
  };
}

describe('parseMappingKeyHistory', () => {
  it.each([undefined, null, 'unit_steps', 42, true])('reads %s as no history', (value) => {
    expect(parseMappingKeyHistory(value)).toEqual({});
  });

  it('keeps the well-formed keys of the datasets stored by natural key', () => {
    expect(
      parseMappingKeyHistory({
        unit_steps: [['UnitHistoryId'], ['UnitSerial', 'StartedDate']],
        defects: [['DefectId']],
      }),
    ).toEqual({
      unit_steps: [['UnitHistoryId'], ['UnitSerial', 'StartedDate']],
      defects: [['DefectId']],
    });
  });

  it('drops malformed keys and leaves out a dataset with none left', () => {
    expect(
      parseMappingKeyHistory({
        unit_steps: [[], ['UnitSerial', ''], ['UnitSerial', 3], 'UnitSerial', null, ['UnitHistoryId']],
        defects: [[]],
      }),
    ).toEqual({ unit_steps: [['UnitHistoryId']] });
  });

  it('ignores datasets that are not stored by natural key', () => {
    expect(parseMappingKeyHistory({ work_orders: [['WorkOrderNumber']], operators: [['Name']] })).toEqual({});
  });

  it('ignores a dataset whose value is not a list', () => {
    expect(parseMappingKeyHistory({ unit_steps: { 0: ['UnitHistoryId'] }, defects: 'DefectId' })).toEqual({});
  });
});

describe('nextMappingKeyHistory', () => {
  it('records nothing for the first mapping saved', () => {
    expect(nextMappingKeyHistory({}, null, mappingWith(['A'], ['D']))).toEqual({});
  });

  it('records nothing when the keys do not change', () => {
    expect(nextMappingKeyHistory({}, mappingWith(['A', 'B'], ['D']), mappingWith(['A', 'B'], ['D']))).toEqual({});
  });

  it('records the old key when the key changes', () => {
    expect(nextMappingKeyHistory({}, mappingWith(['A'], ['D']), mappingWith(['B'], ['D']))).toEqual({ unit_steps: [['A']] });
  });

  it('treats a reordered key as a different key', () => {
    expect(nextMappingKeyHistory({}, mappingWith(['A', 'B'], ['D']), mappingWith(['B', 'A'], ['D']))).toEqual({
      unit_steps: [['A', 'B']],
    });
  });

  it('records the old key when the dataset stops being used', () => {
    expect(nextMappingKeyHistory({}, mappingWith(['A'], ['D']), mappingWith(['A'], null))).toEqual({ defects: [['D']] });
  });

  it('appends to the existing history, oldest first', () => {
    const history = { unit_steps: [['A']] };
    expect(nextMappingKeyHistory(history, mappingWith(['B'], ['D']), mappingWith(['C'], ['D']))).toEqual({
      unit_steps: [['A'], ['B']],
    });
  });

  it('removes a key from the history when the mapping goes back to it', () => {
    const history = { unit_steps: [['A']] };
    expect(nextMappingKeyHistory(history, mappingWith(['B'], ['D']), mappingWith(['A'], ['D']))).toEqual({
      unit_steps: [['B']],
    });
  });

  it('lists a key once even when it was used more than once', () => {
    const history = { unit_steps: [['A'], ['B']] };
    expect(nextMappingKeyHistory(history, mappingWith(['A'], ['D']), mappingWith(['C'], ['D']))).toEqual({
      unit_steps: [['A'], ['B']],
    });
  });

  it('keeps the history of a dataset the save does not touch', () => {
    const history = { defects: [['OldDefectKey']] };
    expect(nextMappingKeyHistory(history, mappingWith(['A'], ['D']), mappingWith(['A'], ['D']))).toEqual(history);
  });

  it('ignores a malformed key in a stored mapping that predates the schema', () => {
    const prev = { ...mappingWith(['A'], ['D']), unit_steps: { ...EXAMPLE_MAPPING.unit_steps, key: 'A' } } as unknown as MappingConfig;
    expect(nextMappingKeyHistory({}, prev, mappingWith(['B'], ['D']))).toEqual({});
  });

  it('does not modify the history it is given', () => {
    const history = { unit_steps: [['A']] };
    nextMappingKeyHistory(history, mappingWith(['B'], ['D']), mappingWith(['C'], ['D']));
    expect(history).toEqual({ unit_steps: [['A']] });
  });
});

describe('withPreviousKeys', () => {
  it('adds the history to the datasets stored by natural key', () => {
    const out = withPreviousKeys(mappingWith(['C'], ['D']), { unit_steps: [['A'], ['B']], defects: [['OldDefectKey']] });
    expect(out.unit_steps.previous_keys).toEqual([['A'], ['B']]);
    expect(out.defects?.previous_keys).toEqual([['OldDefectKey']]);
    expect(out.unit_steps.key).toEqual(['C']);
  });

  it('leaves a dataset without history and a dataset not in use as they are', () => {
    const out = withPreviousKeys(mappingWith(['C'], null), { defects: [['D']] });
    expect(out.unit_steps).not.toHaveProperty('previous_keys');
    expect(out.defects).toBeNull();
  });

  it('does not modify the mapping it is given', () => {
    const mapping = mappingWith(['C'], ['D']);
    withPreviousKeys(mapping, { unit_steps: [['A']] });
    expect(mapping.unit_steps).not.toHaveProperty('previous_keys');
  });
});

describe('edmTypeToKind', () => {
  it.each([
    ['Edm.String', 'string'],
    ['Edm.Guid', 'string'],
    ['Edm.DateTimeOffset', 'timestamp'],
    ['Edm.DateTime', 'timestamp'],
    ['Edm.Date', 'timestamp'],
    ['Edm.Boolean', 'boolean'],
    ['Edm.Int16', 'number'],
    ['Edm.Int32', 'number'],
    ['Edm.Int64', 'number'],
    ['Edm.Decimal', 'number'],
    ['Edm.Double', 'number'],
    ['Edm.Single', 'number'],
    ['Edm.Byte', 'number'],
    ['Edm.SByte', 'number'],
    ['Int32', 'number'],
    ['DateTimeOffset', 'timestamp'],
    ['Edm.TimeOfDay', 'other'],
    ['Edm.Binary', 'other'],
    ['Collection(Edm.String)', 'other'],
    ['FactoryLogix.Address', 'other'],
    ['', 'other'],
  ] as const)('classifies %s as %s', (edm, kind) => {
    expect(edmTypeToKind(edm)).toBe(kind);
  });
});
