import { EXAMPLE_MAPPING, type DatasetMapping } from '@fld/shared';
import { describe, expect, it } from 'vitest';
import {
  buildPreviewPath,
  computePreviewChecks,
  extractRows,
  joinUrl,
  parseEdmx,
  primaryTimestampField,
  selectedSourceFields,
} from '../src/odata.js';

const SAMPLE_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="FactoryLogix">
      <EntityType Name="WorkOrder">
        <Key><PropertyRef Name="WorkOrderNumber"/></Key>
        <Property Name="WorkOrderNumber" Type="Edm.String" Nullable="false"/>
        <Property Name="PartNumber" Type="Edm.String"/>
        <Property Name="QuantityReleased" Type="Edm.Int32" Nullable="false"/>
        <Property Name="ModifiedDate" Type="Edm.DateTimeOffset"/>
        <Property Name="IsClosed" Type="Edm.Boolean"/>
        <Property Name="Geo" Type="Edm.GeographyPoint"/>
      </EntityType>
      <EntityType Name="UnitProcessHistory">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
        <Property Name="UnitSerial" Type="Edm.String"/>
        <Property Name="StartedDate" Type="Edm.DateTimeOffset"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="WorkOrders" EntityType="FactoryLogix.WorkOrder"/>
        <EntitySet Name="UnitProcessHistory" EntityType="FactoryLogix.UnitProcessHistory"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const SINGLE_SET_EDMX = `<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="FL">
      <EntityType Name="Operator">
        <Property Name="UserName" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Ctx">
        <EntitySet Name="Operators" EntityType="FL.Operator"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('parseEdmx', () => {
  it('reads the version, entity sets and fields', () => {
    const meta = parseEdmx(SAMPLE_EDMX, 1_700_000_000_000);
    expect(meta.version).toBe('4.0');
    expect(meta.fetched_at).toBe(1_700_000_000_000);
    expect(meta.entity_sets.map((s) => s.name)).toEqual(['UnitProcessHistory', 'WorkOrders']);

    const wo = meta.entity_sets.find((s) => s.name === 'WorkOrders');
    expect(wo?.entity_type).toBe('FactoryLogix.WorkOrder');
    expect(wo?.fields.map((f) => f.name)).toEqual([
      'WorkOrderNumber',
      'PartNumber',
      'QuantityReleased',
      'ModifiedDate',
      'IsClosed',
      'Geo',
    ]);
  });

  it('classifies edm types and nullability', () => {
    const meta = parseEdmx(SAMPLE_EDMX);
    const fields = meta.entity_sets.find((s) => s.name === 'WorkOrders')!.fields;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.WorkOrderNumber.kind).toBe('string');
    expect(byName.WorkOrderNumber.nullable).toBe(false);
    expect(byName.PartNumber.nullable).toBe(true);
    expect(byName.QuantityReleased.kind).toBe('number');
    expect(byName.ModifiedDate.kind).toBe('timestamp');
    expect(byName.ModifiedDate.edm_type).toBe('Edm.DateTimeOffset');
    expect(byName.IsClosed.kind).toBe('boolean');
    expect(byName.Geo.kind).toBe('other');
  });

  it('handles a single entity set/type (non-array xml nodes) and older EDMX versions', () => {
    const meta = parseEdmx(SINGLE_SET_EDMX);
    expect(meta.version).toBe('1.0');
    expect(meta.entity_sets).toHaveLength(1);
    expect(meta.entity_sets[0].name).toBe('Operators');
    expect(meta.entity_sets[0].fields.map((f) => f.name)).toEqual(['UserName']);
  });

  it('returns an empty document rather than throwing on unrelated xml', () => {
    const meta = parseEdmx('<html><body>nope</body></html>');
    expect(meta.entity_sets).toEqual([]);
    expect(meta.version).toBeNull();
  });
});

describe('preview query building', () => {
  it('selects every mapped source field plus the key, and orders by the watermark', () => {
    const path = buildPreviewPath('unit_steps', EXAMPLE_MAPPING.unit_steps);
    expect(path).toBe(
      'UnitProcessHistory?$select=UnitSerial,WorkOrderNumber,PartNumber,OperationName,OperationSequence,OperatorName,StartedDate,CompletedDate,Result&$top=50&$orderby=CompletedDate desc',
    );
  });

  it('falls back to the primary timestamp when there is no watermark', () => {
    const mapping: DatasetMapping = { ...EXAMPLE_MAPPING.unit_steps, watermark_field: null };
    expect(primaryTimestampField('unit_steps', mapping)).toBe('CompletedDate');
    expect(buildPreviewPath('unit_steps', mapping)).toContain('$orderby=CompletedDate desc');
  });

  it('omits $orderby when nothing can be ordered on', () => {
    const mapping: DatasetMapping = {
      entity_set: 'Operators',
      watermark_field: null,
      key: ['UserName'],
      fields: { operator_id: 'UserName', display_name: 'FullName' },
    };
    const path = buildPreviewPath('operators', mapping);
    expect(path).toBe('Operators?$select=UserName,FullName&$top=50');
  });

  it('appends key fields that are not mapped targets, without duplicates', () => {
    const mapping: DatasetMapping = {
      entity_set: 'Defects',
      watermark_field: null,
      key: ['DefectId', 'UnitSerial'],
      fields: { unit_id: 'UnitSerial', job_number: 'WorkOrderNumber', found_ts: 'FoundDate' },
    };
    expect(selectedSourceFields(mapping)).toEqual(['UnitSerial', 'WorkOrderNumber', 'FoundDate', 'DefectId']);
  });

  it('joins base urls without doubling slashes', () => {
    expect(joinUrl('http://fl:6065/odata/', '$metadata')).toBe('http://fl:6065/odata/$metadata');
    expect(joinUrl('http://fl:6065/odata', '/WorkOrders')).toBe('http://fl:6065/odata/WorkOrders');
  });
});

describe('extractRows', () => {
  it('reads OData v4 payloads', () => {
    expect(extractRows('{"@odata.context":"x","value":[{"a":1}]}')).toEqual([{ a: 1 }]);
  });
  it('reads OData v3 payloads', () => {
    expect(extractRows('{"d":{"results":[{"a":1}]}}')).toEqual([{ a: 1 }]);
    expect(extractRows('{"d":[{"a":2}]}')).toEqual([{ a: 2 }]);
  });
  it('returns [] for an unexpected shape', () => {
    expect(extractRows('{"unexpected":true}')).toEqual([]);
  });
});

describe('computePreviewChecks', () => {
  const now = Date.parse('2024-05-01T12:00:00Z');
  const rows = [
    {
      UnitSerial: 'U1',
      WorkOrderNumber: 'J1',
      OperatorName: 'jdoe',
      StartedDate: '2024-05-01T11:00:00Z',
      CompletedDate: '2024-05-01T11:30:00Z',
    },
    {
      UnitSerial: 'U2',
      WorkOrderNumber: 'J2',
      OperatorName: 'asmith',
      StartedDate: '2024-05-01T11:10:00Z',
      CompletedDate: '2024-05-01T11:25:00Z',
    },
    {
      UnitSerial: 'U3',
      WorkOrderNumber: 'J1',
      OperatorName: 'jdoe',
      StartedDate: '2024-05-01T11:40:00Z',
      CompletedDate: null,
    },
  ];

  it('derives distinct counts, presence percentages, durations and skew', () => {
    const checks = computePreviewChecks('unit_steps', EXAMPLE_MAPPING.unit_steps, rows, now);
    expect(checks.distinct_operators).toBe(2);
    expect(checks.distinct_jobs).toBe(2);
    expect(checks.start_present_pct).toBe(100);
    expect(checks.complete_present_pct).toBeCloseTo(66.7, 1);
    expect(checks.sample_durations_minutes).toEqual([30, 15]);
    // newest CompletedDate is 11:30Z, "now" is 12:00Z
    expect(checks.timestamp_skew_minutes).toBe(30);
  });

  it('warns about an empty sample', () => {
    const checks = computePreviewChecks('unit_steps', EXAMPLE_MAPPING.unit_steps, [], now);
    expect(checks.warnings).toContain('the query returned no rows');
    expect(checks.distinct_jobs).toBe(0);
  });

  it('warns when a mapped field never appears in the payload', () => {
    const checks = computePreviewChecks('unit_steps', EXAMPLE_MAPPING.unit_steps, rows, now);
    expect(checks.warnings.some((w) => w.includes('operation -> OperationName'))).toBe(true);
  });

  it('warns about a large clock skew', () => {
    const checks = computePreviewChecks(
      'unit_steps',
      EXAMPLE_MAPPING.unit_steps,
      rows,
      Date.parse('2024-05-01T18:00:00Z'),
    );
    expect(checks.timestamp_skew_minutes).toBe(390);
    expect(checks.warnings.some((w) => w.includes('server clock'))).toBe(true);
  });

  it('leaves unit-step-only checks null for other datasets', () => {
    const checks = computePreviewChecks('work_orders', EXAMPLE_MAPPING.work_orders, [], now);
    expect(checks.distinct_operators).toBeNull();
    expect(checks.start_present_pct).toBeNull();
    expect(checks.complete_present_pct).toBeNull();
  });
});
