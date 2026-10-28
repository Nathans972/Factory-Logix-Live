/**
 * raw_events: keep every field FactoryLogix sent, including unmapped ones (spec 6.1).
 *
 * Re-reads (overlap, late-data re-pull, backfill) return rows we already stored, so a row is only
 * written when its (source, natural_key) is new or its payload changed. raw_event_hashes holds the
 * sha256 of the last stored payload per key; the upsert's RETURNING tells us which keys to write.
 */
import { createHash } from 'node:crypto';
import { bulkUpsert, chunk, q, type Queryable } from '../db.js';

export interface RawEvent {
  source: string;
  natural_key: string;
  payload: unknown;
}

export function payloadHash(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

export async function insertRawEvents(db: Queryable, events: RawEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  // Last one wins inside a batch, as bulkUpsert does: Postgres refuses to update one row twice.
  const latest = new Map<string, { source: string; natural_key: string; json: string; hash: string }>();
  for (const e of events) {
    const json = JSON.stringify(e.payload ?? null);
    latest.set(`${e.source} ${e.natural_key}`, { source: e.source, natural_key: e.natural_key, json, hash: payloadHash(json) });
  }
  const unique = [...latest.values()];

  const changed = new Set<string>();
  for (const batch of chunk(unique)) {
    const params: unknown[] = [];
    const tuples = batch.map((e) => {
      params.push(e.source, e.natural_key, e.hash);
      const n = params.length;
      return `($${n - 2}, $${n - 1}, $${n})`;
    });
    const rows = await q<{ source: string; natural_key: string }>(
      db,
      `INSERT INTO raw_event_hashes (source, natural_key, payload_hash) VALUES ${tuples.join(', ')}` +
        ' ON CONFLICT (source, natural_key) DO UPDATE SET payload_hash = EXCLUDED.payload_hash, updated_at = now()' +
        ' WHERE raw_event_hashes.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash' +
        ' RETURNING source, natural_key',
      params,
    );
    for (const row of rows) changed.add(`${row.source} ${row.natural_key}`);
  }

  const toStore = unique.filter((e) => changed.has(`${e.source} ${e.natural_key}`));
  if (toStore.length === 0) return 0;
  return bulkUpsert(db, {
    table: 'raw_events',
    columns: ['source', 'natural_key', 'payload'],
    conflict: [],
    rows: toStore.map((e) => [e.source, e.natural_key, e.json]),
  });
}
