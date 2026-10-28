import { describe, expect, it } from 'vitest';
import {
  andAll,
  cmp,
  formatLiteral,
  formatTimestampLiteral,
  isLegacyVersion,
  quoteString,
} from '../src/odata/literals.js';
import { ODataClient, buildQueryString, extractNextLink, extractRows } from '../src/odata/client.js';
import { edmTypeOf, parseEdmx } from '../src/odata/metadata.js';

const TS = Date.parse('2025-01-01T00:00:00.000Z');

describe('$filter literals', () => {
  it('formats v4 timestamps as bare ISO 8601 without milliseconds', () => {
    expect(formatTimestampLiteral(TS, 'Edm.DateTimeOffset', '4.0')).toBe('2025-01-01T00:00:00Z');
    expect(formatTimestampLiteral(TS, null, null)).toBe('2025-01-01T00:00:00Z');
  });

  it('uses the v2 datetime dialect when the service says so', () => {
    expect(isLegacyVersion('2.0')).toBe(true);
    expect(isLegacyVersion('4.0')).toBe(false);
    expect(formatTimestampLiteral(TS, 'Edm.DateTime', '2.0')).toBe("datetime'2025-01-01T00:00:00'");
    expect(formatTimestampLiteral(TS, 'Edm.DateTimeOffset', '2.0')).toBe("datetimeoffset'2025-01-01T00:00:00Z'");
  });

  it('local_no_offset: writes Edm.DateTime filter values in plant wall-clock time', () => {
    const local = { mode: 'local_no_offset' as const, timezone: 'America/New_York' };
    expect(formatTimestampLiteral(TS, 'Edm.DateTime', '2.0', local)).toBe("datetime'2024-12-31T19:00:00'");
    // No $metadata type on a v2 service: the same naive datetime literal.
    expect(formatTimestampLiteral(TS, null, '2.0', local)).toBe("datetime'2024-12-31T19:00:00'");
    // Daylight saving: 2025-03-09 06:30Z is 01:30 EST, 07:30Z is 03:30 EDT; 2025-11-02 05:45Z and
    // 06:05Z are 01:45 EDT and 01:05 EST.
    expect(formatTimestampLiteral(Date.parse('2025-03-09T06:30:00Z'), 'Edm.DateTime', '2.0', local)).toBe("datetime'2025-03-09T01:30:00'");
    expect(formatTimestampLiteral(Date.parse('2025-03-09T07:30:00Z'), 'Edm.DateTime', '2.0', local)).toBe("datetime'2025-03-09T03:30:00'");
    expect(formatTimestampLiteral(Date.parse('2025-11-02T05:45:00Z'), 'Edm.DateTime', '2.0', local)).toBe("datetime'2025-11-02T01:45:00'");
    expect(formatTimestampLiteral(Date.parse('2025-11-02T06:05:00Z'), 'Edm.DateTime', '2.0', local)).toBe("datetime'2025-11-02T01:05:00'");
    // Literals with an explicit offset stay UTC.
    expect(formatTimestampLiteral(TS, 'Edm.DateTimeOffset', '2.0', local)).toBe("datetimeoffset'2025-01-01T00:00:00Z'");
    expect(formatTimestampLiteral(TS, 'Edm.DateTimeOffset', '4.0', local)).toBe('2025-01-01T00:00:00Z');
    expect(formatTimestampLiteral(TS, null, null, local)).toBe('2025-01-01T00:00:00Z');
  });

  it('utc and offset_present modes write the same literals as without a mode', () => {
    for (const mode of ['utc', 'offset_present'] as const) {
      const opts = { mode, timezone: 'America/New_York' };
      expect(formatTimestampLiteral(TS, 'Edm.DateTime', '2.0', opts)).toBe("datetime'2025-01-01T00:00:00'");
      expect(formatTimestampLiteral(TS, 'Edm.DateTimeOffset', '4.0', opts)).toBe('2025-01-01T00:00:00Z');
    }
  });

  it('formats Edm.Date as a plain calendar date', () => {
    expect(formatTimestampLiteral(TS, 'Edm.Date', '4.0')).toBe('2025-01-01');
  });

  it('quotes strings and doubles embedded apostrophes', () => {
    expect(quoteString("O'Brien")).toBe("'O''Brien'");
    expect(formatLiteral({ kind: 'string', value: 'J-100' }, 'Edm.String', '4.0')).toBe("'J-100'");
  });

  it('writes numbers bare (with v2 type suffixes)', () => {
    expect(formatLiteral({ kind: 'number', value: 42 }, 'Edm.Int32', '4.0')).toBe('42');
    expect(formatLiteral({ kind: 'number', value: 42 }, 'Edm.Int64', '2.0')).toBe('42L');
    expect(formatLiteral({ kind: 'boolean', value: true }, 'Edm.Boolean', '4.0')).toBe('true');
  });

  it('builds comparison and conjunction expressions', () => {
    expect(cmp('ModifiedDate', 'ge', '2025-01-01T00:00:00Z')).toBe('ModifiedDate ge 2025-01-01T00:00:00Z');
    expect(andAll(['a eq 1', null, 'b eq 2'])).toBe('(a eq 1) and (b eq 2)');
    expect(andAll([null, undefined])).toBeNull();
  });
});

describe('query building', () => {
  it('emits $filter, $orderby, $top, $skip and $select in order', () => {
    const qs = buildQueryString({
      filter: 'CompletedDate ge 2025-01-01T00:00:00Z',
      orderby: 'CompletedDate asc',
      top: 500,
      skip: 500,
      select: ['UnitSerial', 'WorkOrderNumber'],
    });
    expect(qs).toBe(
      '$filter=CompletedDate%20ge%202025-01-01T00%3A00%3A00Z&$orderby=CompletedDate%20asc&$top=500&$skip=500&$select=UnitSerial,WorkOrderNumber',
    );
  });

  it('omits empty options', () => {
    expect(buildQueryString({ top: 100 })).toBe('$top=100');
    expect(buildQueryString({})).toBe('');
  });

  it('joins the service root with the entity set', () => {
    const client = new ODataClient({ baseUrl: 'http://fl:6065/odata/', username: 'u', password: 'p', timeoutSeconds: 5 });
    expect(client.buildUrl('UnitProcessHistory', { top: 2 })).toBe('http://fl:6065/odata/UnitProcessHistory?$top=2');
    expect(client.resolveLink('UnitProcessHistory?$skiptoken=x')).toBe('http://fl:6065/odata/UnitProcessHistory?$skiptoken=x');
    expect(client.resolveLink('http://other/odata/X')).toBe('http://other/odata/X');
  });
});

describe('response shapes', () => {
  it('reads v4, v2 and v3 payloads', () => {
    expect(extractRows({ value: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractRows({ d: { results: [{ a: 2 }] } })).toEqual([{ a: 2 }]);
    expect(extractRows({ d: [{ a: 3 }] })).toEqual([{ a: 3 }]);
    expect(extractRows({ d: { a: 4 } })).toEqual([{ a: 4 }]);
    expect(extractRows({})).toEqual([]);
  });

  it('finds the next link in both dialects', () => {
    expect(extractNextLink({ '@odata.nextLink': 'X?$skiptoken=1' })).toBe('X?$skiptoken=1');
    expect(extractNextLink({ d: { __next: 'http://fl/odata/X?$skiptoken=2' } })).toBe('http://fl/odata/X?$skiptoken=2');
    expect(extractNextLink({ value: [] })).toBeNull();
  });
});

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="FactoryLogix" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="UnitProcessHistory">
        <Property Name="UnitSerial" Type="Edm.String" Nullable="false" />
        <Property Name="CompletedDate" Type="Edm.DateTimeOffset" Nullable="true" />
        <Property Name="OperationSequence" Type="Edm.Int32" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="UnitProcessHistory" EntityType="FactoryLogix.UnitProcessHistory" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('$metadata parsing', () => {
  it('extracts entity sets, fields and EDM types', () => {
    const metadata = parseEdmx(EDMX);
    expect(metadata.version).toBe('4.0');
    expect(metadata.entity_sets).toHaveLength(1);
    const set = metadata.entity_sets[0]!;
    expect(set.name).toBe('UnitProcessHistory');
    expect(set.fields.map((f) => f.name)).toEqual(['UnitSerial', 'CompletedDate', 'OperationSequence']);
    expect(set.fields[1]!.kind).toBe('timestamp');
    expect(set.fields[2]!.kind).toBe('number');
    expect(set.fields[0]!.nullable).toBe(false);
    expect(edmTypeOf(metadata, 'UnitProcessHistory', 'CompletedDate')).toBe('Edm.DateTimeOffset');
  });
});
