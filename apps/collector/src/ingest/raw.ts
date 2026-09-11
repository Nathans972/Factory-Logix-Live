/** raw_events: keep every field FactoryLogix sent, including unmapped ones (spec 6.1). */
import { bulkUpsert, type Queryable } from '../db.js';

export interface RawEvent {
  source: string;
  natural_key: string;
  payload: unknown;
}

export async function insertRawEvents(db: Queryable, events: RawEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  return bulkUpsert(db, {
    table: 'raw_events',
    columns: ['source', 'natural_key', 'payload'],
    conflict: [],
    rows: events.map((e) => [e.source, e.natural_key, JSON.stringify(e.payload ?? null)]),
  });
}
