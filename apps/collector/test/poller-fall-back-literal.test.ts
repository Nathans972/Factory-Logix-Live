import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataSource } from '../src/sources/ODataSource.js';
import { Poller } from '../src/sync/poller.js';

/**
 * FactoryLogix in `local_no_offset` mode behind an OData v2 service: ModifiedDate is an
 * Edm.DateTime holding plant wall-clock time (SQL Server `datetime`), so `$filter` compares naive
 * wall-clock values and the JSON carries `/Date(<wall clock as if UTC>)/`.
 */
const TZ = 'America/New_York';
const BASE = 'http://fl:6065/odata';

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices m:DataServiceVersion="2.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="FL" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="WorkOrder">
        <Key><PropertyRef Name="WorkOrderNumber"/></Key>
        <Property Name="WorkOrderNumber" Type="Edm.String" Nullable="false"/>
        <Property Name="PartNumber" Type="Edm.String"/>
        <Property Name="QuantityReleased" Type="Edm.Int32"/>
        <Property Name="ModifiedDate" Type="Edm.DateTime"/>
      </EntityType>
      <EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
        <EntitySet Name="WorkOrders" EntityType="FL.WorkOrder"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

interface FlRow {
  WorkOrderNumber: string;
  PartNumber: string;
  QuantityReleased: number;
  /** Plant wall clock, `YYYY-MM-DDTHH:MM:SS`, as FactoryLogix stores it. */
  ModifiedDate: string;
  /** The real instant the change happened; the row only exists from then on. */
  at: number;
}

function flServer(table: FlRow[], clock: { now: number }) {
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.endsWith('/$metadata')) return new Response(EDMX, { status: 200, headers: { 'content-type': 'application/xml' } });
    const u = new URL(url);
    let rows = table.filter((r) => r.at <= clock.now);
    const filter = u.searchParams.get('$filter') ?? '';
    const m = /^ModifiedDate ge datetime'([0-9T:-]+)'$/.exec(filter);
    if (!m) throw new Error(`unexpected filter ${filter}`);
    rows = rows.filter((r) => r.ModifiedDate >= (m[1] as string)).sort((a, b) => a.ModifiedDate.localeCompare(b.ModifiedDate));
    const skip = Number(u.searchParams.get('$skip') ?? '0');
    const top = Number(u.searchParams.get('$top') ?? String(rows.length));
    const results = rows.slice(skip, skip + top).map((r) => ({
      WorkOrderNumber: r.WorkOrderNumber,
      PartNumber: r.PartNumber,
      QuantityReleased: r.QuantityReleased,
      ModifiedDate: `/Date(${Date.parse(`${r.ModifiedDate}Z`)})/`,
    }));
    return new Response(JSON.stringify({ d: { results } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new ODataSource({ baseUrl: BASE, username: 'u', password: 'p', timeoutSeconds: 5, fetchImpl });
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** sync_state / sync_log in memory. */
function fakePool() {
  const state = new Map<string, string | null>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const source = params[0] as string;
        if (!state.has(source)) return { rows: [], rowCount: 0 };
        const row = {
          source,
          watermark: state.get(source) ?? null,
          last_success_at: null,
          last_error: null,
          consecutive_failures: 0,
          rows_last_poll: null,
          duration_ms_last_poll: null,
          backfill_progress: null,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark')) {
        const [source, watermark] = params as [string, string | null];
        state.set(source, watermark ?? state.get(source) ?? null);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, state };
}

function recordingIngestor() {
  const seen: Record<string, Record<string, unknown>[]> = {};
  const ingestor = {
    ingest: async (dataset: DatasetName, rows: Record<string, unknown>[]) => {
      (seen[dataset] ??= []).push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, seen };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: TZ, fl_timestamp_mode: 'local_no_offset' };

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', qty_released: 'QuantityReleased', modified_at: 'ModifiedDate' },
  },
  unit_steps: null,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

describe('local_no_offset filter literals on the fall-back night (2026-11-01, America/New_York)', () => {
  it('a job released during the repeated 01:00-02:00 hour still reaches the database', async () => {
    // 01:00 EDT = 05:00Z ... 01:59 EDT = 05:59Z, then the clock goes back: 01:00 EST = 06:00Z.
    const table: FlRow[] = [
      { WorkOrderNumber: 'J-A', PartNumber: 'Z-1', QuantityReleased: 10, ModifiedDate: '2026-11-01T01:50:00', at: Date.parse('2026-11-01T05:50:00Z') },
      // Released at 01:20 EST, the second 01:20 of the night.
      { WorkOrderNumber: 'J-B', PartNumber: 'Z-2', QuantityReleased: 40, ModifiedDate: '2026-11-01T01:20:00', at: Date.parse('2026-11-01T06:20:00Z') },
      { WorkOrderNumber: 'J-C', PartNumber: 'Z-3', QuantityReleased: 25, ModifiedDate: '2026-11-01T02:10:00', at: Date.parse('2026-11-01T07:10:00Z') },
    ];
    const clock = { now: Date.parse('2026-11-01T05:30:00Z') };
    const source = flServer(table, clock);
    source.setTimestampMode('local_no_offset', TZ);
    await source.init(true);
    expect(source.version()).toBe('2.0');

    const db = fakePool();
    db.state.set('work_orders', '2026-11-01T05:25:00.000Z');
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'local_no_offset', timezone: TZ });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);

    // Poll every 90 s through the night until 06:00 EST (11:00Z).
    for (; clock.now < Date.parse('2026-11-01T11:00:00Z'); clock.now += 90_000) {
      const outcome = await poller.pollOnce(mapping, settings, clock.now);
      expect(outcome.ok).toBe(true);
    }

    const jobs = new Set((seen.work_orders ?? []).map((r) => r.WorkOrderNumber));
    expect(jobs.has('J-A')).toBe(true);
    expect(jobs.has('J-C')).toBe(true);
    // Until J-C the watermark stays at 01:50 EDT (05:50Z), so every poll asks for
    // ModifiedDate ge datetime'2026-11-01T01:40:00'; J-B's wall clock 01:20 is below that, and
    // after J-C the polls ask for >= 02:00. work_orders has no late-data re-pull.
    expect(jobs.has('J-B')).toBe(true);
  });
});
