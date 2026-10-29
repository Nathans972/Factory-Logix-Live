import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db.js';
import { insertRawEvents, payloadHash } from '../src/ingest/raw.js';

/** In-memory stand-in for raw_event_hashes + raw_events that understands the two statements. */
function fakeDb() {
  const hashes = new Map<string, string>();
  const rawEvents: { source: string; natural_key: string; payload: unknown }[] = [];
  const sql: string[] = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      sql.push(text);
      if (text.startsWith('INSERT INTO raw_event_hashes')) {
        expect(text).toContain('ON CONFLICT (source, natural_key) DO UPDATE SET payload_hash = EXCLUDED.payload_hash');
        expect(text).toContain('WHERE raw_event_hashes.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash');
        const rows: { source: string; natural_key: string }[] = [];
        for (let i = 0; i < params.length; i += 3) {
          const [source, key, hash] = params.slice(i, i + 3) as string[];
          const id = `${source}|${key}`;
          if (hashes.get(id) === hash) continue;
          hashes.set(id, hash as string);
          rows.push({ source: source as string, natural_key: key as string });
        }
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('INSERT INTO raw_events')) {
        for (let i = 0; i < params.length; i += 3) {
          const [source, key, payload] = params.slice(i, i + 3) as string[];
          rawEvents.push({ source: source as string, natural_key: key as string, payload: JSON.parse(payload as string) });
        }
        return { rows: [], rowCount: params.length / 3 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  } as unknown as Queryable;
  return { db, rawEvents, sql };
}

const page = [
  { source: 'unit_steps', natural_key: 'k1', payload: { Id: 1, Result: 'Pass' } },
  { source: 'unit_steps', natural_key: 'k2', payload: { Id: 2, Result: 'Pass' } },
];

describe('insertRawEvents', () => {
  it('stores one raw_events row per natural key when the same page is ingested twice', async () => {
    const { db, rawEvents } = fakeDb();
    expect(await insertRawEvents(db, page)).toBe(2);
    expect(await insertRawEvents(db, page)).toBe(0);
    expect(rawEvents.map((e) => e.natural_key)).toEqual(['k1', 'k2']);
  });

  it('stores a second row when a payload changes', async () => {
    const { db, rawEvents } = fakeDb();
    await insertRawEvents(db, page);
    await insertRawEvents(db, [{ source: 'unit_steps', natural_key: 'k1', payload: { Id: 1, Result: 'Fail' } }, page[1]!]);
    expect(rawEvents.filter((e) => e.natural_key === 'k1').map((e) => e.payload)).toEqual([
      { Id: 1, Result: 'Pass' },
      { Id: 1, Result: 'Fail' },
    ]);
    expect(rawEvents.filter((e) => e.natural_key === 'k2')).toHaveLength(1);
  });

  it('de-duplicates a batch by (source, natural_key), last one wins', async () => {
    const { db, rawEvents } = fakeDb();
    await insertRawEvents(db, [
      { source: 'defects', natural_key: 'd1', payload: { v: 1 } },
      { source: 'defects', natural_key: 'd1', payload: { v: 2 } },
      { source: 'unit_steps', natural_key: 'd1', payload: { v: 3 } },
    ]);
    expect(rawEvents).toEqual([
      { source: 'defects', natural_key: 'd1', payload: { v: 2 } },
      { source: 'unit_steps', natural_key: 'd1', payload: { v: 3 } },
    ]);
  });

  it('stores strings jsonb refuses (NUL, half of a surrogate pair) as storableText makes them', async () => {
    const { db, rawEvents } = fakeDb();
    await insertRawEvents(db, [{ source: 'defects', natural_key: 'd1', payload: { Id: 'd1', Name: 'Bracket\u0000', Notes: ['Scratch \ud83d'] } }]);
    expect(rawEvents.map((e) => e.payload)).toEqual([{ Id: 'd1', Name: 'Bracket', Notes: ['Scratch \u{FFFD}'] }]);
  });

  it('skips the raw_events insert when nothing changed, and does nothing for an empty batch', async () => {
    const { db, sql } = fakeDb();
    await insertRawEvents(db, page);
    sql.length = 0;
    await insertRawEvents(db, page);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^INSERT INTO raw_event_hashes/);
    sql.length = 0;
    expect(await insertRawEvents(db, [])).toBe(0);
    expect(sql).toHaveLength(0);
  });

  it('hashes the payload JSON with sha256', () => {
    expect(payloadHash('null')).toBe('74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b');
  });
});
