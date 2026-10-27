import { describe, expect, it } from 'vitest';
import { toCsv, type CsvColumn } from './csv';

interface Row {
  name: string | null;
  qty: number | null | undefined;
}

const columns: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Qty', value: (r) => r.qty },
];

describe('toCsv', () => {
  it('writes a header row and one CRLF-separated line per row', () => {
    const csv = toCsv(columns, [
      { name: 'Board A', qty: 12 },
      { name: 'Board B', qty: 0 },
    ]);
    expect(csv).toBe('Name,Qty\r\nBoard A,12\r\nBoard B,0');
  });

  it('writes only the header when there are no rows', () => {
    expect(toCsv(columns, [])).toBe('Name,Qty');
  });

  it('leaves null and undefined cells empty but keeps zero', () => {
    expect(toCsv(columns, [{ name: null, qty: undefined }, { name: 'X', qty: 0 }])).toBe('Name,Qty\r\n,\r\nX,0');
  });

  it('quotes cells containing commas, quotes or line breaks and doubles embedded quotes', () => {
    const csv = toCsv(columns, [
      { name: 'Smith, J.', qty: 1 },
      { name: 'The "big" one', qty: 2 },
      { name: 'line1\nline2', qty: 3 },
      { name: 'cr\rhere', qty: 4 },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'Name,Qty',
      '"Smith, J.",1',
      '"The ""big"" one",2',
      '"line1\nline2",3',
      '"cr\rhere",4',
    ]);
  });

  it('escapes headers the same way as cells', () => {
    const cols: CsvColumn<Row>[] = [{ header: 'Qty, good', value: (r) => r.qty }];
    expect(toCsv(cols, [{ name: null, qty: 5 }])).toBe('"Qty, good"\r\n5');
  });
});
